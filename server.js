require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
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
    } catch (error) {
        console.error(`[严重错误] 清理暂存目录失败: ${TMP_DIR}。`, error);
    }
}
cleanupTempDir();

const diskStorage = multer.diskStorage({
  destination: (req, res, cb) => cb(null, TMP_DIR)
});
const upload = multer({ storage: diskStorage, limits: { fileSize: 1000 * 1024 * 1024 } });
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
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
    if (req.session.loggedIn && req.session.isAdmin) {
        return next();
    }
    res.status(403).send('权限不足');
}

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views/login.html')));
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
        if (err) return res.redirect('/');
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.get('/', requireLogin, async (req, res) => {
    try {
        const rootFolder = await data.getRootFolder(req.session.userId);
        if (!rootFolder) {
            const newRoot = await data.createFolder('/', null, req.session.userId);
            return res.redirect(`/folder/${newRoot.id}`);
        }
        res.redirect(`/folder/${rootFolder.id}`);
    } catch (error) {
        res.status(500).send("找不到您的根目录，也无法建立。");
    }
});
app.get('/folder/:id', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/manager.html')));
app.get('/shares-page', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/shares.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin.html')));
app.get('/scan', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/scan.html')));

// --- API ---

// User API
app.post('/api/user/change-password', requireLogin, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, message: '请提供旧密码和新密码，且新密码长度至少 4 个字符。' });
    }
    try {
        const user = await data.findUserById(req.session.userId);
        if (!user || !(await bcrypt.compare(oldPassword, user.password))) {
            return res.status(401).json({ success: false, message: '旧密码不正确。' });
        }
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await data.changeUserPassword(req.session.userId, hashedPassword);
        res.json({ success: true, message: '密码修改成功。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '修改密码失败。' });
    }
});

// Admin API
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
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await data.createUser(username, hashedPassword);
        await data.createFolder('/', null, newUser.id);
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
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await data.changeUserPassword(userId, hashedPassword);
        res.json({ success: true, message: '密码修改成功。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '修改密码失败。' });
    }
});

app.post('/api/admin/delete-user', requireAdmin, async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: '缺少使用者 ID。' });
    try {
        await data.deleteUserAndData(userId);
        res.json({ success: true, message: '使用者及其所有资料已删除。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '删除使用者失败。' });
    }
});

// WebDAV Config API
app.get('/api/admin/webdav-configs', requireAdmin, async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ success: false, message: '缺少使用者 ID' });
    try {
        const configs = await data.getWebdavConfigsForUser(userId);
        res.json(configs);
    } catch (error) {
        res.status(500).json({ success: false, message: '获取设定失败' });
    }
});

app.post('/api/admin/webdav-config', requireAdmin, async (req, res) => {
    try {
        const result = await data.saveWebdavConfig(req.body);
        res.json(result);
    } catch(error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/webdav-config/:id', requireAdmin, async (req, res) => {
    try {
        const result = await data.deleteWebdavConfig(req.params.id);
        res.json(result);
    } catch(error) {
        res.status(500).json({ success: false, message: error.message });
    }
});


// Upload & File API
const uploadMiddleware = upload.array('files');

app.post('/upload', requireLogin, async (req, res, next) => {
    await cleanupTempDir();
    next();
}, uploadMiddleware, fixFileNameEncoding, async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: '没有选择文件' });
    }
    const { folderId: initialFolderId, resolutions: resolutionsJSON, relativePaths: rawRelativePaths } = req.body;
    const userId = req.session.userId;
    const storage = storageManager.getStorage();
    const resolutions = resolutionsJSON ? JSON.parse(resolutionsJSON) : {};

    let relativePaths = rawRelativePaths || req.files.map(f => f.originalname);
    if (!Array.isArray(relativePaths)) relativePaths = [relativePaths];

    if (req.files.length !== relativePaths.length) {
        return res.status(400).json({ success: false, message: '上传档案和路径资讯不匹配。' });
    }
    
    let skippedCount = 0;
    try {
        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const tempFilePath = file.path;
            const relativePath = relativePaths[i];
            const action = resolutions[relativePath] || 'upload';

            try {
                if (action === 'skip') {
                    skippedCount++; continue;
                }

                const pathParts = (relativePath || file.originalname).split('/');
                let fileName = pathParts.pop() || file.originalname;
                const targetFolderId = await data.resolvePathToFolderId(parseInt(initialFolderId, 10), pathParts, userId);
                const isWebdavMount = await data.isWebdavMount(targetFolderId, userId);
                if (!isWebdavMount) throw new Error('上传目标必须是 WebDAV 挂载点内的目录。');
                
                if (action === 'overwrite') {
                    const existing = await data.findItemInFolder(fileName, targetFolderId, userId);
                    if (existing) await data.unifiedDelete(existing.id, existing.type, userId);
                } else if (action === 'rename') {
                    fileName = await data.findAvailableName(fileName, targetFolderId, userId, false);
                } else if (await data.findItemInFolder(fileName, targetFolderId, userId)) {
                    skippedCount++; continue;
                }

                await storage.upload(tempFilePath, fileName, file.mimetype, userId, targetFolderId);
            } finally {
                if (fsSync.existsSync(tempFilePath)) await fsp.unlink(tempFilePath).catch(() => {});
            }
        }
        res.json({ success: true, skippedAll: skippedCount === req.files.length, message: '上传完成' });
    } catch (error) {
        res.status(500).json({ success: false, message: '处理上传时发生错误: ' + error.message });
    }
});

