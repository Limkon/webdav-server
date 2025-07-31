const db = require('./database.js');
const bcrypt = require('bcrypt');
const webdav = require('./storage/webdav.js'); // 确保路径正确
const path = require('path');

// --- 使用者管理 (维持不变) ---
function findUserByName(username) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}
function findUserById(id) {
     return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}
function changeUserPassword(userId, newHashedPassword) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE users SET password = ? WHERE id = ?`;
        db.run(sql, [newHashedPassword, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}
function listAllUsers() {
    return new Promise((resolve, reject) => {
        const sql = `SELECT id, username FROM users ORDER BY username ASC`;
        db.all(sql, [], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}


// --- WebDAV 设定管理 (新生) ---
function getWebdavConfigs(userId) {
    return new Promise((resolve, reject) => {
        db.all("SELECT id, name, url, username FROM webdav_configs WHERE user_id = ?", [userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function getWebdavConfigById(id, userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM webdav_configs WHERE id = ? AND user_id = ?", [id, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function getWebdavConfigByName(name, userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM webdav_configs WHERE name = ? AND user_id = ?", [name, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function addOrUpdateWebdavConfig(configData) {
    const { id, user_id, name, url, username, password } = configData;
    return new Promise((resolve, reject) => {
        // 使用 bcrypt 同步加密密码
        const salt = bcrypt.genSaltSync(10);
        const hashedPassword = bcrypt.hashSync(password, salt);

        if (id) { // 更新
            const fieldsToUpdate = { name, url, username };
            if (password) {
                fieldsToUpdate.password = hashedPassword;
            }
            const fieldPlaceholders = Object.keys(fieldsToUpdate).map(k => `${k} = ?`).join(', ');
            const values = [...Object.values(fieldsToUpdate), id, user_id];
            const sql = `UPDATE webdav_configs SET ${fieldPlaceholders} WHERE id = ? AND user_id = ?`;
            
            db.run(sql, values, function(err) {
                if (err) return reject(err);
                webdav.resetClients();
                resolve({ id });
            });
        } else { // 新增
            const sql = `INSERT INTO webdav_configs (user_id, name, url, username, password) VALUES (?, ?, ?, ?, ?)`;
            db.run(sql, [user_id, name, url, username, hashedPassword], function(err) {
                if (err) return reject(err);
                webdav.resetClients();
                resolve({ id: this.lastID });
            });
        }
    });
}

function deleteWebdavConfig(id, userId) {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM webdav_configs WHERE id = ? AND user_id = ?", [id, userId], function(err) {
            if (err) return reject(err);
            webdav.resetClients();
            resolve({ changes: this.changes });
        });
    });
}


// --- 虚拟档案系统 API (重构) ---

async function getFolderContents(virtualPath, userId) {
    const pathParts = virtualPath.split('/').filter(Boolean);

    // 根目录：列出所有 WebDAV 挂载点
    if (pathParts.length === 0) {
        const configs = await getWebdavConfigs(userId);
        const folders = configs.map(c => ({
            id: c.name, // 使用挂载名称作为虚拟 ID
            name: c.name,
            type: 'folder'
        }));
        return { folders, files: [] };
    }

    // 子目录：从对应的 WebDAV 获取内容
    const { mount, remotePath } = await webdav.parsePath(virtualPath, userId);
    const client = await webdav.getClient(mount.id, userId);
    const contents = await client.getDirectoryContents(remotePath, { deep: false, details: true });

    const folders = [];
    const files = [];

    contents.forEach(item => {
        // 建立一个唯一的虚拟ID，用于前端操作
        const virtualId = Buffer.from(path.posix.join(virtualPath, item.basename)).toString('base64');
        if (item.type === 'directory') {
            folders.push({
                id: virtualId,
                name: item.basename,
                type: 'folder',
                date: item.lastmod ? new Date(item.lastmod).toISOString() : null,
                size: item.size
            });
        } else {
            files.push({
                id: virtualId,
                name: item.basename,
                fileName: item.basename,
                type: 'file',
                date: item.lastmod ? new Date(item.lastmod).toISOString() : null,
                size: item.size,
                mimetype: item.mime
            });
        }
    });
    return { folders, files };
}

async function getFolderPath(virtualPath, userId) {
    const pathParts = virtualPath.split('/').filter(Boolean);
    const breadcrumb = [{ id: '/', name: '根目录' }];

    if (pathParts.length > 0) {
        let currentPath = '';
        for (const part of pathParts) {
            currentPath = path.posix.join(currentPath, part);
            breadcrumb.push({ id: currentPath, name: part });
        }
    }
    return breadcrumb;
}

async function createFolder(virtualPath, userId) {
    const { mount, remotePath } = await webdav.parsePath(virtualPath, userId);
    if (!mount || remotePath === '/') throw new Error("无法在根目录或挂载点本身建立资料夹");

    const client = await webdav.getClient(mount.id, userId);
    if (await client.exists(remotePath)) {
        throw new Error('同目录下已存在同名档案或资料夹。');
    }
    await client.createDirectory(remotePath);
    return { success: true };
}

async function renameItem(virtualPath, newName, userId) {
    const { mount, remotePath } = await webdav.parsePath(virtualPath, userId);
    if (!mount || remotePath === '/') throw new Error("无法重新命名挂载点");

    const client = await webdav.getClient(mount.id, userId);
    const newRemotePath = path.posix.join(path.posix.dirname(remotePath), newName);

    if (await client.exists(newRemotePath)) {
        throw new Error('目标名称已存在。');
    }
    await client.moveFile(remotePath, newRemotePath);
    return { success: true };
}

async function moveItems(sourceVirtualPaths, targetVirtualDir, userId) {
    if (!Array.isArray(sourceVirtualPaths) || sourceVirtualPaths.length === 0) {
        return { success: true };
    }

    // 验证所有来源是否在同一个挂载点
    const firstSource = await webdav.parsePath(sourceVirtualPaths[0], userId);
    const sourceMountId = firstSource.mount.id;
    for (let i = 1; i < sourceVirtualPaths.length; i++) {
        const source = await webdav.parsePath(sourceVirtualPaths[i], userId);
        if (source.mount.id !== sourceMountId) {
            throw new Error("不允许跨 WebDAV 挂载点移动档案。");
        }
    }
    
    // 验证目标是否为同一个挂载点
    const { mount: targetMount, remotePath: targetRemoteDir } = await webdav.parsePath(targetVirtualDir, userId);
    if (sourceMountId !== targetMount.id) {
        throw new Error("不允许跨 WebDAV 挂载点移动档案。");
    }
    
    const client = await webdav.getClient(sourceMountId, userId);

    for (const sourcePath of sourceVirtualPaths) {
         const { remotePath: sourceRemotePath } = await webdav.parsePath(sourcePath, userId);
         const sourceName = path.posix.basename(sourceRemotePath);
         const finalTargetPath = path.posix.join(targetRemoteDir, sourceName);
         await client.moveFile(sourceRemotePath, finalTargetPath);
    }
    
    return { success: true };
}

module.exports = {
    findUserByName, findUserById, changeUserPassword, listAllUsers,
    getWebdavConfigs, getWebdavConfigById, getWebdavConfigByName, addOrUpdateWebdavConfig, deleteWebdavConfig,
    getFolderContents, getFolderPath, createFolder, renameItem, moveItems
};
