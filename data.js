// data.js
const db = require('./database.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { getStorage } = require('./storage');

const UPLOAD_DIR = path.resolve(__dirname, 'data', 'uploads');

// --- 輔助函數：日誌記錄 ---
function log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [DATA] [${level.toUpperCase()}] ${message}`, ...args);
}

async function getWebdavPathInfo(folderId, userId) {
    if (!folderId) {
         throw new Error("无效的 folderId");
    }
    const pathParts = await getFolderPath(folderId, userId);
    if (pathParts.length <= 1) { 
        throw new Error("操作无效：不能直接在根目录进行文件操作。");
    }
    const mountName = pathParts[1].name;
    const remotePath = '/' + pathParts.slice(2).map(p => p.name).join('/');
    log('debug', `getWebdavPathInfo: folderId=${folderId}, mountName=${mountName}, remotePath=${remotePath}`);
    return { mountName, remotePath: remotePath || '/' };
}

function getWebdavPathInfoFromFileId(file_id) {
    const normalizedPath = path.posix.normalize(String(file_id)).replace(/^\//, '');
    const parts = normalizedPath.split('/');
    const mountName = parts[0];
    const remotePath = '/' + parts.slice(1).join('/');
    return { mountName, remotePath };
}

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

function listNormalUsers() {
    return new Promise((resolve, reject) => {
        const sql = `SELECT id, username FROM users WHERE is_admin = 0 ORDER BY username ASC`;
        db.all(sql, [], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
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


async function deleteUser(userId) {
    const userUploadDir = path.join(UPLOAD_DIR, String(userId));
    try {
        await fs.rm(userUploadDir, { recursive: true, force: true });
    } catch (error) {
        if (error.code !== 'ENOENT') {
            //
        }
    }
    
    return new Promise((resolve, reject) => {
        const sql = `DELETE FROM users WHERE id = ? AND is_admin = 0`;
        db.run(sql, [userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}


function searchItems(query, userId) {
    return new Promise((resolve, reject) => {
        const searchQuery = `%${query}%`;
        const sqlFolders = `
            SELECT id, name, parent_id, 'folder' as type
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

function getItemsByIds(itemIds, userId) {
    return new Promise((resolve, reject) => {
        if (!itemIds || itemIds.length === 0) return resolve([]);
        const placeholders = itemIds.map(() => '?').join(',');
        const sql = `
            SELECT id, name, parent_id, 'folder' as type, null as storage_type, null as file_id
            FROM folders 
            WHERE id IN (${placeholders}) AND user_id = ?
            UNION ALL
            SELECT message_id as id, fileName as name, folder_id as parent_id, 'file' as type, storage_type, file_id
            FROM files 
            WHERE message_id IN (${placeholders}) AND user_id = ?
        `;
        db.all(sql, [...itemIds, userId, ...itemIds, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function getChildrenOfFolder(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT id, name, 'folder' as type FROM folders WHERE parent_id = ? AND user_id = ?
            UNION ALL
            SELECT message_id as id, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ?
        `;
        db.all(sql, [folderId, userId, folderId, userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function getAllDescendantFolderIds(folderId, userId) {
    let descendants = [];
    let queue = [folderId];
    const visited = new Set(queue);

    while (queue.length > 0) {
        const currentId = queue.shift();
        const sql = `SELECT id FROM folders WHERE parent_id = ? AND user_id = ?`;
        const children = await new Promise((resolve, reject) => {
            db.all(sql, [currentId, userId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        for (const child of children) {
            if (!visited.has(child.id)) {
                visited.add(child.id);
                descendants.push(child.id);
                queue.push(child.id);
            }
        }
    }
    return descendants;
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
                contents.files = files.map(f => ({ ...f, message_id: f.id }));
                resolve(contents);
            });
        });
    });
}

async function getFilesRecursive(folderId, userId, currentPath = '') {
    let allFiles = [];
    const sqlFiles = "SELECT * FROM files WHERE folder_id = ? AND user_id = ?";
    const files = await new Promise((res, rej) => db.all(sqlFiles, [folderId, userId], (err, rows) => err ? rej(err) : res(rows)));
    for (const file of files) {
        allFiles.push({ ...file, path: path.posix.join(currentPath, file.fileName) });
    }

    const sqlFolders = "SELECT id, name FROM folders WHERE parent_id = ? AND user_id = ?";
    const subFolders = await new Promise((res, rej) => db.all(sqlFolders, [folderId, userId], (err, rows) => err ? rej(err) : res(rows)));
    for (const subFolder of subFolders) {
        const nestedFiles = await getFilesRecursive(subFolder.id, userId, path.posix.join(currentPath, subFolder.name));
        allFiles.push(...nestedFiles);
    }
    return allFiles;
}

async function getDescendantFiles(folderIds, userId) {
    let allFiles = [];
    for (const folderId of folderIds) {
        const nestedFiles = await getFilesRecursive(folderId, userId);
        allFiles.push(...nestedFiles);
    }
    return allFiles;
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

function createFolder(name, parentId, userId) {
    const sql = `INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [name, parentId, userId], function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return reject(new Error('同目录下已存在同名文件夹。'));
                return reject(err);
            }
            resolve({ success: true, id: this.lastID });
        });
    });
}

function findFolderByName(name, parentId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`;
        db.get(sql, [name, parentId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function findFolderByPath(startFolderId, pathParts, userId) {
    let currentParentId = startFolderId;
    for (const part of pathParts) {
        if (!part) continue;
        const folder = await new Promise((resolve, reject) => {
            const sql = `SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`;
            db.get(sql, [part, currentParentId, userId], (err, row) => err ? reject(err) : resolve(row));
        });

        if (folder) {
            currentParentId = folder.id;
        } else {
            return null; 
        }
    }
    return currentParentId;
}


function getAllFolders(userId) {
    return new Promise((resolve, reject) => {
        const sql = "SELECT id, name, parent_id FROM folders WHERE user_id = ? ORDER BY parent_id, name ASC";
        db.all(sql, [userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function moveItem(itemId, itemType, targetFolderId, userId, options = {}) {
    const { resolutions = {}, pathPrefix = '' } = options;
    const report = { moved: 0, skipped: 0, errors: 0 };
    log('debug', `moveItem: itemId=${itemId}, type=${itemType}, target=${targetFolderId}, prefix=${pathPrefix}`);
    
    const sourceMount = await getMountNameForId(itemId, itemType, userId);
    const targetMount = await getMountNameForId(targetFolderId, 'folder', userId);

    if (sourceMount && targetMount && sourceMount !== targetMount) {
        throw new Error(`跨 WebDAV 挂载点的移动操作是不被允许的 (从 "${sourceMount}" 到 "${targetMount}")。`);
    }
    
    const sourceItem = (await getItemsByIds([itemId], userId))[0];
    if (!sourceItem) {
        log('error', `moveItem: 找不到来源项目 ID=${itemId}`);
        report.errors++;
        return report;
    }
    
    const currentPath = path.posix.join(pathPrefix, sourceItem.name).replace(/\\/g, '/');
    const existingItemInTarget = await findItemInFolder(sourceItem.name, targetFolderId, userId);
    const resolutionAction = resolutions[currentPath] || (existingItemInTarget ? 'skip_default' : 'move');
    log('debug', `moveItem: currentPath=${currentPath}, resolution=${resolutionAction}`);

    switch (resolutionAction) {
        case 'skip':
        case 'skip_default':
            report.skipped++;
            return report;

        case 'rename':
            const newName = await findAvailableName(sourceItem.name, targetFolderId, userId, itemType === 'folder');
            await renameAndMoveItem(itemId, itemType, newName, targetFolderId, userId);
            report.moved++;
            return report;

        case 'overwrite':
            if (!existingItemInTarget) {
                report.skipped++;
                return report;
            }
            await unifiedDelete(existingItemInTarget.id, existingItemInTarget.type, userId);
            await moveSingleItem(itemId, itemType, targetFolderId, userId);
            report.moved++;
            return report;

        case 'merge':
            if (!existingItemInTarget || existingItemInTarget.type !== 'folder' || itemType !== 'folder') {
                report.skipped++;
                return report;
            }
            
            const children = await getChildrenOfFolder(itemId, userId);
            let allChildrenProcessedSuccessfully = true;

            for (const child of children) {
                const childReport = await moveItem(child.id, child.type, existingItemInTarget.id, userId, { ...options, pathPrefix: currentPath });
                report.moved += childReport.moved;
                report.skipped += childReport.skipped;
                report.errors += childReport.errors;
                if(childReport.skipped > 0 || childReport.errors > 0) {
                    allChildrenProcessedSuccessfully = false;
                }
            }
            
            if (allChildrenProcessedSuccessfully) {
                await unifiedDelete(itemId, 'folder', userId);
            }
            
            return report;

        default: // 'move'
            await moveSingleItem(itemId, itemType, targetFolderId, userId);
            report.moved++;
            return report;
    }
}


async function unifiedDelete(itemId, itemType, userId) {
    const storage = getStorage();
    log('info', `unifiedDelete: itemId=${itemId}, type=${itemType}, storage=${storage.type}`);
    if (storage.type !== 'webdav') {
        throw new Error("目前只支援 WebDAV 储存的删除操作。");
    }

    const itemsForStorage = [];
    const fileIdsToDelete = [];
    const folderIdsToDelete = [];
    
    if (itemType === 'folder') {
        const deletionData = await getFolderDeletionData(itemId, userId);
        fileIdsToDelete.push(...deletionData.files.map(f => f.message_id));
        folderIdsToDelete.push(...deletionData.folders.map(f => f.id));
        
        for(const file of deletionData.files) {
            const {mountName, remotePath} = getWebdavPathInfoFromFileId(file.file_id);
            itemsForStorage.push({ mountName, remotePath, type: 'file' });
        }
        for(const folder of deletionData.folders) {
            const pathParts = await getFolderPath(folder.id, userId);
            if (pathParts.length > 1) { // 排除根目录
                const mountName = pathParts[1].name;
                const remotePath = '/' + pathParts.slice(1).map(p => p.name).join('/');
                itemsForStorage.push({ mountName, remotePath, type: 'folder' });
            }
        }

    } else { // file
        const [file] = await getFilesByIds([itemId], userId);
        if (file) {
            fileIdsToDelete.push(file.message_id);
            const {mountName, remotePath} = getWebdavPathInfoFromFileId(file.file_id);
            itemsForStorage.push({ mountName, remotePath, type: 'file' });
        }
    }
    
    log('debug', 'unifiedDelete: Physical items to delete:', itemsForStorage);
    try {
        await storage.remove(itemsForStorage);
    } catch (err) {
        throw new Error(`实体删除失败，操作已中止: ${err.message}`);
    }
    
    log('debug', `unifiedDelete: DB files to delete: ${fileIdsToDelete.join(',')}, folders: ${folderIdsToDelete.join(',')}`);
    await executeDeletion(fileIdsToDelete, folderIdsToDelete, userId);
}

async function moveSingleItem(itemId, itemType, targetFolderId, userId) {
    const storage = getStorage();
    log('info', `moveSingleItem: itemId=${itemId}, type=${itemType}, target=${targetFolderId}, storage=${storage.type}`);
    
    if (storage.type === 'webdav') {
        const newPathInfo = await getWebdavPathInfo(targetFolderId, userId);

        if (itemType === 'file') {
            const [file] = await getFilesByIds([itemId], userId);
            if(!file) throw new Error("找不到要移动的文件");
            const oldPathInfo = getWebdavPathInfoFromFileId(file.file_id);
            const newPath = { ...newPathInfo, remotePath: path.posix.join(newPathInfo.remotePath, file.fileName) };
            log('debug', `moveSingleItem (file): Moving from ${oldPathInfo.remotePath} to ${newPath.remotePath}`);
            
            await storage.moveFile(oldPathInfo, newPath);

            const newFileIdInDb = path.posix.join('/', newPath.mountName, newPath.remotePath);
            await new Promise((res, rej) => db.run('UPDATE files SET file_id = ?, folder_id = ? WHERE message_id = ?', [newFileIdInDb, targetFolderId, itemId], (e) => e ? rej(e) : res()));

        } else { // folder
            const [folder] = await getItemsByIds([itemId], userId);
            if(!folder) throw new Error("找不到要移动的文件夹");
            const oldPathParts = await getFolderPath(itemId, userId);
            const oldMountName = oldPathParts[1].name;
            const oldRemotePath = '/' + oldPathParts.slice(1).map(p => p.name).join('/');
            
            const newPath = { ...newPathInfo, remotePath: path.posix.join(newPathInfo.remotePath, folder.name) };
            log('debug', `moveSingleItem (folder): Moving from ${oldRemotePath} to ${newPath.remotePath}`);

            await storage.moveFile({mountName: oldMountName, remotePath: oldRemotePath}, newPath);

            const descendantFiles = await getFilesRecursive(itemId, userId);
            for (const file of descendantFiles) {
                const updatedFileId = file.file_id.replace('/' + oldMountName + oldRemotePath, '/' + newPath.mountName + newPath.remotePath);
                await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id], (e) => e ? rej(e) : res()));
            }
            await new Promise((res, rej) => db.run('UPDATE folders SET parent_id = ? WHERE id = ?', [targetFolderId, itemId], (e) => e ? rej(e) : res()));
        }
    } else {
        await moveItemsInDb(itemType === 'file' ? [itemId] : [], itemType === 'folder' ? [itemId] : [], targetFolderId, userId);
    }
}

function moveItemsInDb(fileIds = [], folderIds = [], targetFolderId, userId) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            const promises = [];

            if (fileIds.length > 0) {
                const place = fileIds.map(() => '?').join(',');
                promises.push(new Promise((res, rej) => db.run(`UPDATE files SET folder_id = ? WHERE message_id IN (${place}) AND user_id = ?`, [targetFolderId, ...fileIds, userId], (e) => e ? rej(e) : res())));
            }

            if (folderIds.length > 0) {
                const place = folderIds.map(() => '?').join(',');
                promises.push(new Promise((res, rej) => db.run(`UPDATE folders SET parent_id = ? WHERE id IN (${place}) AND user_id = ?`, [targetFolderId, ...folderIds, userId], (e) => e ? rej(e) : res())));
            }

            Promise.all(promises)
                .then(() => db.run("COMMIT;", (e) => e ? reject(e) : resolve({ success: true })))
                .catch((err) => db.run("ROLLBACK;", () => reject(err)));
        });
    });
}

function deleteSingleFolder(folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `DELETE FROM folders WHERE id = ? AND user_id = ?`;
        db.run(sql, [folderId, userId], function(err) {
            if (err) return reject(err);
            resolve({ success: true, changes: this.changes });
        });
    });
}

async function getFolderDeletionData(folderId, userId) {
    let filesToDelete = [];
    let foldersToDeleteIds = [folderId];

    async function findContentsRecursive(currentFolderId) {
        const sqlFiles = `SELECT * FROM files WHERE folder_id = ? AND user_id = ?`;
        const files = await new Promise((res, rej) => db.all(sqlFiles, [currentFolderId, userId], (err, rows) => err ? rej(err) : res(rows)));
        filesToDelete.push(...files);
        
        const sqlFolders = `SELECT id FROM folders WHERE parent_id = ? AND user_id = ?`;
        const subFolders = await new Promise((res, rej) => db.all(sqlFolders, [currentFolderId, userId], (err, rows) => err ? rej(err) : res(rows)));
        
        for (const subFolder of subFolders) {
            foldersToDeleteIds.push(subFolder.id);
            await findContentsRecursive(subFolder.id);
        }
    }

    await findContentsRecursive(folderId);
    
    const foldersToDelete = await Promise.all(foldersToDeleteIds.map(id => 
        new Promise((res, rej) => db.get("SELECT * FROM folders WHERE id=?", [id], (e, r) => e ? rej(e) : res(r)))
    ));

    return { files: filesToDelete, folders: foldersToDelete.filter(Boolean) };
}


function executeDeletion(fileIds, folderIds, userId) {
    return new Promise((resolve, reject) => {
        if (fileIds.length === 0 && folderIds.length === 0) return resolve({ success: true });
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION;");
            const promises = [];
            
            if (fileIds.length > 0) {
                const place = Array.from(new Set(fileIds)).map(() => '?').join(',');
                promises.push(new Promise((res, rej) => db.run(`DELETE FROM files WHERE message_id IN (${place}) AND user_id = ?`, [...new Set(fileIds), userId], (e) => e ? rej(e) : res())));
            }
            if (folderIds.length > 0) {
                const place = Array.from(new Set(folderIds)).map(() => '?').join(',');
                promises.push(new Promise((res, rej) => db.run(`DELETE FROM folders WHERE id IN (${place}) AND user_id = ?`, [...new Set(folderIds), userId], (e) => e ? rej(e) : res())));
            }

            Promise.all(promises)
                .then(() => db.run("COMMIT;", (e) => e ? reject(e) : resolve({ success: true })))
                .catch((err) => db.run("ROLLBACK;", () => reject(err)));
        });
    });
}


function addFile(fileData, folderId = 1, userId, storageType) {
    const { message_id, fileName, mimetype, file_id, thumb_file_id, date, size } = fileData;
    const sql = `INSERT INTO files (message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folderId, userId, storageType], function(err) {
            if (err) reject(err);
            else resolve({ success: true, id: this.lastID, fileId: this.lastID });
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

function getFileByShareToken(token) {
     return new Promise((resolve, reject) => {
        const sql = "SELECT * FROM files WHERE share_token = ?";
        db.get(sql, [token], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);
            if (row.share_expires_at && Date.now() > row.share_expires_at) {
                const updateSql = "UPDATE files SET share_token = NULL, share_expires_at = NULL WHERE message_id = ?";
                db.run(updateSql, [row.message_id]);
                resolve(null);
            } else {
                resolve(row);
            }
        });
    });
}

function getFolderByShareToken(token) {
     return new Promise((resolve, reject) => {
        const sql = "SELECT * FROM folders WHERE share_token = ?";
        db.get(sql, [token], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);
            if (row.share_expires_at && Date.now() > row.share_expires_at) {
                const updateSql = "UPDATE folders SET share_token = NULL, share_expires_at = NULL WHERE id = ?";
                db.run(updateSql, [row.id]);
                resolve(null);
            } else {
                resolve(row);
            }
        });
    });
}