app.post('/api/text-file', requireLogin, async (req, res) => {
    const { mode, fileId, folderId, fileName, content } = req.body;
    const userId = req.session.userId;

    if (!fileName || !fileName.endsWith('.txt')) {
        return res.status(400).json({ success: false, message: '档名无效或不是 .txt 档案' });
    }
    const storage = storageManager.getStorage();
    const tempFilePath = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.txt`);
    try {
        await fsp.writeFile(tempFilePath, content, 'utf8');
        let result;
        if (mode === 'edit' && fileId) {
            const originalFile = (await data.getFilesByIds([fileId], userId))[0];
            if (!originalFile) return res.status(404).json({ success: false, message: '找不到要编辑的原始档案' });
            if (fileName !== originalFile.fileName && await data.checkFullConflict(fileName, originalFile.folder_id, userId)) {
                return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
            }
            await data.unifiedDelete(originalFile.message_id, 'file', userId);
            result = await storage.upload(tempFilePath, fileName, 'text/plain', userId, originalFile.folder_id);
        } else if (mode === 'create' && folderId) {
            if (await data.checkFullConflict(fileName, folderId, userId)) {
                return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
            }
             const isWebdavMount = await data.isWebdavMount(folderId, userId);
            if (!isWebdavMount) throw new Error('新档案必须建立在 WebDAV 挂载点内的目录。');
            result = await storage.upload(tempFilePath, fileName, 'text/plain', userId, folderId);
        } else {
            return res.status(400).json({ success: false, message: '请求参数无效' });
        }
        res.json({ success: true, fileId: result.fileId });
    } catch (error) {
        res.status(500).json({ success: false, message: '伺服器内部错误: ' + error.message });
    } finally {
        if (fsSync.existsSync(tempFilePath)) await fsp.unlink(tempFilePath).catch(() => {});
    }
});

app.get('/api/file-info/:id', requireLogin, async (req, res) => {
    try {
        const [fileInfo] = await data.getFilesByIds([parseInt(req.params.id, 10)], req.session.userId);
        if (fileInfo) res.json(fileInfo);
        else res.status(404).json({ success: false, message: '找不到档案资讯' });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取档案资讯失败' });
    }
});

app.get('/file/content/:message_id', requireLogin, async (req, res) => {
    try {
        const [fileInfo] = await data.getFilesByIds([parseInt(req.params.message_id, 10)], req.session.userId);
        if (!fileInfo || !fileInfo.file_id) return res.status(404).send('文件信息未找到');
        
        const storage = storageManager.getStorage();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        const stream = await storage.stream(fileInfo.file_id, req.session.userId, fileInfo.webdav_config_id);
        stream.pipe(res);
    } catch (error) { 
        res.status(500).send('无法获取文件内容'); 
    }
});

app.get('/download/proxy/:message_id', requireLogin, async (req, res) => {
    try {
        const [fileInfo] = await data.getFilesByIds([parseInt(req.params.message_id, 10)], req.session.userId);
        if (!fileInfo || !fileInfo.file_id) return res.status(404).send('文件信息未找到');

        const storage = storageManager.getStorage();
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);
        if (fileInfo.mimetype) res.setHeader('Content-Type', fileInfo.mimetype);
        if (fileInfo.size) res.setHeader('Content-Length', fileInfo.size);
        const stream = await storage.stream(fileInfo.file_id, req.session.userId, fileInfo.webdav_config_id);
        stream.pipe(res);
    } catch (error) { 
        res.status(500).send('下载代理失败: ' + error.message); 
    }
});

// Folder & Item API
app.get('/api/folder/:id', requireLogin, async (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        const contents = await data.getFolderContents(folderId, req.session.userId);
        const path = await data.getFolderPath(folderId, req.session.userId);
        res.json({ contents, path });
    } catch (error) { res.status(500).json({ success: false, message: '读取资料夹内容失败。' }); }
});

app.get('/api/folders', requireLogin, async (req, res) => {
    const folders = await data.getAllFolders(req.session.userId);
    res.json(folders);
});

app.post('/api/folder', requireLogin, async (req, res) => {
    const { name, parentId } = req.body;
    const userId = req.session.userId;
    if (!name || !parentId) return res.status(400).json({ success: false, message: '缺少资料夹名称或父 ID。' });
    try {
        const isWebdavMount = await data.isWebdavMount(parentId, userId);
        if (!isWebdavMount) throw new Error('新资料夹必须建立在 WebDAV 挂载点内的目录。');
        if (await data.checkFullConflict(name, parentId, userId)) {
            return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
        }
        const result = await data.createFolder(name, parentId, userId);
        res.json(result);
    } catch (error) {
         res.status(500).json({ success: false, message: error.message || '处理资料夾时发生错误。' });
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

app.post('/rename', requireLogin, async (req, res) => {
    try {
        const { id, newName, type } = req.body;
        const userId = req.session.userId;
        if (!id || !newName || !type) return res.status(400).json({ success: false, message: '缺少必要参数。'});

        const result = await data.renameItem(parseInt(id, 10), newName, type, userId);
        res.json(result);
    } catch (error) { 
        res.status(500).json({ success: false, message: '重命名失败: ' + error.message }); 
    }
});

app.post('/delete-multiple', requireLogin, async (req, res) => {
    const { messageIds = [], folderIds = [] } = req.body;
    const userId = req.session.userId;
    try {
        for(const id of messageIds) await data.unifiedDelete(id, 'file', userId);
        for(const id of folderIds) await data.unifiedDelete(id, 'folder', userId);
        res.json({ success: true, message: '删除成功' });
    } catch (error) {
        res.status(500).json({ success: false, message: '删除失败: ' + error.message });
    }
});

// Scanner API
app.post('/api/scan/webdav', requireAdmin, async (req, res) => {
    const { userId, webdavConfigId } = req.body;
    const log = [];
    try {
        if (!userId || !webdavConfigId) throw new Error('未提供使用者或 WebDAV 设定 ID');
        const webdavConfig = await data.getWebdavConfigById(webdavConfigId);
        if (!webdavConfig) throw new Error('找不到指定的 WebDAV 设定');

        const { createClient } = require('webdav');
        const client = createClient(webdavConfig.url, {
            username: webdavConfig.username,
            password: webdavConfig.password
        });
        
        async function scanDirectory(remotePath) {
            const contents = await client.getDirectoryContents(remotePath, { deep: true });
            for (const item of contents) {
                if (item.type === 'file') {
                    if (await data.findFileByFileId(item.filename, userId)) {
                        log.push({ message: `已存在: ${item.filename}，跳过。`, type: 'info' });
                    } else {
                        const folderPath = path.dirname(item.filename).replace(/\\/g, '/');
                        const folderId = await data.findOrCreateFolderByPath(folderPath, userId, webdavConfigId);
                        
                        const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
                        await data.addFile({
                            message_id: messageId,
                            fileName: item.basename,
                            mimetype: item.mime || 'application/octet-stream',
                            size: item.size,
                            file_id: item.filename,
                            date: new Date(item.lastmod).getTime(),
                        }, folderId, userId, 'webdav', webdavConfigId);
                        log.push({ message: `已汇入: ${item.filename}`, type: 'success' });
                    }
                }
            }
        }
        await scanDirectory('/');
        res.json({ success: true, log });
    } catch (error) {
        log.push({ message: `扫描失败: ${error.message}`, type: 'error' });
        res.status(500).json({ success: false, message: error.message, log });
    }
});


// Share and Download API
app.post('/share', requireLogin, async (req, res) => {
    try {
        const { itemId, itemType, expiresIn } = req.body;
        if (!itemId || !itemType || !expiresIn) return res.status(400).json({ success: false, message: '缺少必要参数。' });
        
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

app.get('/share/view/file/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const fileInfo = await data.getFileByShareToken(token);
        if (!fileInfo) return res.status(404).render('share-error', { message: '此分享连结无效或已过期。' });
        const downloadUrl = `/share/download/file/${token}`;
        let textContent = null;
        if (fileInfo.mimetype && fileInfo.mimetype.startsWith('text/')) {
            const storage = storageManager.getStorage();
            const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id, fileInfo.webdav_config_id);
            textContent = await new Promise((resolve, reject) => {
                let data = '';
                stream.on('data', chunk => data += chunk);
                stream.on('end', () => resolve(data));
                stream.on('error', err => reject(err));
            });
        }
        res.render('share-view', { file: fileInfo, downloadUrl, textContent });
    } catch (error) { 
        res.status(500).render('share-error', { message: '处理分享请求时发生错误。' }); 
    }
});

app.get('/share/download/file/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const fileInfo = await data.getFileByShareToken(token);
        if (!fileInfo || !fileInfo.file_id) return res.status(404).send('文件信息未找到或分享链接已过期');

        const storage = storageManager.getStorage();
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);
        const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id, fileInfo.webdav_config_id);
        stream.pipe(res);
    } catch (error) { 
        res.status(500).send('下载失败'); 
    }
});


app.listen(PORT, () => console.log(`✅ 伺服器已在 http://localhost:${PORT} 上运行`));
