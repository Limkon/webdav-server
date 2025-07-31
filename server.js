require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const archiver = require('archiver');
const data = require('./data.js');
const storageManager = require('./storage'); 

const app = express();
const storageInstance = storageManager.getStorage();
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
            } catch (err) {
                console.warn(`清理临时文件时发生非致命错误: ${file}`, err.message);
            }
        }
    } catch (error) {
        console.error(`[严重错误] 清理暂存目录失败: ${TMP_DIR}。`, error);
    }
}

cleanupTempDir();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, TMP_DIR)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, file.fieldname + '-' + uniqueSuffix)
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 1000 * 1024 * 1024 } });
const PORT = process.env.PORT || 8100;

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-strong-random-secret-here-please-change',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());


const fixFileNameEncoding = (req, res, next) => {
    if (req.files) {
        req.files.forEach(file => {
            file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        });
    }
    next();
};

function requireLogin(req, res, next) {
  if (req.session.loggedIn) {
    next();
  } else {
    res.redirect('/login');
  }
}

function requireAdmin(req, res, next) {
    if (req.session.loggedIn && req.session.isAdmin) {
        next();
    } else {
        res.status(403).send('权限不足');
    }
}

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/login.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/register.html'));
});

app.post('/register', async (req, res) => {
    try {
        const { username, password, confirm_password } = req.body;
        if (!username || !password || password.length < 4) {
            return res.status(400).send('使用者名称和密码为必填项，且密码长度至少为 4 个字元。');
        }
        if (password !== confirm_password) {
            return res.status(400).send('两次输入的密码不一致。');
        }

        const existingUser = await data.findUserByName(username);
        if (existingUser) {
            return res.status(409).send('此使用者名称已被注册。');
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = await data.createUser(username, hashedPassword);

        await data.createFolder('/', null, newUser.id);
        
        res.redirect('/login');
    } catch (error) {
        console.error("注册失败:", error);
        res.status(500).send('注册过程中发生错误。');
    }
});

app.post('/login', async (req, res) => {
    const user = await data.findUserByName(req.body.username);
    if (user && await bcrypt.compare(req.body.password, user.password)) {
        req.session.loggedIn = true;
        req.session.userId = user.id;
        req.session.isAdmin = !!user.is_admin; 
        res.redirect('/');
    } else {
        res.status(401).send('帐号或密码错误');
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
            res.status(404).send("找不到您的根目录。");
        }
    } catch (error) {
        res.status(500).send("载入您的主页时发生错误。");
    }
});

app.get('/folder/:id', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views/manager.html'));
});

app.get('/shares-page', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views/shares.html'));
});

app.get('/admin', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views/admin.html'));
});

app.get('/scan', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views/scan.html'));
});

app.get('/editor', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views/editor.html'));
});

app.get('/s/:token', async (req, res) => {
    try {
        const file = await data.getFileForShare(req.params.token);
        if (file && (!file.share_expires_at || file.share_expires_at > Date.now())) {
            res.render('share-preview', { file });
        } else {
            const folder = await data.getFolderForShare(req.params.token);
            if (folder && (!folder.share_expires_at || folder.share_expires_at > Date.now())) {
                const contents = await data.getFolderContents(folder.id, folder.user_id);
                res.render('share-folder', { folder, contents });
            } else {
                res.status(404).send('分享连结无效或已过期。');
            }
        }
    } catch (error) {
        res.status(500).send('处理分享连结时发生错误。');
    }
});

// APIs
app.get('/api/folder/:id', requireLogin, async (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        const contents = await data.getFolderContents(folderId, req.session.userId);
        const path = await data.getFolderPath(folderId, req.session.userId);
        res.json({ contents, path });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '读取资料夹内容失败。' });
    }
});

