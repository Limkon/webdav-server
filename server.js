require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Busboy = require('busboy');
const path = require('path');
const axios = require('axios');
const archiver = require('archiver');
const bcrypt = require('bcrypt');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const db = require('./database.js');
const data = require('./data.js');
const storageManager = require('./storage');

const app = express();

const TMP_DIR = path.join(__dirname, 'data', 'tmp');

async function cleanupTempDir() {
    try {
        if (!fs.existsSync(TMP_DIR)) {
            await fsp.mkdir(TMP_DIR, { recursive: true });
            return;
        }
        const files = await fsp.readdir(TMP_DIR);
        for (const file of files) {
            try {
                await fsp.unlink(path.join(TMP_DIR, file));
            } catch (err) {}
        }
    } catch (error) {}
}
cleanupTempDir();

const PORT = process.env.PORT || 8100;

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-strong-random-secret-here-please-change',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- 中介软体 ---
function requireLogin(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
    if (req.session.loggedIn && req.session.isAdmin) {
        return next();
    }
    res.status(403).send('权限不足');
}

// --- 路由 ---
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views/register.html')));
app.get('/editor', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/editor.html')));

app.post('/login', async (req, res) => {
    try {
        const user = await data.findUserByName(req.body.username);
        if (user && await bcrypt.compare(req.body.password, user.password)) {
            req.session.loggedIn = true;
            req.session.userId = user.id;
            req.session.isAdmin = !!user.is_admin;
            res.redirect('/');
        } else {
            res.status(401).send('帐号或密码错误');
        }
    } catch(error) {
        res.status(500).send('登入时发生错误');
    }
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send('请提供使用者名称和密码');
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = await data.createUser(username, hashedPassword);
        
        // 建立使用者根目录
        const root = await data.createFolder('/', null, newUser.id);

        // 为新使用者建立所有已存在的挂载点资料夹
        const config = storageManager.readConfig();
        for(const mount of config.webdav) {
            await data.createFolder(mount.name, root.id, newUser.id);
        }
        
        res.redirect('/login');
    } catch (error) {
        res.status(500).send('注册失败，使用者名称可能已被使用。');
    }
});


app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.redirect('/');
        }
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.get('/', requireLogin, async (req, res) => {
    try {
        const rootFolder = await data.getRootFolder(req.session.userId);
        if (rootFolder) {
            res.redirect(`/folder/${rootFolder.id}`);
        } else {
            const newRoot = await data.createFolder('/', null, req.session.userId);
            res.redirect(`/folder/${newRoot.id}`);
        }
    } catch (error) {
        res.status(500).send("找不到您的根目录，也无法建立。");
    }
});

