const db = require('./database.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

// --- User Functions ---
function createUser(username, hashedPassword) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO users (username, password, is_admin) VALUES (?, ?, 0)`;
        db.run(sql, [username, hashedPassword], function(err) {
            if (err) return reject(err);
            resolve({ id: this.lastID, username });
        });
    });
}

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
        db.run(`UPDATE users SET password = ? WHERE id = ?`, [newHashedPassword, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}

function listNormalUsers() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT id, username FROM users WHERE is_admin = 0 ORDER BY username ASC`, [], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function listAllUsers() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT id, username FROM users ORDER BY username ASC`, [], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function deleteUserAndData(userId) {
    // This will cascade delete all related data due to FOREIGN KEY ON DELETE CASCADE
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM users WHERE id = ? AND is_admin = 0`, [userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}


// --- WebDAV Config Functions ---
function getWebdavConfigsForUser(userId) {
    return new Promise((resolve, reject) => {
        db.all("SELECT id, mount_name, url, username FROM webdav_configs WHERE user_id = ? ORDER BY mount_name", [userId], (err, rows) => {
            if(err) return reject(err);
            resolve(rows);
        });
    });
}

function getWebdavConfigById(configId, userId = null) {
    return new Promise((resolve, reject) => {
        const sql = userId 
            ? "SELECT * FROM webdav_configs WHERE id = ? AND user_id = ?"
            : "SELECT * FROM webdav_configs WHERE id = ?";
        const params = userId ? [configId, userId] : [configId];
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function saveWebdavConfig(config) {
    const { id, userId, mount_name, url, username, password } = config;
    const storage = require('./storage').getStorage();
    
    if (id) { // Update
        const existing = await getWebdavConfigById(id);
        if (!existing) throw new Error('找不到要更新的设定');
        if (existing.mount_name !== mount_name) throw new Error('不允许修改挂载点名称');
        
        const sql = password 
            ? `UPDATE webdav_configs SET url = ?, username = ?, password = ? WHERE id = ? AND user_id = ?`
            : `UPDATE webdav_configs SET url = ?, username = ? WHERE id = ? AND user_id = ?`;
        const params = password ? [url, username, password, id, userId] : [url, username, id, userId];

        return new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if(err) return reject(err);
                if (this.changes === 0) return reject(new Error('更新失败或无权操作'));
                resolve({ success: true, message: '更新成功' });
            });
        });
    } else { // Create
        const rootFolder = await getRootFolder(userId);
        if (!rootFolder) throw new Error('找不到使用者根目录');
        
        const conflict = await findFolderByName(mount_name, rootFolder.id, userId);
        if (conflict) throw new Error('根目录下已存在同名挂载点资料夹');

        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                const insertSql = `INSERT INTO webdav_configs (user_id, mount_name, url, username, password) VALUES (?, ?, ?, ?, ?)`;
                db.run(insertSql, [userId, mount_name, url, username, password], function(err) {
                    if (err) {
                        db.run('ROLLBACK');
                        return reject(new Error('储存 WebDAV 设定失败，挂载点名称可能重复。'));
                    }
                    const configId = this.lastID;
                    const folderSql = `INSERT INTO folders (name, parent_id, user_id, webdav_config_id) VALUES (?, ?, ?, ?)`;
                    db.run(folderSql, [mount_name, rootFolder.id, userId, configId], function(err) {
                        if (err) {
                            db.run('ROLLBACK');
                            return reject(err);
                        }
                        db.run('COMMIT', (err) => {
                            if(err) return reject(err);
                            resolve({ success: true, message: '新增成功', id: configId });
                        });
                    });
                });
            });
        });
    }
}

function deleteWebdavConfig(configId) {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM webdav_configs WHERE id = ?", [configId], function(err) {
            if (err) return reject(err);
            if (this.changes === 0) return reject(new Error('找不到要删除的设定'));
            resolve({ success: true, message: '删除成功' });
        });
    });
}

// --- Folder & File Functions ---
function createFolder(name, parentId, userId) {
    return new Promise(async (resolve, reject) => {
        try {
            // 继承父资料夹的 webdav_config_id
            let webdavConfigId = null;
            if (parentId) {
                const parentFolder = await new Promise((res, rej) => db.get("SELECT webdav_config_id FROM folders WHERE id = ?", [parentId], (e, r) => e ? rej(e) : res(r)));
                if (parentFolder) {
                    webdavConfigId = parentFolder.webdav_config_id;
                }
            }
            const sql = `INSERT INTO folders (name, parent_id, user_id, webdav_config_id) VALUES (?, ?, ?, ?)`;
            db.run(sql, [name, parentId, userId, webdavConfigId], function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) return reject(new Error('同目录下已存在同名资料夹或档案。'));
                    return reject(err);
                }
                resolve({ success: true, id: this.lastID });
            });
        } catch (error) {
            reject(error);
        }
    });
}