app.post('/api/folder', requireLogin, async (req, res) => {
    try {
        const { name, parentId } = req.body;
        if (!name || !parentId) {
            return res.status(400).json({ success: false, message: '缺少资料夹名称或父 ID。' });
        }

        const conflict = await data.checkFullConflict(name, parentId, req.session.userId);
        if (conflict) {
            return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
        }

        const result = await data.createFolder(name, parentId, req.session.userId);
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message || '处理资料夹时发生错误。' });
    }
});

const uploadMiddleware = (req, res, next) => {
    const uploader = upload.array('files');
    uploader(req, res, function (err) {
        if (err) {
            console.error("Multer upload error:", err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, message: '文件大小超出限制。' });
            }
             if (err.code === 'EDQUOT' || err.errno === -122) {
                return res.status(507).json({ success: false, message: '上传失败：磁盘空间不足。' });
            }
            return res.status(500).json({ success: false, message: '上传档案到暂存区时发生错误。' });
        }
        next();
    });
};

app.post('/upload', requireLogin, async (req, res, next) => {
    await cleanupTempDir();
    next();
}, uploadMiddleware, fixFileNameEncoding, async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: '没有选择文件' });
    }

    const initialFolderId = parseInt(req.body.folderId, 10);
    const userId = req.session.userId;
    const overwritePaths = req.body.overwritePaths ? JSON.parse(req.body.overwritePaths) : [];
    let relativePaths = req.body.relativePaths;

    if (!relativePaths) {
        relativePaths = req.files.map(file => file.originalname);
    } else if (!Array.isArray(relativePaths)) {
        relativePaths = [relativePaths];
    }
    
    try {
        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const tempFilePath = file.path;
            const relativePath = relativePaths[i];

            try {
                const pathParts = (relativePath || file.originalname).split('/');
                const fileName = pathParts.pop() || file.originalname;
                const folderPath = pathParts.join('/');
                
                const targetFolderId = await data.findOrCreateFolderByPath(folderPath, userId, initialFolderId);
                
                if (overwritePaths.includes(relativePath)) {
                    const existingFile = await data.findFileInFolder(fileName, targetFolderId, userId);
                    if (existingFile) {
                         const filesToDelete = await data.getFilesByIds([existingFile.message_id], userId);
                         if (filesToDelete.length > 0) {
                            await storageInstance.remove(filesToDelete, [], userId); 
                         }
                         await data.deleteFilesByIds([existingFile.message_id], userId);
                    }
                }

                await storageInstance.upload(tempFilePath, fileName, file.mimetype, userId, targetFolderId, req.body.caption || '');
            } finally {
                if (fs.existsSync(tempFilePath)) {
                    await fsp.unlink(tempFilePath).catch(err => console.error(`无法删除临时档: ${tempFilePath}`, err));
                }
            }
        }
        res.json({ success: true });
    } catch (error) {
        console.error("Upload processing error:", error);
        res.status(500).json({ success: false, message: '处理上传时发生错误: ' + error.message });
    }
});

app.get('/api/search', requireLogin, async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) {
            return res.status(400).json({ success: false, message: '需要提供搜寻关键字。' });
        }
        const contents = await data.searchItems(query, req.session.userId); 
        const path = [{ id: null, name: `搜寻结果: "${query}"` }];
        res.json({ contents, path });
    } catch (error) { 
        res.status(500).json({ success: false, message: '搜寻失败。' }); 
    }
});

