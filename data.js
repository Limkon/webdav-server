const db = require('./database.js');
const crypto = require('crypto');
const path = require('path');

// --- 使用者管理 ---
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

function deleteUser(userId) {
    return new Promise((resolve, reject) => {
        // 删除使用者会透过外键 CASCADE 自动删除其所有资料夹和档案
        const sql = `DELETE FROM users WHERE id = ? AND is_admin = 0`;
        db.run(sql, [userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}


// --- 档案和资料夹搜寻 ---
function searchItems(query, userId) {
    return new Promise((resolve, reject) => {
        const searchQuery = `%${query}%`;
        const sqlFolders = `
            SELECT id, name, parent_id, mount_id, 'folder' as type
            FROM folders
            WHERE name LIKE ? AND user_id = ? AND parent_id IS NOT NULL
            ORDER BY name ASC`;

        const sqlFiles = `
            SELECT *, message_id as id, fileName as name, 'file' as type
            FROM files
            WHERE fileName LIKE ? AND user_id = ?
            ORDER BY date DESC`;

        let contents = { folders: [], files: [] };

        db.all(sqlFolders, [searchQuery, userId], (err, folders) => {
            if (err) return reject(err);
            contents.folders = folders;
            db.all(sqlFiles, [searchQuery, userId], (err, files) => {
                if (err) return reject(err);
                contents.files = files.map(f => ({ ...f, message_id: f.id }));
                resolve(contents);
            });
        });
    });
}

// --- 资料夹与档案操作 ---
function getItemsByIds(itemIds, userId) {
    return new Promise((resolve, reject) => {
        if (!itemIds || itemIds.length === 0) return resolve([]);
        const placeholders = itemIds.map(() => '?').join(',');
        const sql = `
            SELECT id, name, mount_id, 'folder' as type FROM folders WHERE id IN (${placeholders}) AND user_id = ?
            UNION ALL
            SELECT message_id as id, fileName as name, mount_id, 'file' as type FROM files WHERE message_id IN (${placeholders}) AND user_id = ?
        `;
        db.all(sql, [...itemIds, userId, ...itemIds, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function getFolderContents(folderId, userId) {
    const root = await getRootFolder(userId);

    // 如果是根目录，则显示 WebDAV 挂载点
    if (folderId === root.id) {
        const mounts = await new Promise((resolve, reject) => {
            db.all("SELECT id, name FROM webdav_mounts ORDER BY name ASC", [], (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });

        const virtualFolders = await Promise.all(mounts.map(async mount => {
            const folder = await findFolderByName(mount.name, folderId, userId);
            return {
                id: folder ? folder.id : -1, // 如果资料库中还未建立对应目录，给个假ID
                name: mount.name,
                parent_id: folderId,
                mount_id: mount.id,
                type: 'folder'
            };
        }));
        
        return { folders: virtualFolders, files: [] }; // 根目录没有档案
    }

    // 如果是子目录
    return new Promise((resolve, reject) => {
        const sqlFolders = `SELECT id, name, parent_id, mount_id, 'folder' as type FROM folders WHERE parent_id = ? AND user_id = ? ORDER BY name ASC`;
        const sqlFiles = `SELECT *, message_id as id, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ? ORDER BY name ASC`;
        let contents = { folders: [], files: [] };
        db.all(sqlFolders, [folderId, userId], (err, folders) => {
            if (err) return reject(err);
            contents.folders = folders;
            db.all(sqlFiles, [folderId, userId], (err, files) => {
                if (err) return reject(err);
                contents.files = files.map(f => ({ ...f, message_id: f.id }));
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
                if (err) return reject(err);
                if (folder) {
                    pathArr.push({ id: folder.id, name: folder.name });
                    findParent(folder.parent_id);
                } else {
                    resolve(pathArr.reverse());
                }
            });
        }
        findParent(folderId);
    });
}

function createFolder(name, parentId, userId, mountId = null) {
    const sql = `INSERT INTO folders (name, parent_id, user_id, mount_id) VALUES (?, ?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [name, parentId, userId, mountId], function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return reject(new Error('同目录下已存在同名资料夹。'));
                return reject(err);
            }
            resolve({ success: true, id: this.lastID });
        });
    });
}

function findFolderByName(name, parentId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`;
        db.get(sql, [name, parentId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function getFolderInfo(folderId, userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM folders WHERE id = ? AND user_id = ?", [folderId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function moveItems(fileIds, folderIds, targetFolderId, userId) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");

            const promises = [];

            if (fileIds && fileIds.length > 0) {
                const filePlaceholders = fileIds.map(() => '?').join(',');
                const moveFilesSql = `UPDATE files SET folder_id = ? WHERE message_id IN (${filePlaceholders}) AND user_id = ?`;
                promises.push(new Promise((res, rej) => {
                    db.run(moveFilesSql, [targetFolderId, ...fileIds, userId], (err) => err ? rej(err) : res());
                }));
            }

            if (folderIds && folderIds.length > 0) {
                const folderPlaceholders = folderIds.map(() => '?').join(',');
                const moveFoldersSql = `UPDATE folders SET parent_id = ? WHERE id IN (${folderPlaceholders}) AND user_id = ?`;
                 promises.push(new Promise((res, rej) => {
                    db.run(moveFoldersSql, [targetFolderId, ...folderIds, userId], (err) => err ? rej(err) : res());
                }));
            }

            Promise.all(promises)
                .then(() => {
                    db.run("COMMIT;", (err) => {
                        if (err) reject(err);
                        else resolve({ success: true });
                    });
                })
                .catch((err) => {
                    db.run("ROLLBACK;", () => reject(err));
                });
        });
    });
}

async function getFolderDeletionData(folderId, userId) {
    let filesToDelete = [];
    let foldersToDeleteWithPaths = [];
    const allUserFolders = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM folders WHERE user_id = ?", [userId], (err, rows) => err ? reject(err) : resolve(rows));
    });
    const folderMap = new Map(allUserFolders.map(f => [f.id, f]));

    function buildPath(fId) {
        let pathParts = [];
        let current = folderMap.get(fId);
        while(current && current.parent_id) {
            pathParts.unshift(current.name);
            current = folderMap.get(current.parent_id);
        }
        return '/' + pathParts.join('/');
    }

    async function findContentsRecursive(currentFolderId) {
        const sqlFiles = `SELECT * FROM files WHERE folder_id = ? AND user_id = ?`;
        const files = await new Promise((res, rej) => db.all(sqlFiles, [currentFolderId, userId], (err, rows) => err ? rej(err) : res(rows)));
        filesToDelete.push(...files);
        
        foldersToDeleteWithPaths.push({
            id: currentFolderId,
            path: buildPath(currentFolderId),
            mount_id: folderMap.get(currentFolderId)?.mount_id
        });

        const subFolders = allUserFolders.filter(f => f.parent_id === currentFolderId);
        for (const subFolder of subFolders) {
            await findContentsRecursive(subFolder.id);
        }
    }

    await findContentsRecursive(folderId);
    return { files: filesToDelete, folders: foldersToDeleteWithPaths };
}

function executeDeletion(fileIds, folderIds, userId) {
    return new Promise((resolve, reject) => {
        if (fileIds.length === 0 && folderIds.length === 0) return resolve({ success: true });
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            const promises = [];
            
            if (fileIds.length > 0) {
                const filePlaceholders = fileIds.map(() => '?').join(',');
                const sql = `DELETE FROM files WHERE message_id IN (${filePlaceholders}) AND user_id = ?`;
                promises.push(new Promise((res, rej) => db.run(sql, [...fileIds, userId], (err) => err ? rej(err) : res())));
            }
            if (folderIds.length > 0) {
                const folderPlaceholders = folderIds.map(() => '?').join(',');
                const sql = `DELETE FROM folders WHERE id IN (${folderPlaceholders}) AND user_id = ?`;
                promises.push(new Promise((res, rej) => db.run(sql, [...folderIds, userId], (err) => err ? rej(err) : res())));
            }

            Promise.all(promises)
                .then(() => db.run("COMMIT;", (err) => err ? reject(err) : resolve({ success: true })))
                .catch((err) => db.run("ROLLBACK;", () => reject(err)));
        });
    });
}

function addFile(fileData, folderId, userId, storageType, mountId) {
    const { message_id, fileName, mimetype, file_id, thumb_file_id, date, size } = fileData;
    const sql = `INSERT INTO files (message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type, mount_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folderId, userId, storageType, mountId], function(err) {
            if (err) reject(err);
            else resolve({ success: true, fileId: this.lastID });
        });
    });
}

function getFilesByIds(messageIds, userId) {
    if (!messageIds || messageIds.length === 0) {
        return Promise.resolve([]);
    }
    const placeholders = messageIds.map(() => '?').join(',');
    const sql = `SELECT * FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.all(sql, [...messageIds, userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function renameFile(messageId, newFileName, userId) {
    const sql = `UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFileName, messageId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '文件未找到。' });
            else resolve({ success: true });
        });
    });
}

function renameFolder(folderId, newFolderName, userId) {
    const sql = `UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFolderName, folderId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '资料夹未找到。' });
            else resolve({ success: true });
        });
    });
}


function deleteFilesByIds(messageIds, userId) {
    if (!messageIds || messageIds.length === 0) {
        return Promise.resolve({ success: true, changes: 0 });
    }
    const placeholders = messageIds.map(() => '?').join(',');
    const sql = `DELETE FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [...messageIds, userId], function(err) {
            if (err) reject(err);
            else resolve({ success: true, changes: this.changes });
        });
    });
}

function checkFullConflict(name, folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT name FROM (
                SELECT name FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?
                UNION ALL
                SELECT fileName as name FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?
            ) LIMIT 1
        `;
        db.get(sql, [name, folderId, userId, name, folderId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(!!row);
        });
    });
}

function findFileInFolder(fileName, folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT message_id FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?`;
        db.get(sql, [fileName, folderId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function findFileByFileIdAndMount(fileId, mountId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT message_id FROM files WHERE file_id = ? AND mount_id = ? AND user_id = ?`;
        db.get(sql, [fileId, mountId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

// --- 关键修正 ---
function getRootFolder(userId) {
    return new Promise((resolve, reject) => {
        // 同时选择 id 和 user_id
        db.get("SELECT id, user_id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function findOrCreateFolderByPath(fullPath, userId) {
    if (!fullPath || fullPath === '/') {
        const root = await getRootFolder(userId);
        return root.id;
    }
    const pathParts = fullPath.split('/').filter(p => p);
    let parentId = (await getRootFolder(userId)).id;
    let mountId = null;

    for (let i = 0; i < pathParts.length; i++) {
        const part = pathParts[i];
        let folder = await findFolderByName(part, parentId, userId);
        if (folder) {
            parentId = folder.id;
            if (i === 0) mountId = folder.mount_id; // 如果是第一层目录（挂载点），记录 mountId
        } else {
            // 如果是第一层目录（挂载点），它应该已经由系统建立
            if (i === 0) {
                 const mount = await new Promise((resolve, reject) => {
                     db.get("SELECT id FROM webdav_mounts WHERE name = ?", [part], (err, row) => err ? reject(err) : resolve(row));
                 });
                 if (!mount) throw new Error(`找不到名为 ${part} 的挂载点设定`);
                 mountId = mount.id;
            }
            const result = await createFolder(part, parentId, userId, mountId);
            parentId = result.id;
        }
    }
    return parentId;
}

module.exports = {
    createUser,
    findUserByName,
    findUserById,
    changeUserPassword,
    listAllUsers,
    deleteUser,
    searchItems,
    getFolderContents,
    getFolderPath,
    createFolder,
    findFolderByName,
    getItemsByIds,
    moveItems,
    getFolderDeletionData,
    executeDeletion,
    addFile,
    getFilesByIds,
    renameFile,
    renameFolder,
    deleteFilesByIds,
    checkFullConflict,
    findFileInFolder,
    findFileByFileIdAndMount,
    getRootFolder,
    findOrCreateFolderByPath,
    getFolderInfo
};