function getFolderContents(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sqlFolders = `SELECT id, name, parent_id, 'folder' as type FROM folders WHERE parent_id = ? AND user_id = ? ORDER BY name ASC`;
        const sqlFiles = `SELECT *, message_id as id, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ? ORDER BY name ASC`;
        let contents = { folders: [], files: [] };
        db.all(sqlFolders, [folderId, userId], (err, folders) => {
            if (err) return reject(err);
            contents.folders = folders;
            db.all(sqlFiles, [folderId, userId], (err, files) => {
                if (err) return reject(err);
                contents.files = files;
                resolve(contents);
            });
        });
    });
}

function getFolderPath(folderId, userId) {
    let pathArr = [];
    return new Promise((resolve, reject) => {
        function findParent(id) {
            if (!id) return resolve(pathArr.reverse());
            db.get("SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?", [id, userId], (err, folder) => {
                if (err || !folder) return resolve(pathArr.reverse());
                pathArr.push({ id: folder.id, name: folder.name });
                findParent(folder.parent_id);
            });
        }
        findParent(folderId);
    });
}

function getAllFolders(userId) {
    return new Promise((resolve, reject) => {
        db.all("SELECT id, name, parent_id FROM folders WHERE user_id = ? ORDER BY parent_id, name ASC", [userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getRootFolder(userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function findFolderByName(name, parentId, userId) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`, [name, parentId, userId], (err, row) => {
            err ? reject(err) : resolve(row);
        });
    });
}

async function findOrCreateFolderByPath(fullPath, userId, webdavConfigId) {
    const root = await getRootFolder(userId);
    if (!root) throw new Error('User root folder not found.');
    let parentId = root.id;

    // First level is the mount point
    const mountName = (await getWebdavConfigById(webdavConfigId)).mount_name;
    let mountFolder = await findFolderByName(mountName, parentId, userId);
    if (!mountFolder) throw new Error(`Mount point folder '${mountName}' not found in DB.`);
    parentId = mountFolder.id;

    const pathParts = fullPath.split('/').filter(p => p);
    for (const part of pathParts) {
        let folder = await findFolderByName(part, parentId, userId);
        if (!folder) {
            const result = await createFolder(part, parentId, userId);
            parentId = result.id;
        } else {
            parentId = folder.id;
        }
    }
    return parentId;
}

// ... (keep other functions like searchItems, getItemsByIds, etc.)
// ... (Make sure to adapt them if they need webdav_config_id)

async function renameItem(itemId, newName, type, userId) {
    // This is a simplified version. A full implementation would need to handle storage renaming too.
    const table = type === 'folder' ? 'folders' : 'files';
    const idColumn = type === 'folder' ? 'id' : 'message_id';
    const nameColumn = type === 'folder' ? 'name' : 'fileName';

    const item = await new Promise((res, rej) => db.get(`SELECT * FROM ${table} WHERE ${idColumn} = ?`, [itemId], (e, r) => e ? rej(e) : res(r)));
    if (!item) return { success: false, message: '项目未找到' };

    const parentId = type === 'folder' ? item.parent_id : item.folder_id;
    if (await checkFullConflict(newName, parentId, userId)) {
        return { success: false, message: '同名项目已存在' };
    }
    
    // In a real scenario, you would call storageManager.rename here
    
    return new Promise((resolve, reject) => {
        db.run(`UPDATE ${table} SET ${nameColumn} = ? WHERE ${idColumn} = ? AND user_id = ?`, [newName, itemId, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true });
        });
    });
}
async function isWebdavMount(folderId, userId) {
    const folder = await new Promise((res, rej) => db.get("SELECT webdav_config_id FROM folders WHERE id = ? AND user_id = ?", [folderId, userId], (e, r) => e ? rej(e) : res(r)));
    return !!folder && !!folder.webdav_config_id;
}
async function getWebdavConfigForFolder(folderId, userId) {
    const folder = await new Promise((res, rej) => db.get("SELECT webdav_config_id FROM folders WHERE id = ? AND user_id = ?", [folderId, userId], (e, r) => e ? rej(e) : res(r)));
    if (!folder || !folder.webdav_config_id) return null;
    return getWebdavConfigById(folder.webdav_config_id, userId);
}


// Export all functions
module.exports = {
    createUser,
    findUserByName,
    findUserById,
    changeUserPassword,
    listNormalUsers,
    listAllUsers,
    deleteUserAndData,
    getWebdavConfigsForUser,
    getWebdavConfigById,
    saveWebdavConfig,
    deleteWebdavConfig,
    createFolder,
    getFolderContents,
    getFolderPath,
    getAllFolders,
    getRootFolder,
    findFolderByName,
    findOrCreateFolderByPath,
    searchItems,
    getItemsByIds,
    isWebdavMount,
    getWebdavConfigForFolder,
    renameItem,
    // Add other existing functions here...
    addFile, getFilesByIds, getFileByShareToken, getFolderByShareToken, findFileInSharedFolder,
    createShareLink, getActiveShares, cancelShare, unifiedDelete, checkFullConflict, findItemInFolder,
    findAvailableName, resolvePathToFolderId, findFileByFileId
};