app.post('/delete-multiple', requireLogin, async (req, res) => {
    try {
        const { messageIds = [], folderIds = [] } = req.body;
        const userId = req.session.userId;

        let filesToDelete = [];
        let foldersToDeleteWithPaths = [];
        let allFolderIdsToDelete = [...folderIds];

        if (folderIds.length > 0) {
            for (const folderId of folderIds) {
                const dataForDeletion = await data.getFolderDeletionData(folderId, userId);
                filesToDelete.push(...dataForDeletion.files);
                foldersToDeleteWithPaths.push(...dataForDeletion.folders);
            }
        }

        if (messageIds.length > 0) {
            const directFiles = await data.getFilesByIds(messageIds, userId);
            filesToDelete.push(...directFiles);
        }

        const uniqueFileIds = [...new Set(filesToDelete.map(f => f.message_id))];
        const uniqueFiles = uniqueFileIds.map(id => filesToDelete.find(f => f.message_id === id));
        
        await storageInstance.remove(uniqueFiles, foldersToDeleteWithPaths, userId);
        await data.executeDeletion(uniqueFileIds, allFolderIdsToDelete, userId);
        
        res.json({ success: true, message: '项目已删除。' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '删除过程中发生错误。' });
    }
});

app.post('/api/move', requireLogin, async (req, res) => {
    try {
        const { fileIds, folderIds, targetFolderId } = req.body;
        if ((!fileIds && !folderIds) || !targetFolderId) {
            return res.status(400).json({ success: false, message: '无效的请求。' });
        }
        const result = await data.moveItems(fileIds, folderIds, targetFolderId, req.session.userId);
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '移动失败。' });
    }
});

app.post('/api/rename', requireLogin, async (req, res) => {
    try {
        const { id, type, newName } = req.body;
        if (!id || !type || !newName) {
            return res.status(400).json({ success: false, message: '缺少必要参数。' });
        }

        let result;
        if (type === 'file') {
            result = await data.renameFile(id, newName, req.session.userId);
        } else {
            result = await data.renameFolder(id, newName, req.session.userId);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: '重命名失败。' });
    }
});

app.get('/api/folders/tree', requireLogin, async (req, res) => {
    try {
        const folders = await data.getAllFolders(req.session.userId);
        res.json(folders);
    } catch (error) {
        res.status(500).json({ success: false, message: '无法获取资料夹树。' });
    }
});

app.get('/api/shares', requireLogin, async (req, res) => {
    try {
        const shares = await data.getActiveShares(req.session.userId);
        res.json(shares);
    } catch (error) {
        res.status(500).json({ success: false, message: '无法获取分享列表。' });
    }
});

app.post('/api/share', requireLogin, async (req, res) => {
    try {
        const { itemId, itemType, expiresInHours } = req.body;
        const result = await data.createShareToken(itemId, itemType, req.session.userId, expiresInHours);
        if (result.success) {
            res.json({ success: true, shareUrl: `${req.protocol}://${req.get('host')}/s/${result.token}`, expires: result.expiresAt });
        } else {
            res.status(404).json({ success: false, message: '找不到要分享的项目。' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '建立分享连结失败。' });
    }
});

app.delete('/api/share/:type/:id', requireLogin, async (req, res) => {
    try {
        const { type, id } = req.params;
        const result = await data.deleteShare(type, id, req.session.userId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: '删除分享失败。' });
    }
});


app.get('/download/proxy/:messageId', async (req, res) => {
    try {
        const fileInfo = await data.getFilesByIds([req.params.messageId], null); // Bypassing userId check for public shares
        if (!fileInfo || fileInfo.length === 0) {
            return res.status(404).send('文件未找到。');
        }

        const file = fileInfo[0];
        const storage = storageManager.getStorage();
        const stream = await storage.stream(file.file_id, file.user_id);
        
        res.setHeader('Content-Type', file.mimetype || 'application/octet-stream');
        res.setHeader('Content-Length', file.size);
        stream.pipe(res);
        stream.on('error', (err) => {
            console.error("Stream error:", err);
            res.status(500).send("读取档案时出错。");
        });
    } catch (error) {
        res.status(500).send('下载失败。');
    }
});