app.get('/folder/:id', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/manager.html')));
app.get('/shares-page', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/shares.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin.html')));
app.get('/scan', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/scan.html')));

app.post('/upload', requireLogin, (req, res) => {
    const userId = req.session.userId;
    const storage = storageManager.getStorage();
    const busboy = Busboy({ 
        headers: req.headers,
        defParamCharset: 'utf8'
    });

    const fields = {};
    const fileBuffers = [];
    const processingPromises = [];

    busboy.on('field', (fieldname, val) => {
        fields[fieldname] = val;
    });

    busboy.on('file', (fieldname, fileStream, fileInfo) => {
        let { filename } = fileInfo;
        filename = Buffer.from(filename, 'latin1').toString('utf8');
        const chunks = [];
        const filePromise = new Promise((resolve, reject) => {
            fileStream.on('data', (chunk) => chunks.push(chunk));
            fileStream.on('end', () => {
                const buffer = Buffer.concat(chunks);
                fileBuffers.push({ buffer, filename, mimeType: fileInfo.mimeType });
                resolve();
            });
            fileStream.on('error', reject);
        });
        processingPromises.push(filePromise);
    });

    busboy.on('finish', async () => {
        await Promise.all(processingPromises);

        try {
            const initialFolderId = parseInt(fields.folderId, 10);
            const resolutions = JSON.parse(fields.resolutions || '{}');
            const relativePaths = JSON.parse(fields.relativePathsJSON || '[]');
            const caption = fields.caption || '';
            let allSkipped = true;

            const rootFolder = await data.getRootFolder(userId);
            if (initialFolderId === rootFolder.id) {
                return res.status(400).json({ success: false, message: '无法直接上传到根目录，请先进入一个挂载点。' });
            }
            
            if (fileBuffers.length !== relativePaths.length) {
                throw new Error(`文件数量 (${fileBuffers.length}) 与路径数量 (${relativePaths.length}) 不匹配。`);
            }

            for (let i = 0; i < fileBuffers.length; i++) {
                const fileData = fileBuffers[i];
                const relativePath = relativePaths[i];
                const { buffer, mimeType } = fileData;
                const decodedFilename = relativePath;
                const action = resolutions[decodedFilename] || 'upload';

                if (action === 'skip') continue;

                const pathParts = decodedFilename.split('/').filter(p => p);
                let finalFilename = pathParts.pop() || decodedFilename;
                const folderPathParts = pathParts;

                const targetFolderId = await data.resolvePathToFolderId(initialFolderId, folderPathParts, userId);

                if (action === 'overwrite') {
                    const existingItem = await data.findItemInFolder(finalFilename, targetFolderId, userId);
                    if (existingItem) {
                        await data.unifiedDelete(existingItem.id, existingItem.type, userId);
                    }
                } else if (action === 'rename') {
                    finalFilename = await data.findAvailableName(finalFilename, targetFolderId, userId, false);
                } else {
                     const conflict = await data.findItemInFolder(finalFilename, targetFolderId, userId);
                     if (conflict) continue;
                }
                
                allSkipped = false;
                
                const stream = require('stream');
                const readableStream = new stream.PassThrough();
                readableStream.end(buffer);

                await storage.upload(readableStream, finalFilename, mimeType, userId, targetFolderId, caption);
            }

            res.json({ success: true, message: '上传完成', skippedAll: allSkipped });

        } catch (err) {
            res.status(500).json({ success: false, message: err.message || '处理上传文件时发生内部错误。' });
        }
    });

    busboy.on('error', (err) => {
        req.unpipe(busboy);
        res.status(500).json({ success: false, message: '上传解析失败' });
    });

    req.pipe(busboy);
});

// --- API 端点 ---
app.get('/api/initial-data', requireLogin, async (req, res) => {
    try {
        const rootFolder = await data.getRootFolder(req.session.userId);
        res.json({ rootId: rootFolder.id });
    } catch (e) {
        res.status(500).json({ success: false, message: '无法获取初始资料' });
    }
});

app.get('/api/mounts', requireLogin, async (req, res) => {
    const config = storageManager.readConfig();
    const mounts = config.webdav.map(c => ({
        id: -1, // Special ID for mount points
        name: c.name,
        type: 'folder'
    }));
    
    // 为了面包屑导航，创建一个虚拟的根路径
    const rootPath = [{ id: (await data.getRootFolder(req.session.userId)).id, name: '/' }];

    res.json({ mounts, path: rootPath });
});

app.get('/api/folder-path/:id', requireLogin, async (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        const path = await data.getFolderPath(folderId, req.session.userId);
        res.json(path);
    } catch(e) {
        res.status(500).json({ success: false, message: '获取路径失败' });
    }
});


app.post('/api/text-file', requireLogin, async (req, res) => {
    const { mode, fileId, folderId, fileName, content } = req.body;
    const userId = req.session.userId;
    const storage = storageManager.getStorage();
    
    const rootFolder = await data.getRootFolder(userId);
    if (folderId && parseInt(folderId, 10) === rootFolder.id) {
         return res.status(400).json({ success: false, message: '无法在根目录建立档案。' });
    }

    if (!fileName || !fileName.endsWith('.txt')) {
        return res.status(400).json({ success: false, message: '档名无效或不是 .txt 档案' });
    }

    const tempFilePath = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.txt`);

    try {
        await fsp.writeFile(tempFilePath, content, 'utf8');
        const fileStream = fs.createReadStream(tempFilePath);
        let result;

        if (mode === 'edit' && fileId) {
            const filesToUpdate = await data.getFilesByIds([fileId], userId);
            if (filesToUpdate.length > 0) {
                const originalFile = filesToUpdate[0];
                
                if (fileName !== originalFile.fileName) {
                    const conflict = await data.checkFullConflict(fileName, originalFile.folder_id, userId);
                    if (conflict) {
                        return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
                    }
                }
                
                await data.unifiedDelete(originalFile.message_id, 'file', userId);
                result = await storage.upload(fileStream, fileName, 'text/plain', userId, originalFile.folder_id);
            } else {
                return res.status(404).json({ success: false, message: '找不到要编辑的原始档案' });
            }
        } else if (mode === 'create' && folderId) {
             const conflict = await data.checkFullConflict(fileName, folderId, userId);
            if (conflict) {
                return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夾。' });
            }
            result = await storage.upload(fileStream, fileName, 'text/plain', userId, folderId);
        } else {
            return res.status(400).json({ success: false, message: '请求参数无效' });
        }
        res.json({ success: true, fileId: result.fileId });
    } catch (error) {
        res.status(500).json({ success: false, message: '伺服器内部错误: ' + error.message });
    } finally {
        if (fs.existsSync(tempFilePath)) {
            await fsp.unlink(tempFilePath).catch(err => {});
        }
    }
});
app.get('/api/file-info/:id', requireLogin, async (req, res) => {
    try {
        const fileId = parseInt(req.params.id, 10);
        const [fileInfo] = await data.getFilesByIds([fileId], req.session.userId);
        if (fileInfo) {
            res.json(fileInfo);
        } else {
            res.status(404).json({ success: false, message: '找不到档案资讯' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '获取档案资讯失败' });
    }
});

app.post('/api/check-existence', requireLogin, async (req, res) => {
    try {
        const { files: filesToCheck, folderId: initialFolderId } = req.body;
        const userId = req.session.userId;

        if (!filesToCheck || !Array.isArray(filesToCheck) || !initialFolderId) {
            return res.status(400).json({ success: false, message: '无效的请求参数。' });
        }

        const existenceChecks = await Promise.all(
            filesToCheck.map(async (fileInfo) => {
                const { relativePath } = fileInfo;
                const pathParts = (relativePath || '').split('/');
                const fileName = pathParts.pop() || relativePath;
                const folderPathParts = pathParts;

                const targetFolderId = await data.findFolderByPath(initialFolderId, folderPathParts, userId);
                
                if (targetFolderId === null) {
                    return { name: fileName, relativePath, exists: false, messageId: null };
                }

                const existingFile = await data.findFileInFolder(fileName, targetFolderId, userId);
                return { name: fileName, relativePath, exists: !!existingFile, messageId: existingFile ? existingFile.message_id : null };
            })
        );
        res.json({ success: true, files: existenceChecks });
    } catch (error) {
        res.status(500).json({ success: false, message: "检查档案是否存在时发生内部错误。" });
    }
});

app.post('/api/check-move-conflict', requireLogin, async (req, res) => {
    try {
        const { itemIds, targetFolderId } = req.body;
        const userId = req.session.userId;

        if (!itemIds || !Array.isArray(itemIds) || !targetFolderId) {
            return res.status(400).json({ success: false, message: '无效的请求参数。' });
        }
        
        const topLevelItems = await data.getItemsByIds(itemIds, userId);
        const { fileConflicts, folderConflicts } = await data.getConflictingItems(topLevelItems, targetFolderId, userId);

        res.json({
            success: true,
            fileConflicts,
            folderConflicts
        });

    } catch (error) {
        res.status(500).json({ success: false, message: '检查名称冲突时出错: ' + error.message });
    }
});


app.get('/api/search', requireLogin, async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ success: false, message: '需要提供搜寻关键字。' });
        
        const contents = await data.searchItems(query, req.session.userId);
        
        const path = [{ id: null, name: `搜寻结果: "${query}"` }];
        res.json({ contents, path });
    } catch (error) {
        res.status(500).json({ success: false, message: '搜寻失败。' });
    }
});

app.get('/api/folder/:id', requireLogin, async (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        const rootFolder = await data.getRootFolder(req.session.userId);

        if (folderId === rootFolder.id) {
             const config = storageManager.readConfig();
             // 将挂载点转换为前端期望的资料夹格式
             const mountFolders = await Promise.all(config.webdav.map(async c => {
                const folder = await data.findFolderByName(c.name, rootFolder.id, req.session.userId);
                return {
                    id: folder ? folder.id : -1,
                    name: c.name,
                    type: 'folder',
                    parent_id: rootFolder.id
                };
             }));
             const path = await data.getFolderPath(folderId, req.session.userId);
             res.json({ contents: { folders: mountFolders, files: [] }, path });
        } else {
            const contents = await data.getFolderContents(folderId, req.session.userId);
            const path = await data.getFolderPath(folderId, req.session.userId);
            res.json({ contents, path });
        }
    } catch (error) { 
        res.status(500).json({ success: false, message: '读取资料夹内容失败。' }); 
    }
});

app.post('/api/folder', requireLogin, async (req, res) => {
    const { name, parentId } = req.body;
    const userId = req.session.userId;
    if (!name || !parentId) {
        return res.status(400).json({ success: false, message: '缺少资料夹名称或父 ID。' });
    }
    
    try {
        const rootFolder = await data.getRootFolder(userId);
        if (parseInt(parentId, 10) === rootFolder.id) {
            return res.status(400).json({ success: false, message: '无法在根目录下建立资料夹。' });
        }

        const conflict = await data.checkFullConflict(name, parentId, userId);
        if (conflict) {
            return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
        }

        const result = await data.createFolder(name, parentId, userId);
        
        const storage = storageManager.getStorage();
        if (storage.createDirectory) {
            const newFolderPathParts = await data.getFolderPath(result.id, userId);
            // 路径需要包含挂载点
            const newFullPath = path.posix.join(...newFolderPathParts.slice(1).map(p => p.name));
            await storage.createDirectory(newFullPath);
        }

        res.json(result);
    } catch (error) {
         res.status(500).json({ success: false, message: error.message || '处理资料夾时发生错误。' });
    }
});


app.get('/api/folders', requireLogin, async (req, res) => {
    const folders = await data.getAllFolders(req.session.userId);
    res.json(folders);
});

app.post('/api/move', requireLogin, async (req, res) => {
    try {
        const { itemIds, targetFolderId, resolutions = {} } = req.body;
        const userId = req.session.userId;

        if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0 || !targetFolderId) {
            return res.status(400).json({ success: false, message: '无效的请求参数。' });
        }
        
        // --- ** 挂载点隔离检查 ** ---
        const getMountName = async (folderId) => {
            const pathParts = await data.getFolderPath(folderId, userId);
            if (pathParts.length < 2) return null; // 根目录
            return pathParts[1].name;
        };
        const targetMount = await getMountName(targetFolderId);
        if (!targetMount) return res.status(400).json({ success: false, message: '移动目标不能是根目录。'});
        
        const items = await data.getItemsByIds(itemIds, userId);
        for (const item of items) {
             const sourceMount = await getMountName(item.parent_id);
             if (sourceMount !== targetMount) {
                 return res.status(400).json({ success: false, message: `无法将项目从 '${sourceMount}' 移动到 '${targetMount}'。不允许跨挂载点移动。`});
             }
        }
        
        let totalMoved = 0, totalSkipped = 0;
        const errors = [];
        
        for (const item of items) {
            try {
                const report = await data.moveItem(item.id, item.type, targetFolderId, userId, { resolutions });
                totalMoved += report.moved;
                totalSkipped += report.skipped;
                if (report.errors > 0) errors.push(`项目 "${item.name}" 处理失败。`);
            } catch (err) {
                errors.push(err.message);
            }
        }
        
        let message = "操作完成。";
        if (errors.length > 0) message = `操作完成，但出现错误: ${errors.join(', ')}`;
        else if (totalMoved > 0 && totalSkipped > 0) message = `操作完成，${totalMoved} 个项目已移动，${totalSkipped} 个项目被跳过。`;
        else if (totalMoved === 0 && totalSkipped > 0) message = "所有选定项目均被跳过。";
        else if (totalMoved > 0) message = `${totalMoved} 个项目移动成功。`;

        res.json({ success: errors.length === 0, message: message });

    } catch (error) {
        res.status(500).json({ success: false, message: '移动失败：' + error.message });
    }
});

app.post('/delete-multiple', requireLogin, async (req, res) => {
    const { messageIds = [], folderIds = [] } = req.body;
    const userId = req.session.userId;
    try {
        for(const id of messageIds) { await data.unifiedDelete(id, 'file', userId); }
        for(const id of folderIds) { await data.unifiedDelete(id, 'folder', userId); }
        res.json({ success: true, message: '删除成功' });
    } catch (error) {
        res.status(500).json({ success: false, message: '删除失败: ' + error.message });
    }
});


app.post('/rename', requireLogin, async (req, res) => {
    try {
        const { id, newName, type } = req.body;
        const userId = req.session.userId;
        if (!id || !newName || !type) {
            return res.status(400).json({ success: false, message: '缺少必要参数。'});
        }
        
        const item = (await data.getItemsByIds([id], userId))[0];
        const rootFolder = await data.getRootFolder(userId);
        if (item.parent_id === rootFolder.id) {
             return res.status(400).json({ success: false, message: '无法重新命名挂载点。'});
        }

        let result;
        if (type === 'file') {
            result = await data.renameFile(parseInt(id, 10), newName, userId);
        } else if (type === 'folder') {
            result = await data.renameFolder(parseInt(id, 10), newName, userId);
        } else {
            return res.status(400).json({ success: false, message: '无效的项目类型。'});
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: '重命名失败: ' + error.message });
    }
});

app.get('/thumbnail/:message_id', requireLogin, async (req, res) => {
    try {
        const messageId = parseInt(req.params.message_id, 10);
        const [fileInfo] = await data.getFilesByIds([messageId], req.session.userId);

        const placeholder = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': placeholder.length });
        res.end(placeholder);

    } catch (error) { res.status(500).send('获取缩图失败'); }
});

app.get('/download/proxy/:message_id', requireLogin, async (req, res) => {
    try {
        const messageId = parseInt(req.params.message_id, 10);
        const [fileInfo] = await data.getFilesByIds([messageId], req.session.userId);
        
        if (!fileInfo || !fileInfo.file_id) {
            return res.status(404).send('文件信息未找到');
        }

        const storage = storageManager.getStorage();
        
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);
        if (fileInfo.mimetype) res.setHeader('Content-Type', fileInfo.mimetype);
        if (fileInfo.size) res.setHeader('Content-Length', fileInfo.size);

        const stream = await storage.stream(fileInfo.file_id, req.session.userId);
        handleStream(stream, res);

    } catch (error) {
        res.status(500).send('下载代理失败: ' + error.message);
    }
});

app.get('/file/content/:message_id', requireLogin, async (req, res) => {
    try {
        const messageId = parseInt(req.params.message_id, 10);
        const [fileInfo] = await data.getFilesByIds([messageId], req.session.userId);

        if (!fileInfo || !fileInfo.file_id) {
            return res.status(404).send('文件信息未找到');
        }
        
        const storage = storageManager.getStorage();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');

        const stream = await storage.stream(fileInfo.file_id, req.session.userId);
        handleStream(stream, res);
    } catch (error) {
        res.status(500).send('无法获取文件内容');
    }
});


app.post('/api/download-archive', requireLogin, async (req, res) => {
    try {
        const { messageIds = [], folderIds = [] } = req.body;
        const userId = req.session.userId;
        const storage = storageManager.getStorage();

        if (messageIds.length === 0 && folderIds.length === 0) {
            return res.status(400).send('未提供任何项目 ID');
        }
        let filesToArchive = [];
        if (messageIds.length > 0) {
            const directFiles = await data.getFilesByIds(messageIds, userId);
            filesToArchive.push(...directFiles.map(f => ({ ...f, path: f.fileName })));
        }
        for (const folderId of folderIds) {
            const folderInfo = (await data.getFolderPath(folderId, userId)).pop();
            const folderName = folderInfo ? folderInfo.name : 'folder';
            const nestedFiles = await data.getFilesRecursive(folderId, userId, folderName);
            filesToArchive.push(...nestedFiles);
        }
        if (filesToArchive.length === 0) {
            return res.status(404).send('找不到任何可下载的档案');
        }
        
        const archive = require('archiver')('zip', { zlib: { level: 9 } });
        res.attachment('download.zip');
        archive.pipe(res);

        for (const file of filesToArchive) {
            const stream = await storage.stream(file.file_id, userId);
            archive.append(stream, { name: file.path });
        }
        await archive.finalize();
    } catch (error) {
        res.status(500).send('压缩档案时发生错误');
    }
});


app.post('/share', requireLogin, async (req, res) => {
    try {
        const { itemId, itemType, expiresIn } = req.body;
        if (!itemId || !itemType || !expiresIn) {
            return res.status(400).json({ success: false, message: '缺少必要参数。' });
        }
        
        const result = await data.createShareLink(parseInt(itemId, 10), itemType, expiresIn, req.session.userId);
        
        if (result.success) {
            const shareUrl = `${req.protocol}://${req.get('host')}/share/view/${itemType}/${result.token}`;
            res.json({ success: true, url: shareUrl });
        } else {
            res.status(404).json(result);
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '在伺服器上建立分享连结时发生错误。' });
    }
});