function findFileInSharedFolder(fileId, folderToken) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT f.*
            FROM files f
            JOIN folders fo ON f.folder_id = fo.id
            WHERE f.message_id = ? AND fo.share_token = ?
        `;
        db.get(sql, [fileId, folderToken], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function renameFile(messageId, newFileName, userId) {
    const [file] = await getFilesByIds([messageId], userId);
    if (!file) return { success: false, message: '文件未找到。' };

    const storage = getStorage();

    if (storage.type === 'webdav') {
        const oldPathInfo = getWebdavPathInfoFromFileId(file.file_id);
        const newRemotePath = path.posix.join(path.posix.dirname(oldPathInfo.remotePath), newFileName);
        
        await storage.moveFile(oldPathInfo, { ...oldPathInfo, remotePath: newRemotePath });
        
        const newFileIdInDb = path.posix.join('/', oldPathInfo.mountName, newRemotePath);
        const sql = `UPDATE files SET fileName = ?, file_id = ? WHERE message_id = ? AND user_id = ?`;
        return new Promise((resolve, reject) => {
            db.run(sql, [newFileName, newFileIdInDb, messageId, userId], function(err) {
                 if (err) reject(err);
                 else resolve({ success: true });
            });
        });
    }

    const sql = `UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFileName, messageId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '文件未找到。' });
            else resolve({ success: true });
        });
    });
}

