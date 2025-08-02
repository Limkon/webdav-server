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

// --- Temp File Directory and Cleanup ---
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
                // 在生产环境中，这类非致命警告可以被移除或记录到专门的日志文件
            }
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

// --- Middleware ---
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

// 辅助函数：为新用户创建挂载点
async function createMountPointsForUser(userId) {
    const rootFolder = await data.getRootFolder(userId);
    if (!rootFolder) {
        console.error(`无法为用户 ${userId} 找到根目录。`);
        return;
    }
    const config = storageManager.readConfig();
    if (config.webdav && Array.isArray(config.webdav)) {
        for (const mount of config.webdav) {
            if (mount.mount_name) {
                // 检查文件夹是否已存在
                const existing = await data.findFolderByName(mount.mount_name, rootFolder.id, userId);
                if (!existing) {
                    await data.createFolder(mount.mount_name, rootFolder.id, userId);
                }
            }
        }
    }
}

// --- Routes ---
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
            // 登录时也检查一下挂载点
            await createMountPointsForUser(user.id);
            res.redirect('/');
        } else {
            res.status(401).send('帐号或密码错误');
        }
    } catch(error) {
        res.status(500).send('登录时发生错误');
    }
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send('请提供用户名和密码');
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = await data.createUser(username, hashedPassword);
        
        await data.createFolder('/', null, newUser.id); // 创建根目录
        await createMountPointsForUser(newUser.id); // 创建挂载点
        
        res.redirect('/login');
    } catch (error) {
        res.status(500).send('注册失败，用户名可能已被使用。');
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
    let rootFolder = await data.getRootFolder(req.session.userId);
    if (!rootFolder) {
        await data.createFolder('/', null, req.session.userId);
        rootFolder = await data.getRootFolder(req.session.userId);
    }
    // 确保挂载点存在
    await createMountPointsForUser(req.session.userId);
    res.redirect(`/folder/${rootFolder.id}`);
});

app.get('/folder/:id', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/manager.html')));
app.get('/shares-page', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/shares.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin.html')));
app.get('/scan', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/scan.html')));

// --- API Endpoints ---
app.post('/api/user/change-password', requireLogin, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    
    if (!oldPassword || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, message: '请提供旧密码和新密码，且新密码长度至少 4 个字符。' });
    }
    try {
        const user = await data.findUserById(req.session.userId);
        if (!user) {
            return res.status(404).json({ success: false, message: '找不到用户。' });
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
        res.status(500).json({ success: false, message: '获取用户列表失败。' });
    }
});

app.get('/api/admin/all-users', requireAdmin, async (req, res) => {
    try {
        const users = await data.listAllUsers();
        res.json(users);
    } catch (error) {
        res.status(500).json({ success: false, message: '获取所有用户列表失败。' });
    }
});

app.post('/api/admin/add-user', requireAdmin, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || password.length < 4) {
        return res.status(400).json({ success: false, message: '用户名和密码为必填项，且密码长度至少 4 个字符。' });
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = await data.createUser(username, hashedPassword);
        
        await data.createFolder('/', null, newUser.id);
        await createMountPointsForUser(newUser.id);
        
        res.json({ success: true, user: newUser });
    } catch (error) {
        res.status(500).json({ success: false, message: '创建用户失败，可能用户名已被使用。' });
    }
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, message: '用户 ID 和新密码为必填项，且密码长度至少 4 个字符。' });
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
        return res.status(400).json({ success: false, message: '缺少用户 ID。' });
    }
    try {
        await data.deleteUser(userId);
        res.json({ success: true, message: '用户已删除。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '删除用户失败。' });
    }
});

// --- 主要修改开始 (WebDAV 管理 API) ---
app.get('/api/admin/webdav', requireAdmin, (req, res) => {
    const config = storageManager.readConfig();
    res.json(config.webdav || []);
});