app.get('/api/shares', requireLogin, async (req, res) => {
    try {
        const shares = await data.getActiveShares(req.session.userId);
        const fullUrlShares = shares.map(item => ({
            ...item,
            share_url: `${req.protocol}://${req.get('host')}/share/view/${item.type}/${item.share_token}`
        }));
        res.json(fullUrlShares);
    } catch (error) { res.status(500).json({ success: false, message: '获取分享列表失败' }); }
});

app.post('/api/cancel-share', requireLogin, async (req, res) => {
    try {
        const { itemId, itemType } = req.body;
        if (!itemId || !itemType) return res.status(400).json({ success: false, message: '缺少必要参数' });
        const result = await data.cancelShare(parseInt(itemId, 10), itemType, req.session.userId);
        res.json(result);
    } catch (error) { res.status(500).json({ success: false, message: '取消分享失败' }); }
});

// --- 扫描器端点 ---
app.post('/api/scan/webdav', requireAdmin, async (req, res) => {
    const { userId, mountName } = req.body;
    const log = [];
    try {
        if (!userId) throw new Error('未提供使用者 ID');
        if (!mountName) throw new Error('未提供 WebDAV 挂载点名称');

        const storage = storageManager.getStorage();
        const client = storage.getClient(mountName);
        
        async function scanWebdavDirectory(remotePath) {
            const contents = await client.getDirectoryContents(remotePath, { deep: true });
            for (const item of contents) {
                if (item.type === 'file') {
                    // file_id 现在包含挂载点名称
                    const fileIdForDb = path.posix.join(mountName, item.filename);
                    const existing = await data.findFileByFileId(fileIdForDb, userId);
                     if (existing) {
                        log.push({ message: `已存在: ${fileIdForDb}，跳过。`, type: 'info' });
                    } else {
                        const folderPath = path.posix.join(mountName, path.dirname(item.filename));
                        const folderId = await data.findOrCreateFolderByPath(folderPath, userId);
                        
                        const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
                        await data.addFile({
                            message_id: messageId,
                            fileName: item.basename,
                            mimetype: item.mime || 'application/octet-stream',
                            size: item.size,
                            file_id: fileIdForDb,
                            date: new Date(item.lastmod).getTime(),
                        }, folderId, userId, 'webdav');
                        log.push({ message: `已汇入: ${fileIdForDb}`, type: 'success' });
                    }
                }
            }
        }
        
        await scanWebdavDirectory('/');
        res.json({ success: true, log });

    } catch (error) {
        let errorMessage = error.message;
        if (error.response && error.response.status === 403) {
            errorMessage = '存取被拒绝 (403 Forbidden)。这通常意味着您的 WebDAV 伺服器不允许列出目录内容。请检查您帐号的权限，确保它有读取和浏览目录的权限。';
            log.push({ message: '扫描失败：无法列出远端目录内容。', type: 'error' });
        }
        log.push({ message: `详细错误: ${errorMessage}`, type: 'error' });
        res.status(500).json({ success: false, message: errorMessage, log });
    }
});