async function renameAndMoveItem(itemId, itemType, newName, targetFolderId, userId) {
     if (itemType === 'file') {
        await renameAndMoveFile(itemId, newName, targetFolderId, userId);
    } else {
        await renameFolder(itemId, newName, userId);
        await moveSingleItem(itemId, itemType, targetFolderId, userId);
    }
}

async function renameAndMoveFile(messageId, newFileName, targetFolderId, userId) {
    const [file] = await getFilesByIds([messageId], userId);
    if (!file) throw new Error('File not found for rename and move');

    const storage = getStorage();
    if (storage.type === 'webdav') {
        const oldPathInfo = getWebdavPathInfoFromFileId(file.file_id);
        const newPathInfo = await getWebdavPathInfo(targetFolderId, userId);
        const newRemotePath = path.posix.join(newPathInfo.remotePath, newFileName);
        
        await storage.moveFile(oldPathInfo, { ...newPathInfo, remotePath: newRemotePath });
        
        const newFileIdInDb = path.posix.join('/', newPathInfo.mountName, newRemotePath);
        const sql = `UPDATE files SET fileName = ?, file_id = ?, folder_id = ? WHERE message_id = ? AND user_id = ?`;
        return new Promise((resolve, reject) => {
            db.run(sql, [newFileName, newFileIdInDb, targetFolderId, messageId, userId], (err) => err ? reject(err) : resolve({ success: true }));
        });
    }

    const sql = `UPDATE files SET fileName = ?, folder_id = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFileName, targetFolderId, messageId, userId], (err) => err ? reject(err) : resolve({ success: true }));
    });
}


async function renameFolder(folderId, newFolderName, userId) {
    const folder = await new Promise((res, rej) => db.get("SELECT * FROM folders WHERE id=? AND user_id=?", [folderId, userId], (e,r)=>e?rej(e):res(r)));
    if (!folder) return { success: false, message: '文件夹未找到。'};
    if (folder.parent_id === null) return { success: false, message: '不能重命名根目录。'};
    
    const storage = getStorage();

    if (storage.type === 'webdav') {
        const oldPathParts = await getFolderPath(folderId, userId);
        const isMountPoint = oldPathParts.length === 2;
        
        // 只有在不是掛載點本身被重命名時，才執行物理移動
        if (!isMountPoint) {
            const oldPathInfo = await getWebdavPathInfo(folder.parent_id, userId);
            const oldRemotePath = path.posix.join(oldPathInfo.remotePath, folder.name);
            const newRemotePath = path.posix.join(oldPathInfo.remotePath, newFolderName);
            
            await storage.moveFile({ ...oldPathInfo, remotePath: oldRemotePath }, { ...oldPathInfo, remotePath: newRemotePath });
            
            const descendantFiles = await getFilesRecursive(folderId, userId);
            for (const file of descendantFiles) {
                const updatedFileId = file.file_id.replace(
                    path.posix.join('/', oldPathInfo.mountName, oldRemotePath),
                    path.posix.join('/', oldPathInfo.mountName, newRemotePath)
                );
                await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id], (e) => e ? rej(e) : res()));
            }
        }
    }

    // 更新資料庫中的資料夾名稱
    const sql = `UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFolderName, folderId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '文件夹未找到。' });
            else resolve({ success: true });
        });
    });
}