app.post('/api/admin/webdav', requireAdmin, async (req, res) => {
    const { id, url, username, password, mount_name } = req.body;
    if (!url || !username || !mount_name) { 
        return res.status(400).json({ success: false, message: 'URL, 用户名和挂载名称为必填项' });
    }
    if (/[^a-zA-Z0-9_-]/.test(mount_name)) {
        return res.status(400).json({ success: false, message: '挂载名称只能包含字母、数字、下划线和连字符。' });
    }

    const config = storageManager.readConfig();
    const isEditing = !!id;

    const nameConflict = config.webdav.find(c => c.mount_name === mount_name && c.id !== id);
    if (nameConflict) {
        return res.status(409).json({ success: false, message: `挂载名称 "${mount_name}" 已被使用。` });
    }

    let oldMountName = null;

    if (isEditing) {
        const index = config.webdav.findIndex(c => c.id === id);
        if (index > -1) {
            oldMountName = config.webdav[index].mount_name;
            config.webdav[index] = { ...config.webdav[index], url, username, mount_name };
            if (password) {
                config.webdav[index].password = password;
            }
        } else {
             return res.status(404).json({ success: false, message: '找不到要更新的设置' });
        }
    } else {
        const newConfig = {
            id: crypto.randomBytes(4).toString('hex'),
            mount_name,
            url,
            username,
            password
        };
        config.webdav.push(newConfig);
    }
    
    if (storageManager.writeConfig(config)) {
        try {
            const users = await data.listAllUsers();
            for (const user of users) {
                const rootFolder = await data.getRootFolder(user.id);
                if (rootFolder) {
                    if (isEditing && oldMountName && oldMountName !== mount_name) {
                        const mountFolder = await data.findFolderByName(oldMountName, rootFolder.id, user.id);
                        if(mountFolder) {
                            await data.renameFolder(mountFolder.id, mount_name, user.id);
                        } else {
                            // 如果旧文件夹不存在，就创建一个新的
                            await data.createFolder(mount_name, rootFolder.id, user.id);
                        }
                    } else if (!isEditing) {
                        await data.createFolder(mount_name, rootFolder.id, user.id);
                    }
                }
            }
             res.json({ success: true, message: 'WebDAV 设置已保存' });
        } catch(dbError) {
             res.status(500).json({ success: false, message: `设置已保存，但更新用户文件夹时出错: ${dbError.message}` });
        }
    } else {
        res.status(500).json({ success: false, message: '写入设置失败' });
    }
});

app.delete('/api/admin/webdav/:id', requireAdmin, async (req, res) => {
    const { id } = req.body; // should be req.params.id for DELETE /api/admin/webdav/:id
    const config = storageManager.readConfig();
    const configIndex = config.webdav.findIndex(c => c.id === id);

    if (configIndex === -1) {
        return res.status(404).json({ success: false, message: '找不到要删除的设置' });
    }
    
    const mountNameToDelete = config.webdav[configIndex].mount_name;
    config.webdav.splice(configIndex, 1);

    if (storageManager.writeConfig(config)) {
         try {
            const users = await data.listAllUsers();
            for (const user of users) {
                const rootFolder = await data.getRootFolder(user.id);
                if (rootFolder) {
                    const mountFolder = await data.findFolderByName(mountNameToDelete, rootFolder.id, user.id);
                    if (mountFolder) {
                        await data.unifiedDelete(mountFolder.id, 'folder', user.id);
                    }
                }
            }
            res.json({ success: true, message: 'WebDAV 设置及相关文件已删除' });
         } catch(dbError) {
            res.status(500).json({ success: false, message: `设置已删除，但清理用户文件夹时出错: ${dbError.message}` });
         }
    } else {
        res.status(500).json({ success: false, message: '删除设置失败' });
    }
});
// --- 主要修改结束 ---