// --- 分享路由 ---
app.get('/share/view/file/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const fileInfo = await data.getFileByShareToken(token);
        if (fileInfo) {
            const downloadUrl = `/share/download/file/${token}`;
            let textContent = null;
            if (fileInfo.mimetype && fileInfo.mimetype.startsWith('text/')) {
                const storage = storageManager.getStorage();
                const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id);
                 textContent = await new Promise((resolve, reject) => {
                    let data = '';
                    stream.on('data', chunk => data += chunk);
                    stream.on('end', () => resolve(data));
                    stream.on('error', err => reject(err));
                });
            }
            
            if (textContent !== null) {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.send(textContent);
            } else {
                res.render('share-view', { file: fileInfo, downloadUrl, textContent: null });
            }
        } else {
            res.status(404).render('share-error', { message: '此分享连结无效或已过期。' });
        }
    } catch (error) { res.status(500).render('share-error', { message: '处理分享请求时发生错误。' }); }
});

app.get('/share/view/folder/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const folderInfo = await data.getFolderByShareToken(token);
        if (folderInfo) {
            const contents = await data.getFolderContents(folderInfo.id, folderInfo.user_id);
            res.render('share-folder-view', { folder: folderInfo, contents });
        } else {
            res.status(404).render('share-error', { message: '此分享连结无效或已过期。' });
        }
    } catch (error) {
        res.status(500).render('share-error', { message: '处理分享请求时发生错误。' });
    }
});