function createShareLink(itemId, itemType, expiresIn, userId) {
    const token = crypto.randomBytes(16).toString('hex');
    let expiresAt = null;
    const now = Date.now();
    const hours = (h) => h * 60 * 60 * 1000;
    const days = (d) => d * 24 * hours(1);
    switch (expiresIn) {
        case '1h': expiresAt = now + hours(1); break;
        case '3h': expiresAt = now + hours(3); break;
        case '5h': expiresAt = now + hours(5); break;
        case '7h': expiresAt = now + hours(7); break;
        case '24h': expiresAt = now + hours(24); break;
        case '7d': expiresAt = now + days(7); break;
        case '0': expiresAt = null; break;
        default: expiresAt = now + hours(24);
    }

    const table = itemType === 'folder' ? 'folders' : 'files';
    const idColumn = itemType === 'folder' ? 'id' : 'message_id';

    const sql = `UPDATE ${table} SET share_token = ?, share_expires_at = ? WHERE ${idColumn} = ? AND user_id = ?`;

    return new Promise((resolve, reject) => {
        db.run(sql, [token, expiresAt, itemId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '项目未找到。' });
            else resolve({ success: true, token });
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

function getActiveShares(userId) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        const sqlFiles = `SELECT message_id as id, fileName as name, 'file' as type, share_token, share_expires_at FROM files WHERE share_token IS NOT NULL AND (share_expires_at IS NULL OR share_expires_at > ?) AND user_id = ?`;
        const sqlFolders = `SELECT id, name, 'folder' as type, share_token, share_expires_at FROM folders WHERE share_token IS NOT NULL AND (share_expires_at IS NULL OR share_expires_at > ?) AND user_id = ?`;

        let shares = [];
        db.all(sqlFiles, [now, userId], (err, files) => {
            if (err) return reject(err);
            shares = shares.concat(files);
            db.all(sqlFolders, [now, userId], (err, folders) => {
                if (err) return reject(err);
                shares = shares.concat(folders);
                resolve(shares);
            });
        });
    });
}