const uploadMiddleware = (req, res, next) => {
    upload.array('files')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, message: '文件大小超出限制。' });
            }
            if (err.code === 'EDQUOT' || err.errno === -122) {
                return res.status(507).json({ success: false, message: '上传失败：磁盘空间不足。' });
            }
            return res.status(500).json({ success: false, message: '上传文件到暂存区时发生错误。' });
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
    const storage = storageManager.getStorage();
    const resolutions = req.body.resolutions ? JSON.parse(req.body.resolutions) : {};
    let relativePaths = req.body.relativePaths;

    if (!relativePaths) {
        relativePaths = req.files.map(file => file.originalname);
    } else if (!Array.isArray(relativePaths)) {
        relativePaths = [relativePaths];
    }

    if (req.files.length !== relativePaths.length) {
        return res.status(400).json({ success: false, message: '上传文件和路径信息不匹配。' });
    }

    const results = [];
    let skippedCount = 0;
    try {
        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const tempFilePath = file.path;
            const relativePath = relativePaths[i];
            
            const action = resolutions[relativePath] || 'upload';

            try {
                if (action === 'skip') {
                    skippedCount++;
                    continue;
                }

                const pathParts = (relativePath || file.originalname).split('/');
                let fileName = pathParts.pop() || file.originalname;
                const folderPathParts = pathParts;

                const targetFolderId = await data.resolvePathToFolderId(initialFolderId, folderPathParts, userId);
                
                if (action === 'overwrite') {
                    const existingItem = await data.findItemInFolder(fileName, targetFolderId, userId);
                    if (existingItem) {
                        await data.unifiedDelete(existingItem.id, existingItem.type, userId);
                    }
                } else if (action === 'rename') {
                    fileName = await data.findAvailableName(fileName, targetFolderId, userId, false);
                } else {
                    const conflict = await data.findItemInFolder(fileName, targetFolderId, userId);
                    if (conflict) {
                        skippedCount++;
                        continue;
                    }
                }

                const result = await storage.upload(tempFilePath, fileName, file.mimetype, userId, targetFolderId, req.body.caption || '');
                results.push(result);

            } finally {
                if (fs.existsSync(tempFilePath)) {
                    await fsp.unlink(tempFilePath).catch(err => {});
                }
            }
        }
        if (results.length === 0 && skippedCount > 0) {
            res.json({ success: true, skippedAll: true, message: '所有文件因冲突而被跳过。' });
        } else {
            res.json({ success: true, results });
        }
    } catch (error) {
        for (const file of req.files) {
            if (fs.existsSync(file.path)) {
                await fsp.unlink(file.path).catch(err => {});
            }
        }
        res.status(500).json({ success: false, message: '处理上传时发生错误: ' + error.message });
    }
});