function handleStream(stream, res) {
    stream.on('error', (err) => {
        if (!res.headersSent) {
            res.status(500).send('读取文件流时发生错误');
        }
        stream.destroy();
    }).on('close', () => {
        stream.destroy();
    }).pipe(res).on('finish', () => {
        stream.destroy();
    });
}

app.get('/share/download/file/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const fileInfo = await data.getFileByShareToken(token);
        if (!fileInfo || !fileInfo.file_id) {
             return res.status(404).send('文件信息未找到或分享链接已过期');
        }

        const storage = storageManager.getStorage();
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);

        const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id);
        handleStream(stream, res);

    } catch (error) { res.status(500).send('下载失败'); }
});

app.get('/share/thumbnail/:folderToken/:fileId', async (req, res) => {
    try {
        const { folderToken, fileId } = req.params;
        const fileInfo = await data.findFileInSharedFolder(parseInt(fileId, 10), folderToken);

        const placeholder = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': placeholder.length });
        res.end(placeholder);

    } catch (error) {
        res.status(500).send('获取缩图失败');
    }
});

app.get('/share/download/:folderToken/:fileId', async (req, res) => {
    try {
        const { folderToken, fileId } = req.params;
        const fileInfo = await data.findFileInSharedFolder(parseInt(fileId, 10), folderToken);
        
        if (!fileInfo || !fileInfo.file_id) {
             return res.status(404).send('文件信息未找到或权限不足');
        }
        
        const storage = storageManager.getStorage();
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);

        const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id);
        handleStream(stream, res);
    } catch (error) {
        res.status(500).send('下载失败');
    }
});


