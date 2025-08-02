const db = require('./database.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

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
            SELECT id, name, parent_id, 'folder' as type, webdav_mount_id
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

function getItemsByIds(itemIds, userId, itemType = null) {
    return new Promise((resolve, reject) => {
        if (!itemIds || itemIds.length === 0) return resolve([]);
        const placeholders = itemIds.map(() => '?').join(',');
        
        let sql;
        let params = [...itemIds, userId];

        if (itemType === 'folder') {
            sql = `SELECT id, name, parent_id, 'folder' as type, webdav_mount_id, null as storage_type, null as file_id
                   FROM folders 
                   WHERE id IN (${placeholders}) AND user_id = ?`;
        } else if (itemType === 'file') {
            sql = `SELECT message_id as id, fileName as name, folder_id as parent_id, 'file' as type, storage_type, file_id, webdav_mount_id
                   FROM files 
                   WHERE message_id IN (${placeholders}) AND user_id = ?`;
        } else {
            sql = `
                SELECT id, name, parent_id, 'folder' as type, webdav_mount_id, null as storage_type, null as file_id
                FROM folders 
                WHERE id IN (${placeholders}) AND user_id = ?
                UNION ALL
                SELECT message_id as id, fileName as name, folder_id as parent_id, 'file' as type, webdav_mount_id, storage_type, file_id
                FROM files 
                WHERE message_id IN (${placeholders}) AND user_id = ?
            `;
            params.push(...itemIds, userId);
        }

        db.all(sql, params, (err, rows) => {
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

async function getFilesRecursive(folderId, userId, currentPath = '') {
    let allFiles = [];
    const sqlFiles = "SELECT * FROM files WHERE folder_id = ? AND user_id = ?";
    const files = await new Promise((res, rej) => db.all(sqlFiles, [folderId, userId], (err, rows) => err ? rej(err) : res(rows)));
    for (const file of files) {
        allFiles.push({ ...file, path: path.join(currentPath, file.fileName) });
    }

    const sqlFolders = "SELECT id, name FROM folders WHERE parent_id = ? AND user_id = ?";
    const subFolders = await new Promise((res, rej) => db.all(sqlFolders, [folderId, userId], (err, rows) => err ? rej(err) : res(rows)));
    for (const subFolder of subFolders) {
        const nestedFiles = await getFilesRecursive(subFolder.id, userId, path.join(currentPath, subFolder.name));
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
        const sql = "SELECT id, name, parent_id, webdav_mount_id FROM folders WHERE user_id = ? ORDER BY parent_id, name ASC";
        db.all(sql, [userId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function moveItem(itemId, itemType, targetFolderId, userId, options = {}) {
    const report = { moved: 0, skipped: 0, errors: 0 };
    const { resolutions = {}, pathPrefix = '' } = options;
    
    const sourceItem = (await getItemsByIds([itemId], userId, itemType))[0];
    if (!sourceItem) {
        report.errors++;
        return report;
    }
    
    if (itemType === 'folder' && sourceItem.parent_id === null) {
        console.error(`[警告] [data.js moveItem] 侦测到一次移动根目录 (ID: ${itemId}) 的无效尝试。操作已跳过。`);
        report.errors++;
        return report;
    }

    const currentRelativePath = path.posix.join(pathPrefix, sourceItem.name);
    const existingItemInTarget = await findItemInFolder(sourceItem.name, targetFolderId, userId);
    const action = resolutions[currentRelativePath] || (existingItemInTarget ? 'skip_default' : 'move');

    try {
        if (action === 'skip' || action === 'skip_default') {
            report.skipped++;
            return report;
        }
        
        if (action === 'merge') {
            if (!existingItemInTarget || existingItemInTarget.type !== 'folder' || itemType !== 'folder') {
                report.skipped++;
                return report;
            }
            
            const children = await getChildrenOfFolder(itemId, userId);
            let allChildrenProcessedWithoutIssues = true;

            for (const child of children) {
                const childReport = await moveItem(child.id, child.type, existingItemInTarget.id, userId, { 
                    resolutions, 
                    pathPrefix: currentRelativePath 
                });
                
                report.moved += childReport.moved;
                report.skipped += childReport.skipped;
                report.errors += childReport.errors;
                
                if (childReport.errors > 0 || childReport.skipped > 0) {
                    allChildrenProcessedWithoutIssues = false;
                }
            }
            
            if (allChildrenProcessedWithoutIssues) {
                await unifiedDelete(itemId, 'folder', userId);
            } else {
                 console.log(`[DEBUG] [data.js moveItem] Some children of '${sourceItem.name}' were skipped or had errors. Original folder is kept.`);
            }
            return report;
        }

        let finalTargetFolderId = targetFolderId;
        let finalItemName = sourceItem.name;
        let overwriteFlag = false;

        if (action === 'overwrite') {
            if (existingItemInTarget) {
                await unifiedDelete(existingItemInTarget.id, existingItemInTarget.type, userId);
            }
            overwriteFlag = true;
        } else if (action === 'rename') {
            finalItemName = await findAvailableName(sourceItem.name, targetFolderId, userId, itemType === 'folder');
        }

        await moveItems(
            itemType === 'file' ? [{ id: itemId, name: finalItemName }] : [],
            itemType === 'folder' ? [{ id: itemId, name: finalItemName }] : [],
            finalTargetFolderId,
            userId,
            overwriteFlag
        );

        report.moved++;
    } catch (e) {
        console.error(`[DEBUG] [data.js moveItem] **** An error occurred for item '${sourceItem.name}' ****`);
        console.error(e);
        report.errors++;
    }
    return report;
}

async function unifiedDelete(itemId, itemType, userId) {
    const storage = require('./storage').getStorage();
    let filesForStorage = [];
    let foldersForStorage = [];
    
    if (itemType === 'folder') {
        const deletionData = await getFolderDeletionData(itemId, userId);
        filesForStorage.push(...deletionData.files);
        foldersForStorage.push(...deletionData.folders);
    } else {
        const directFiles = await getFilesByIds([itemId], userId);
        filesForStorage.push(...directFiles);
    }
    
    try {
        await storage.remove(filesForStorage, foldersForStorage, userId);
    } catch (err) {
        throw new Error("实体档案删除失败，操作已中止。");
    }
    
    await executeDeletion(filesForStorage.map(f => f.message_id), foldersForStorage.map(f => f.id), userId);
}


async function moveItems(fileItems = [], folderItems = [], targetFolderId, userId, overwrite = false) {
    const storage = require('./storage').getStorage();

    const targetFolder = await findFolderById(targetFolderId, userId);
    if (!targetFolder || !targetFolder.webdav_mount_id) {
        throw new Error("移动的目标不是一个有效的WebDAV子目录");
    }
    const mountId = targetFolder.webdav_mount_id;

    const fileIds = fileItems.map(item => item.id);
    const filesToMove = await getFilesByIds(fileIds, userId);
    const fileNameMap = new Map(fileItems.map(item => [item.id, item.name]));

    for (const file of filesToMove) {
        const { remotePath: oldRelativePath } = await storage.getRemotePath(file.message_id, 'file', userId);
        const { remotePath: newFolderFullPath } = await storage.getRemotePath(targetFolderId, 'folder', userId);
        
        const newFileName = fileNameMap.get(file.message_id) || file.fileName;
        const newRelativePath = path.posix.join(newFolderFullPath, newFileName);
        try {
            await storage.move(oldRelativePath, newRelativePath, mountId, overwrite);
            await new Promise((res, rej) => db.run('UPDATE files SET fileName = ?, file_id = ?, folder_id = ? WHERE message_id = ?', [newFileName, newRelativePath, targetFolderId, file.message_id], (e) => e ? rej(e) : res()));
        } catch (err) {
            throw new Error(`物理移动文件 ${newFileName} 失败`);
        }
    }
    
    const folderIds = folderItems.map(item => item.id);
    const folderNameMap = new Map(folderItems.map(item => [item.id, item.name]));
    const foldersToMove = (await getItemsByIds(folderIds, userId)).filter(i => i.type === 'folder');

    for (const folder of foldersToMove) {
        const { remotePath: oldFullPath } = await storage.getRemotePath(folder.id, 'folder', userId);
        const { remotePath: targetFolderFullPath } = await storage.getRemotePath(targetFolderId, 'folder', userId);
        
        const newFolderName = folderNameMap.get(folder.id) || folder.name;
        const newFullPath = path.posix.join(targetFolderFullPath, newFolderName);

        try {
            await storage.move(oldFullPath, newFullPath, mountId, overwrite);
            const descendantFiles = await getFilesRecursive(folder.id, userId);
            for (const file of descendantFiles) {
                const updatedFileId = file.file_id.replace(oldFullPath, newFullPath);
                await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id], (e) => e ? rej(e) : res()));
            }

            await new Promise((res, rej) => db.run(`UPDATE folders SET name = ?, parent_id = ? WHERE id = ?`, [newFolderName, targetFolderId, folder.id], (e) => e ? rej(e) : res()));

        } catch (err) {
            throw new Error(`物理移动文件夹 ${newFolderName} 失败`);
        }
    }
}


async function renameFile(messageId, newFileName, userId) {
    const file = (await getFilesByIds([messageId], userId))[0];
    if (!file) {
        return { success: false, message: '文件未找到。' };
    }

    const conflict = await checkFullConflict(newFileName, file.folder_id, userId);
    if (conflict) {
        throw new Error('目标文件夹中已存在同名项目。');
    }

    const storage = require('./storage').getStorage();
    const oldRelativePath = file.file_id;
    const newRelativePath = path.posix.join(path.posix.dirname(oldRelativePath), newFileName);

    try {
        await storage.move(oldRelativePath, newRelativePath, file.webdav_mount_id, false);
    } catch(err) {
        throw new Error(`实体档案重新命名失败: ${err.message}`);
    }
    
    const sql = `UPDATE files SET fileName = ?, file_id = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFileName, newRelativePath, messageId, userId], function(err) {
             if (err) reject(err);
             else resolve({ success: true });
        });
    });
}

async function renameFolder(folderId, newFolderName, userId) {
    const folder = await findFolderById(folderId, userId);
    if (!folder) {
        return { success: false, message: '资料夹未找到。'};
    }
    
    if (folder.parent_id === null) {
        throw new Error('无法重新命名根目录。');
    }
    const parentFolder = await findFolderById(folder.parent_id, userId);
    if (parentFolder.parent_id === null) { 
        throw new Error('无法重新命名 WebDAV 挂载点目录。');
    }


    const conflict = await checkFullConflict(newFolderName, folder.parent_id, userId);
    if (conflict) {
        throw new Error('目标文件夹中已存在同名项目。');
    }
    
    const storage = require('./storage').getStorage();
    const { remotePath: oldFullPath, mountId } = await storage.getRemotePath(folderId, 'folder', userId);
    const newFullPath = path.posix.join(path.posix.dirname(oldFullPath), newFolderName);

    try {
        await storage.move(oldFullPath, newFullPath, mountId, false);
        
        const descendantFiles = await getFilesRecursive(folderId, userId);
        for (const file of descendantFiles) {
            const updatedFileId = file.file_id.replace(oldFullPath, newFullPath);
            await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id], (e) => e ? rej(e) : res()));
        }
    } catch(e) {
        throw new Error(`物理资料夹重新命名失败: ${e.message}`);
    }

    const sql = `UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFolderName, folderId, userId], function(err) {
            if (err) reject(err);
            else if (this.changes === 0) resolve({ success: false, message: '资料夹未找到。' });
            else resolve({ success: true });
        });
    });
}

async function getFolderDeletionData(folderId, userId) {
    let filesToDelete = [];
    let foldersToDeleteIds = [folderId];
    const folderInfo = await findFolderById(folderId, userId);
    if (!folderInfo) return { files: [], folders: [] };
    const mountId = folderInfo.webdav_mount_id;

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

    const allUserFolders = await getAllFolders(userId);
    const folderMap = new Map(allUserFolders.map(f => [f.id, f]));
    
    function buildPath(fId) {
        let pathParts = [];
        let current = folderMap.get(fId);
        while(current && current.parent_id && folderMap.get(current.parent_id)?.parent_id) {
            pathParts.unshift(current.name);
            current = folderMap.get(current.parent_id);
        }
        return path.posix.join('/', ...pathParts);
    }
    
    const foldersToDeleteWithPaths = foldersToDeleteIds.map(id => ({
        id: id,
        path: buildPath(id),
        webdav_mount_id: mountId
    }));

    return { files: filesToDelete, folders: foldersToDeleteWithPaths };
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

async function findOrCreateFolderByPath(fullPath, userId, mountId) {
    const root = await getRootFolder(userId);
    if (!fullPath || fullPath === '/' || fullPath === '.') {
        const mountConfig = await new Promise((res, rej) => db.get('SELECT mount_name FROM webdav_configs WHERE id = ?', [mountId], (e, r) => e ? rej(e) : res(r)));
        if (!mountConfig) throw new Error('找不到挂载点');
        
        let mountFolder = await findFolderByName(mountConfig.mount_name, root.id, userId);
        if (!mountFolder) {
             const result = await createFolder(mountConfig.mount_name, root.id, userId, mountId);
             mountFolder = { id: result.id };
        }
        return mountFolder.id;
    }

    const pathParts = fullPath.split('/').filter(p => p);
    let parentId = await findOrCreateFolderByPath('/', userId, mountId);

    for (const part of pathParts) {
        let folder = await findFolderByName(part, parentId, userId);
        if (folder) {
            parentId = folder.id;
        } else {
            const result = await createFolder(part, parentId, userId, mountId);
            parentId = result.id;
        }
    }
    return parentId;
}

async function resolvePathToFolderId(startFolderId, pathParts, userId, mountId) {
    let currentParentId = startFolderId;
    for (const part of pathParts) {
        if (!part) continue;

        let folder = await findFolderByName(part, currentParentId, userId);

        if (folder) {
            currentParentId = folder.id;
        } else {
            const newFolder = await createFolder(part, currentParentId, userId, mountId);
            currentParentId = newFolder.id;
        }
    }
    return currentParentId;
}

function createFolder(name, parentId, userId, webdavMountId = null) {
    const sql = `INSERT INTO folders (name, parent_id, user_id, webdav_mount_id) VALUES (?, ?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [name, parentId, userId, webdavMountId], function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return reject(new Error('同目录下已存在同名资料夹。'));
                return reject(err);
            }
            resolve({ success: true, id: this.lastID });
        });
    });
}

function addFile(fileData, folderId, userId, storageType, webdavMountId) {
    const { message_id, fileName, mimetype, file_id, thumb_file_id, date, size } = fileData;
    const sql = `INSERT INTO files (message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folder_id, user_id, storage_type, webdav_mount_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [message_id, fileName, mimetype, file_id, thumb_file_id, date, size, folderId, userId, storageType, webdavMountId], function(err) {
            if (err) reject(err);
            else resolve({ success: true, id: this.lastID, fileId: this.lastID });
        });
    });
}

//--- 新增的数据库交互函数 ---

function addOrUpdateWebdavConfig(config) {
    return new Promise((resolve, reject) => {
        if (config.id) { // 更新
            const params = [config.mount_name, config.url, config.username, config.id, config.userId];
            let sql = `UPDATE webdav_configs SET mount_name = ?, url = ?, username = ?`;
            if (config.password) {
                sql += `, password = ?`;
                params.splice(3, 0, config.password);
            } else {
                 sql += `, password = NULL`;
            }
            sql += ` WHERE id = ? AND user_id = ?`;
            
            db.run(sql, params, function(err) {
                if (err) return reject(err);
                resolve({ id: config.id });
            });
        } else { // 新增
            const sql = `INSERT INTO webdav_configs (user_id, mount_name, url, username, password) VALUES (?, ?, ?, ?, ?)`;
            db.run(sql, [config.userId, config.mount_name, config.url, config.username, config.password], function(err) {
                if (err) return reject(err);
                resolve({ id: this.lastID });
            });
        }
    });
}

function deleteWebdavConfig(mountId, userId) {
    return new Promise(async (resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            // 删除对应的顶层挂载目录
            db.run("DELETE FROM folders WHERE webdav_mount_id = ? AND user_id = ?", [mountId, userId]);
            // 删除 webdav_configs 中的设定
            db.run("DELETE FROM webdav_configs WHERE id = ? AND user_id = ?", [mountId, userId]);
            db.run("COMMIT", (err) => {
                if (err) {
                    db.run("ROLLBACK");
                    return reject(err);
                }
                resolve();
            });
        });
    });
}

function getWebdavMounts(userId) {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM webdav_configs WHERE user_id = ?', [userId], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function setWebdavMountFullStatus(mountId, isFull) {
    return new Promise((resolve, reject) => {
        db.run('UPDATE webdav_configs SET is_full = ? WHERE id = ?', [isFull ? 1 : 0, mountId], function(err) {
            if (err) return reject(err);
            console.log(`[INFO] WebDAV mount ${mountId} is_full status set to ${isFull}`);
            resolve({ success: true });
        });
    });
}

function findFolderById(id, userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM folders WHERE id = ? AND user_id = ?", [id, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
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
    addFile,
    getFilesByIds,
    getItemsByIds,
    getChildrenOfFolder,
    moveItems,
    moveItem,
    getFileByShareToken,
    getFolderByShareToken,
    findFileInSharedFolder,
    createShareLink,
    getActiveShares,
    cancelShare,
    renameFile,
    renameFolder,
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
    findFolderById,
    getWebdavMounts,
    addOrUpdateWebdavConfig,
    deleteWebdavConfig,
    setWebdavMountFullStatus,
};
