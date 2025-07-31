require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
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

// --- 中介软体 ---
const fixFileNameEncoding = (req, res, next) => {
    if (req.files) {
        req.files.forEach(file => {
            file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        });
    }
    next();
};

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
    const rootFolder = await data.getRootFolder(req.session.userId);
    if (!rootFolder) {
        return res.status(500).send("找不到您的根目录");
    }
    res.redirect(`/folder/${rootFolder.id}`);
});
app.get('/folder/:id', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/manager.html')));
app.get('/shares-page', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/shares.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin.html')));
app.get('/scan', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/scan.html')));


// --- API 接口 ---
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


app.get('/api/admin/all-users', requireAdmin, async (req, res) => {
    try {
        const users = await data.listAllUsers();
        res.json(users);
    } catch (error) {
        res.status(500).json({ success: false, message: '获取所有使用者列表失败。' });
    }
});

// --- WebDAV 挂载点管理 API ---
app.get('/api/admin/webdav', requireAdmin, (req, res) => {
    const config = storageManager.readConfig();
    res.json(config.webdavs || []);
});

app.post('/api/admin/webdav', requireAdmin, async (req, res) => {
    const { id, name, url, username, password } = req.body;
    if (!name || !url) { 
        return res.status(400).json({ success: false, message: '名称和 URL 为必填项' });
    }

    try {
        // 1. 先将设定储存到资料库，并取得 ID
        const dbResult = await data.saveOrUpdateWebdavMount({ 
            id: id ? parseInt(id) : null, 
            name, url, username, 
            password: password || undefined 
        });
        const mountId = dbResult.id;

        // 2. 更新 config.json 设定档
        const config = storageManager.readConfig();
        if (!config.webdavs) config.webdavs = [];

        const existingIndex = config.webdavs.findIndex(w => w.id === mountId);
        const mountConfig = { id: mountId, name, url, username };
        if (password) {
            mountConfig.password = password;
        }

        if (existingIndex > -1) {
            config.webdavs[existingIndex] = { ...config.webdavs[existingIndex], ...mountConfig };
        } else {
            config.webdavs.push(mountConfig);
        }
        
        storageManager.writeConfig(config);

        // 3. 为所有使用者建立对应的根目录挂载点资料夹
        const allUsers = await data.listAllUsers();
        for (const user of allUsers) {
            const root = await data.getRootFolder(user.id);
            if (root) {
                const mountFolder = await data.findFolderByName(name, root.id, root.user_id);
                if (!mountFolder) {
                    await data.createFolder(name, root.id, root.user_id, mountId);
                } else if (mountFolder.mount_id !== mountId) {
                    await db.run('UPDATE folders SET mount_id = ? WHERE id = ?', [mountId, mountFolder.id]);
                }
            }
        }
        
        res.json({ success: true, message: 'WebDAV 设定已储存' });
    } catch (error) {
        console.error("储存 WebDAV 设定时发生错误:", error);
        res.status(500).json({ success: false, message: '储存设定失败: ' + error.message });
    }
});


app.delete('/api/admin/webdav/:id', requireAdmin, async (req, res) => {
    const idToDelete = parseInt(req.params.id);
    
    // 从资料库删除
    await db.run('DELETE FROM webdav_mounts WHERE id = ?', [idToDelete]);

    // 从 config.json 删除
    const config = storageManager.readConfig();
    config.webdavs = config.webdavs.filter(w => w.id !== idToDelete);
    
    if (storageManager.writeConfig(config)) {
        res.json({ success: true, message: 'WebDAV 设定已删除' });
    } else {
        res.status(500).json({ success: false, message: '删除设定失败' });
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
    
    const rootFolder = await data.getRootFolder(userId);
    if (initialFolderId === rootFolder.id) {
        return res.status(403).json({ success: false, message: "无法直接上传到根目录，请选择一个挂载点。" });
    }

    try {
        const initialFolderInfo = await data.getFolderInfo(initialFolderId, userId);
        if (!initialFolderInfo || !initialFolderInfo.mount_id) {
            throw new Error(`上传的初始资料夹无效或不属于任何挂载点。`);
        }
        const mountId = initialFolderInfo.mount_id;
        const storage = storageManager.getStorage(mountId);

        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const tempFilePath = file.path;
            const relativePath = relativePaths[i];

            try {
                // *** 关键修正开始：重构寻找目标资料夹的逻辑 ***
                const pathParts = (relativePath || file.originalname).split('/').filter(p => p);
                const fileName = pathParts.pop() || file.originalname;
                const folderPathParts = pathParts; // 档案所在的子目录路径

                let parentFolderId = initialFolderId;

                // 逐层建立子目录
                for (const part of folderPathParts) {
                    let subFolder = await data.findFolderByName(part, parentFolderId, userId);
                    if (subFolder) {
                        parentFolderId = subFolder.id;
                    } else {
                        const result = await data.createFolder(part, parentFolderId, userId, mountId);
                        parentFolderId = result.id;
                    }
                }
                const targetFolderId = parentFolderId;
                // *** 关键修正结束 ***
                
                if (overwritePaths.includes(relativePath)) {
                    const existingFile = await data.findFileInFolder(fileName, targetFolderId, userId);
                    if (existingFile) {
                         const filesToDelete = await data.getFilesByIds([existingFile.message_id], userId);
                         if (filesToDelete.length > 0) {
                            await storage.remove(filesToDelete, [], userId); 
                         }
                         await data.deleteFilesByIds([existingFile.message_id], userId);
                    }
                }

                await storage.upload(tempFilePath, fileName, file.mimetype, userId, targetFolderId);

            } finally {
                if (fs.existsSync(tempFilePath)) {
                    await fsp.unlink(tempFilePath).catch(err => console.error(`无法删除临时档: ${tempFilePath}`, err));
                }
            }
        }
        res.json({ success: true, message: '所有档案已上传成功。' });
    } catch (error) {
        console.error("Upload processing error:", error);
        res.status(500).json({ success: false, message: '处理上传时发生错误: ' + error.message });
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
        const contents = await data.getFolderContents(folderId, req.session.userId);
        const path = await data.getFolderPath(folderId, req.session.userId);
        res.json({ contents, path });
    } catch (error) { res.status(500).json({ success: false, message: '读取资料夹内容失败。' }); }
});

app.post('/api/folder', requireLogin, async (req, res) => {
    const { name, parentId } = req.body;
    const userId = req.session.userId;
    if (!name || !parentId) {
        return res.status(400).json({ success: false, message: '缺少资料夹名称或父 ID。' });
    }
    
    try {
        const parentFolderInfo = await data.getFolderInfo(parentId, userId);
        if (!parentFolderInfo || (!parentFolderInfo.mount_id && parentFolderInfo.parent_id !== null)) {
            return res.status(403).json({ success: false, message: '无法在此位置建立资料夹，请在挂载点内操作。'});
        }
        const mountId = parentFolderInfo.mount_id;

        const conflict = await data.checkFullConflict(name, parentId, userId);
        if (conflict) {
            return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
        }

        const result = await data.createFolder(name, parentId, userId, mountId);
        res.json(result);
    } catch (error) {
         res.status(500).json({ success: false, message: error.message || '处理资料夹时发生错误。' });
    }
});

app.post('/api/move', requireLogin, async (req, res) => {
    try {
        const { itemIds, targetFolderId } = req.body;
        const userId = req.session.userId;
        if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0 || !targetFolderId) {
            return res.status(400).json({ success: false, message: '无效的请求参数。' });
        }
        
        const items = await data.getItemsByIds(itemIds, userId);
        const targetFolderInfo = await data.getFolderInfo(targetFolderId, userId);

        if (!targetFolderInfo || !targetFolderInfo.mount_id) {
             return res.status(403).json({ success: false, message: '移动目标必须是有效的 WebDAV 挂载子目录。' });
        }
        
        const sourceMountId = items[0].mount_id;
        const allSameMount = items.every(item => item.mount_id === sourceMountId);
        
        if (!allSameMount || sourceMountId !== targetFolderInfo.mount_id) {
            return res.status(403).json({ success: false, message: '禁止跨 WebDAV 挂载点移动项目。所有项目必须在同一个挂载点内移动。' });
        }
        
        // 此处简化为只更新数据库。生产环境需要实现 WebDAV 端的移动操作。
        const fileIds = items.filter(i => i.type === 'file').map(i => i.id);
        const folderIds = items.filter(i => i.type === 'folder').map(i => i.id);

        await data.moveItems(fileIds, folderIds, targetFolderId, userId);
        
        res.json({ success: true, message: "移动成功" });
    } catch (error) { 
        res.status(500).json({ success: false, message: '移动失败：' + error.message }); 
    }
});

async function unifiedDeleteHandler(req, res) {
    const { messageIds = [], folderIds = [] } = req.body;
    const userId = req.session.userId;
    
    if (messageIds.length === 0 && folderIds.length === 0) {
        return res.status(400).json({ success: false, message: '无效的请求参数。' });
    }

    try {
        const itemsByMount = new Map();

        if (folderIds.length > 0) {
            for (const folderId of folderIds) {
                const deletionData = await data.getFolderDeletionData(folderId, userId);
                const mountId = deletionData.folders[0]?.mount_id;
                if (!mountId) continue;
                if (!itemsByMount.has(mountId)) itemsByMount.set(mountId, { files: [], folders: [] });
                itemsByMount.get(mountId).files.push(...deletionData.files);
                itemsByMount.get(mountId).folders.push(...deletionData.folders);
            }
        }
        
        if (messageIds.length > 0) {
            const directFiles = await data.getFilesByIds(messageIds, userId);
            for (const file of directFiles) {
                 if (!itemsByMount.has(file.mount_id)) itemsByMount.set(file.mount_id, { files: [], folders: [] });
                 itemsByMount.get(file.mount_id).files.push(file);
            }
        }
        
        for (const [mountId, items] of itemsByMount.entries()) {
            const storage = storageManager.getStorage(mountId);
            await storage.remove(items.files, items.folders, userId);
        }

        const allFileIdsToDelete = [...itemsByMount.values()].flatMap(i => i.files.map(f => f.message_id));
        const allFolderIdsToDelete = [...itemsByMount.values()].flatMap(i => i.folders.map(f => f.id));
        await data.executeDeletion(allFileIdsToDelete, allFolderIdsToDelete, userId);

        res.json({ success: true, message: '删除操作已完成。' });

    } catch (error) {
        res.status(500).json({ success: false, message: '删除过程中发生错误: ' + error.message });
    }
}

app.post('/delete-multiple', requireLogin, unifiedDeleteHandler);

// --- 扫描 API 端点 ---
app.post('/api/scan/webdav', requireAdmin, async (req, res) => {
    const { mountId } = req.body;
    if (!mountId) {
        return res.status(400).json({ success: false, message: '未提供挂载点 ID' });
    }
    try {
        const storage = storageManager.getStorage(parseInt(mountId));
        const log = await storage.scan();
        res.json({ success: true, log });
    } catch (error) {
        res.status(500).json({ success: false, message: `扫描 WebDAV 时出错: ${error.message}` });
    }
});

app.listen(PORT, () => console.log(`✅ 伺服器已在 http://localhost:${PORT} 上运行`));