app.listen(PORT, () => {});

// --- API 端点 ---
app.post('/api/user/change-password', requireLogin, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    
    if (!oldPassword || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, message: '请提供旧密码和新密码，且新密码长度至少 4 个字符。' });
    }
    try {
        const user = await data.findUserById(req.session.userId);
        if (!user) {
            return res.status(404).json({ success: false, message: '找不到使用者。' });
        }

        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: '旧密码不正确。' });
        }
        
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        await data.changeUserPassword(req.session.userId, hashedPassword);
        
        res.json({ success: true, message: '密码修改成功。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '修改密码失败。' });
    }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await data.listNormalUsers();
        res.json(users);
    } catch (error) {
        res.status(500).json({ success: false, message: '获取使用者列表失败。' });
    }
});

app.get('/api/admin/all-users', requireAdmin, async (req, res) => {
    try {
        const users = await data.listAllUsers();
        res.json(users);
    } catch (error) {
        res.status(500).json({ success: false, message: '获取所有使用者列表失败。' });
    }
});


app.post('/api/admin/add-user', requireAdmin, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || password.length < 4) {
        return res.status(400).json({ success: false, message: '使用者名称和密码为必填项，且密码长度至少 4 个字符。' });
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = await data.createUser(username, hashedPassword);
        
        // 为新使用者建立根目录和所有已存在的挂载点资料夹
        const root = await data.createFolder('/', null, newUser.id);
        const config = storageManager.readConfig();
        for(const mount of config.webdav) {
            await data.createFolder(mount.name, root.id, newUser.id);
        }
        
        res.json({ success: true, user: newUser });
    } catch (error) {
        res.status(500).json({ success: false, message: '建立使用者失败，可能使用者名称已被使用。' });
    }
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, message: '使用者 ID 和新密码为必填项，且密码长度至少 4 个字符。' });
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        await data.changeUserPassword(userId, hashedPassword);
        res.json({ success: true, message: '密码修改成功。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '修改密码失败。' });
    }
});