function cancelShare(itemId, itemType, userId) {
    const table = itemType === 'folder' ? 'folders' : 'files';
    const idColumn = itemType === 'folder' ? 'id' : 'message_id';
    const sql = `UPDATE ${table} SET share_token = NULL, share_expires_at = NULL WHERE ${idColumn} = ? AND user_id = ?`;

    return new Promise((resolve, reject) => {
        db.run(sql, [itemId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '项目未找到或无需取消' });
            else resolve({ success: true });
        });
    });
}

async function getConflictingItems(itemsToMove, destinationFolderId, userId) {
    const fileConflicts = new Set();
    const folderConflicts = new Set();

    const destContents = await getChildrenOfFolder(destinationFolderId, userId);
    const destMap = new Map(destContents.map(item => [item.name, item.type]));

    for (const item of itemsToMove) {
        const destType = destMap.get(item.name);
        if (destType) {
            if (item.type === 'folder' && destType === 'folder') {
                folderConflicts.add(item.name);
            } else {
                fileConflicts.add(item.name);
            }
        }
    }
    
    return {
        fileConflicts: Array.from(fileConflicts),
        folderConflicts: Array.from(folderConflicts)
    };
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

function findItemInFolder(name, folderId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT id, name, 'folder' as type FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?
            UNION ALL
            SELECT message_id as id, fileName as name, 'file' as type FROM files WHERE fileName = ? AND folder_id = ? AND user_id = ?
        `;
        db.get(sql, [name, folderId, userId, name, folderId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

async function findAvailableName(originalName, folderId, userId, isFolder) {
    let newName = originalName;
    let counter = 1;
    const nameWithoutExt = isFolder ? originalName : path.parse(originalName).name;
    const ext = isFolder ? '' : path.parse(originalName).ext;

    while (await findItemInFolder(newName, folderId, userId)) {
        newName = `${nameWithoutExt} (${counter})${ext}`;
        counter++;
    }
    return newName;
}


function findFileByFileId(fileId, userId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT message_id FROM files WHERE file_id = ? AND user_id = ?`;
        db.get(sql, [fileId, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
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

async function findOrCreateFolderByPath(fullPath, userId) {
    if (!fullPath || fullPath === '/') {
        const root = await getRootFolder(userId);
        return root.id;
    }

    const pathParts = fullPath.split('/').filter(p => p);
    let parentId = (await getRootFolder(userId)).id;

    for (const part of pathParts) {
        let folder = await findFolderByName(part, parentId, userId);
        if (folder) {
            parentId = folder.id;
        } else {
            const result = await createFolder(part, parentId, userId);
            parentId = result.id;
        }
    }
    return parentId;
}

async function resolvePathToFolderId(startFolderId, pathParts, userId) {
    let currentParentId = startFolderId;
    for (const part of pathParts) {
        if (!part) continue;

        let folder = await new Promise((resolve, reject) => {
            const sql = `SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?`;
            db.get(sql, [part, currentParentId, userId], (err, row) => err ? reject(err) : resolve(row));
        });

        if (folder) {
            currentParentId = folder.id;
        } else {
            const newFolder = await new Promise((resolve, reject) => {
                const sql = `INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)`;
                db.run(sql, [part, currentParentId, userId], function(err) {
                    if (err) return reject(err);
                    resolve({ id: this.lastID });
                });
            });
            currentParentId = newFolder.id;
        }
    }
    return currentParentId;
}

async function getMountNameForId(itemId, itemType, userId) {
    try {
        let folderId;
        if (itemType === 'folder') {
            folderId = itemId;
        } else {
            const [file] = await getFilesByIds([itemId], userId);
            if (!file) return null;
            folderId = file.folder_id;
        }
        const pathParts = await getFolderPath(folderId, userId);
        return (pathParts.length > 1) ? pathParts[1].name : null;
    } catch (error) {
        log('error', `getMountNameForId 失败: itemId=${itemId}, itemType=${itemType}`, error);
        return null;
    }
}

module.exports = {
    createUser,
    findUserByName,
    findUserById,
    changeUserPassword,
    listNormalUsers,
    listAllUsers,
    deleteUser,
    searchItems,
    getFolderContents,
    getFilesRecursive,
    getFolderPath,
    createFolder,
    findFolderByName,
    getAllFolders,
    getAllDescendantFolderIds,
    executeDeletion,
    getFolderDeletionData,
    deleteSingleFolder,
    addFile,
    getFilesByIds,
    getItemsByIds,
    getChildrenOfFolder,
    moveSingleItem,
    moveItemsInDb,
    moveItem,
    getFileByShareToken,
    getFolderByShareToken,
    findFileInSharedFolder,
    createShareLink,
    getActiveShares,
    cancelShare,
    renameFile,
    renameFolder,
    deleteFilesByIds,
    findFileInFolder,
    getConflictingItems,
    checkFullConflict,
    resolvePathToFolderId,
    findFolderByPath,
    getDescendantFiles,
    findFileByFileId,
    findOrCreateFolderByPath,
    getRootFolder,
    unifiedDelete,
    findItemInFolder,
    findAvailableName,
    renameAndMoveFile,
    renameAndMoveItem,
    getWebdavPathInfo,
    getWebdavPathInfoFromFileId,
    getMountNameForId
};