app.post('/api/text-file', requireLogin, async (req, res) => {
    const { mode, fileId, folderId, fileName, content } = req.body;
    const userId = req.session.userId;
    const storage = storageManager.getStorage();

    if (!fileName || !fileName.endsWith('.txt')) {
        return res.status(400).json({ success: false, message: '文件名无效或不是 .txt 文件' });
    }

    const tempFilePath = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.txt`);

    try {
        await fsp.writeFile(tempFilePath, content, 'utf8');
        let result;

        if (mode === 'edit' && fileId) {
            const filesToUpdate = await data.getFilesByIds([fileId], userId);
            if (filesToUpdate.length > 0) {
                const originalFile = filesToUpdate[0];
                
                if (fileName !== originalFile.fileName) {
                    const conflict = await data.checkFullConflict(fileName, originalFile.folder_id, userId);
                    if (conflict) {
                        await fsp.unlink(tempFilePath).catch(err => {});
                        return res.status(409).json({ success: false, message: '同目录下已存在同名文件或文件夹。' });
                    }
                }
                
                await data.unifiedDelete(originalFile.message_id, 'file', userId);
                result = await storage.upload(tempFilePath, fileName, 'text/plain', userId, originalFile.folder_id);
            } else {
                return res.status(404).json({ success: false, message: '找不到要编辑的原始文件' });
            }
        } else if (mode === 'create' && folderId) {
             const conflict = await data.checkFullConflict(fileName, folderId, userId);
            if (conflict) {
                return res.status(409).json({ success: false, message: '同目录下已存在同名文件或文件夹。' });
            }
            result = await storage.upload(tempFilePath, fileName, 'text/plain', userId, folderId);
        } else {
            return res.status(400).json({ success: false, message: '请求参数无效' });
        }
        res.json({ success: true, fileId: result.fileId });
    } catch (error) {
        res.status(500).json({ success: false, message: '服务器内部错误' });
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
            res.status(404).json({ success: false, message: '找不到文件信息' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '获取文件信息失败' });
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
        res.status(500).json({ success: false, message: "检查文件是否存在时发生内部错误。" });
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
        if (!query) return res.status(400).json({ success: false, message: '需要提供搜索关键字。' });
        
        const contents = await data.searchItems(query, req.session.userId); 
        
        const path = [{ id: null, name: `搜索结果: "${query}"` }];
        res.json({ contents, path });
    } catch (error) { 
        res.status(500).json({ success: false, message: '搜索失败。' }); 
    }
});

app.get('/api/folder/:id', requireLogin, async (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        const contents = await data.getFolderContents(folderId, req.session.userId);
        const path = await data.getFolderPath(folderId, req.session.userId);
        res.json({ contents, path });
    } catch (error) { res.status(500).json({ success: false, message: '读取文件夹内容失败。' }); }
});

app.post('/api/folder', requireLogin, async (req, res) => {
    const { name, parentId } = req.body;
    const userId = req.session.userId;

    if (!name || !parentId) {
        return res.status(400).json({ success: false, message: '缺少文件夹名称或父 ID。' });
    }
    
    try {
        const parentPath = await data.getFolderPath(parentId, userId);
        if (parentPath.length <= 1) { // 根目录的路径长度为1
            return res.status(403).json({ success: false, message: '禁止在根目录下直接创建文件夹。' });
        }

        const conflict = await data.checkFullConflict(name, parentId, userId);
        if (conflict) {
            return res.status(409).json({ success: false, message: '同目录下已存在同名文件或文件夹。' });
        }

        const result = await data.createFolder(name, parentId, userId);
        
        const storage = storageManager.getStorage();
        if (storage.type === 'webdav' && storage.createDirectory) {
            const newFolderPath = await data.getFolderPath(result.id, userId);
            await storage.createDirectory(newFolderPath, userId);
        }

        res.json(result);
    } catch (error) {
         res.status(500).json({ success: false, message: error.message || '处理文件夹时发生错误。' });
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
        
        let totalMoved = 0;
        let totalSkipped = 0;
        const errors = [];
        
        for (const itemId of itemIds) {
            try {
                const items = await data.getItemsByIds([itemId], userId);
                if (items.length === 0) {
                    totalSkipped++;
                    continue; 
                }
                
                const item = items[0];
                const report = await data.moveItem(item.id, item.type, targetFolderId, userId, { resolutions });
                totalMoved += report.moved;
                totalSkipped += report.skipped;
                if (report.errors > 0) {
                    errors.push(`项目 "${item.name}" 处理失败。`);
                }

            } catch (err) {
                errors.push(err.message);
            }
        }
        
        let message = "操作完成。";
        if (errors.length > 0) {
            message = `操作完成，但出现错误: ${errors.join(', ')}`;
        } else if (totalMoved > 0 && totalSkipped > 0) {
            message = `操作完成，${totalMoved} 个项目已移动，${totalSkipped} 个项目被跳过。`;
        } else if (totalMoved === 0 && totalSkipped > 0) {
            message = "所有选定项目均被跳过。";
        } else if (totalMoved > 0) {
            message = `${totalMoved} 个项目移动成功。`;
        }

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
            return res.status(404).send('找不到任何可下载的文件');
        }
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        res.attachment('download.zip');
        archive.pipe(res);

        for (const file of filesToArchive) {
            const stream = await storage.stream(file.file_id, userId);
            archive.append(stream, { name: file.path });
        }
        await archive.finalize();
    } catch (error) {
        res.status(500).send('压缩文件时发生错误');
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
        res.status(500).json({ success: false, message: '在服务器上创建分享链接时发生错误。' });
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

// --- Scanner Endpoints ---
app.post('/api/scan/webdav', requireAdmin, async (req, res) => {
    const { userId, mountId } = req.body; // 添加 mountId
    const log = [];
    try {
        if (!userId) throw new Error('未提供用户 ID');
        if (!mountId) throw new Error('未提供要扫描的挂载点 ID');

        const { createClient } = require('webdav');
        const config = storageManager.readConfig();
        const mountConfig = config.webdav.find(c => c.id === mountId);
        
        if (!mountConfig) {
            throw new Error(`找不到 ID 为 ${mountId} 的 WebDAV 挂载点设置`);
        }
        
        const client = createClient(mountConfig.url, {
            username: mountConfig.username,
            password: mountConfig.password
        });
        
        log.push({ message: `开始扫描挂载点: ${mountConfig.mount_name}`, type: 'info' });

        async function scanWebdavDirectory(remotePath) {
            const contents = await client.getDirectoryContents(remotePath, { deep: true });
            for (const item of contents) {
                if (item.type === 'file') {
                    // file_id 应该是 /mount_name/path/to/file
                    const fileIdToFind = path.posix.join('/', mountConfig.mount_name, item.filename);
                    const existing = await data.findFileByFileId(fileIdToFind, userId);
                     if (existing) {
                        log.push({ message: `已存在: ${fileIdToFind}，跳过。`, type: 'info' });
                    } else {
                        // 数据库中的文件夹路径应该是 /mount_name/path
                        const folderPathInDb = path.posix.join('/', mountConfig.mount_name, path.dirname(item.filename));
                        const folderId = await data.findOrCreateFolderByPath(folderPathInDb, userId);
                        
                        const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
                        await data.addFile({
                            message_id: messageId,
                            fileName: item.basename,
                            mimetype: item.mime || 'application/octet-stream',
                            size: item.size,
                            file_id: fileIdToFind,
                            date: new Date(item.lastmod).getTime(),
                        }, folderId, userId, 'webdav');
                        log.push({ message: `已导入: ${fileIdToFind}`, type: 'success' });
                    }
                }
            }
        }
        
        await scanWebdavDirectory('/');
        log.push({ message: `挂载点 ${mountConfig.mount_name} 扫描完成。`, type: 'success' });
        res.json({ success: true, log });

    } catch (error) {
        let errorMessage = error.message;
        if (error.response && error.response.status === 403) {
            errorMessage = '访问被拒绝 (403 Forbidden)。这通常意味着您的 WebDAV 服务器不允许列出目录内容。请检查您帐号的权限，确保它有读取和浏览目录的权限。';
            log.push({ message: '扫描失败：无法列出远程目录内容。', type: 'error' });
        }
        log.push({ message: `详细错误: ${errorMessage}`, type: 'error' });
        res.status(500).json({ success: false, message: errorMessage, log });
    }
});

// --- Share Routes ---
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
            res.render('share-view', { file: fileInfo, downloadUrl, textContent });
        } else {
            res.status(404).render('share-error', { message: '此分享链接无效或已过期。' });
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
            res.status(404).render('share-error', { message: '此分享链接无效或已过期。' });
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
        res.end(); // 确保响应结束
    }).pipe(res);
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


app.listen(PORT, () => console.log(`✅ 服务器已在 http://localhost:${PORT} 上运行`));