app.post('/api/admin/delete-user', requireAdmin, async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ success: false, message: '缺少使用者 ID。' });
    }
    try {
        await data.deleteUser(userId);
        res.json({ success: true, message: '使用者已删除。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '删除使用者失败。' });
    }
});

app.get('/api/admin/webdav', requireAdmin, (req, res) => {
    const config = storageManager.readConfig();
    res.json(config.webdav || []);
});

app.post('/api/admin/webdav', requireAdmin, async (req, res) => {
    const { originalName, name, url, username, password } = req.body;
    if (!name || !url || !username) {
        return res.status(400).json({ success: false, message: '缺少必要参数' });
    }

    const config = storageManager.readConfig();
    
    // 如果是编辑，先找到旧的设定
    let isEditing = false;
    if (originalName) {
        const existingIndex = config.webdav.findIndex(c => c.name === originalName);
        if (existingIndex !== -1) {
            isEditing = true;
            const existingConfig = config.webdav[existingIndex];
            existingConfig.url = url;
            existingConfig.username = username;
            if (password) {
                existingConfig.password = password;
            }
        }
    }
    
    // 如果不是编辑（或找不到旧的），则视为新增
    if (!isEditing) {
        if (config.webdav.some(c => c.name === name)) {
            return res.status(409).json({ success: false, message: '此挂载名称已被使用。' });
        }
        const newConfig = { name, url, username };
        if (password) {
            newConfig.password = password;
        }
        config.webdav.push(newConfig);
        await data.addMountPointForAllUsers(name);
    }

    if (storageManager.writeConfig(config)) {
        res.json({ success: true, message: 'WebDAV 设定已储存' });
    } else {
        res.status(500).json({ success: false, message: '写入设定失败' });
    }
});


app.delete('/api/admin/webdav/:name', requireAdmin, async (req, res) => {
    const nameToDelete = req.params.name;
    const config = storageManager.readConfig();
    const initialLength = config.webdav.length;
    
    config.webdav = config.webdav.filter(c => c.name !== nameToDelete);

    if (config.webdav.length < initialLength) {
        if (storageManager.writeConfig(config)) {
            await data.removeMountPointForAllUsers(nameToDelete);
            res.json({ success: true, message: 'WebDAV 挂载点已删除' });
        } else {
            res.status(500).json({ success: false, message: '删除设定失败' });
        }
    } else {
        res.status(404).json({ success: false, message: '找不到要删除的挂载点' });
    }
});