app.get('/download/archive', requireLogin, async (req, res) => {
    try {
        const fileIds = req.query.files ? req.query.files.split(',') : [];
        const folderIds = req.query.folders ? req.query.folders.split(',') : [];

        if (fileIds.length === 0 && folderIds.length === 0) {
            return res.status(400).send('没有选择任何档案或资料夹。');
        }
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        res.attachment('archive.zip');
        archive.pipe(res);

        const files = await data.getFilesByIds(fileIds, req.session.userId);
        for (const file of files) {
            const stream = await storageInstance.stream(file.file_id, req.session.userId);
            archive.append(stream, { name: file.fileName });
        }
        
        res.on('close', () => archive.destroy());
        archive.finalize();

    } catch (error) {
        console.error("Archive error:", error);
        if (!res.headersSent) {
            res.status(500).send('建立压缩档时发生错误。');
        }
    }
});

app.get('/api/text/:fileId', requireLogin, async (req, res) => {
    try {
        const files = await data.getFilesByIds([req.params.fileId], req.session.userId);
        if (!files || files.length === 0) {
            return res.status(404).json({ success: false, message: '文件未找到。' });
        }
        const file = files[0];
        const stream = await storageInstance.stream(file.file_id, req.session.userId);
        let content = '';
        for await (const chunk of stream) {
            content += chunk;
        }
        res.json({ success: true, content, fileName: file.fileName });
    } catch (error) {
        res.status(500).json({ success: false, message: '读取档案内容失败。' });
    }
});
app.post('/api/text', requireLogin, async (req, res) => {
    const { content, fileName, folderId, fileId } = req.body;
    const userId = req.session.userId;
    const tempPath = path.join(TMP_DIR, `temp_${Date.now()}.txt`);

    try {
        await fsp.writeFile(tempPath, content);
        const finalFileName = fileName.endsWith('.txt') ? fileName : `${fileName}.txt`;

        if (fileId) { // Overwrite existing file
            const filesToDelete = await data.getFilesByIds([fileId], userId);
            if (filesToDelete.length > 0) {
                await storageInstance.remove(filesToDelete, [], userId);
                await data.deleteFilesByIds([fileId], userId);
            }
        }
        
        await storageInstance.upload(tempPath, finalFileName, 'text/plain', userId, folderId);
        res.json({ success: true, message: '档案已储存。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '储存档案失败。' });
    } finally {
        if (fs.existsSync(tempPath)) {
            await fsp.unlink(tempPath);
        }
    }
});

app.post('/api/check-existence', requireLogin, async (req, res) => {
    try {
        const { files, folderId } = req.body;
        const promises = files.map(file => data.checkFileExistence(file, folderId, req.session.userId));
        const results = await Promise.all(promises);
        res.json({ files: results });
    } catch (error) {
        res.status(500).json({ success: false, message: '检查档案时出错。' });
    }
});


// Admin and config routes
app.get('/api/config', requireAdmin, (req, res) => {
    res.json(storageManager.readConfig());
});
app.post('/api/config', requireAdmin, (req, res) => {
    if (storageManager.writeConfig(req.body)) {
        res.json({ success: true, message: '设定已储存。' });
    } else {
        res.status(500).json({ success: false, message: '写入设定失败。' });
    }
});

// User Management API
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await data.listAllUsers();
        res.json(users);
    } catch (error) {
        res.status(500).json({ success: false, message: '获取使用者列表失败。' });
    }
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const result = await data.deleteUser(req.params.id);
        if (result.changes > 0) {
            res.json({ success: true, message: '使用者已删除。' });
        } else {
            res.status(404).json({ success: false, message: '找不到使用者或该使用者是管理员。' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '删除使用者失败。' });
    }
});

// Scan API
app.post('/api/scan', requireAdmin, async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ success: false, message: '必须提供使用者 ID。' });
    }
    
    try {
        const log = await storageInstance.scan(userId);
        res.json({ success: true, log });
    } catch (error) {
        res.status(500).json({ success: false, message: `扫描时出错: ${error.message}` });
    }
});


app.listen(PORT, () => {
  console.log(`✅ 伺服器已在 http://localhost:${PORT} 上运行`);
});
