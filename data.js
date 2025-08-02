const db = require('./database.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

// ... (所有 createUser, findUser, 等非檔案操作函數保持不變) ...
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
    // 移除了删除本地使用者资料夹的逻辑
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

function createFolder(name, parentId, userId) {
    const sql = `INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [name, parentId, userId], function (err) {
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

// =================================================================
// ===           *** 关键修正的函数 *** ===
// =================================================================
async function moveItem(itemId, itemType, targetFolderId, userId, options = {}) {
    const { resolutions = {}, pathPrefix = '' } = options;
    console.log(`[DEBUG] [data.js moveItem] Called with itemId=${itemId}, itemType=${itemType}, targetFolderId=${targetFolderId}`);
    console.log(`[DEBUG] [data.js moveItem] PathPrefix: '${pathPrefix}', Resolutions:`, resolutions);

    const report = { moved: 0, skipped: 0, errors: 0 };

    const sourceItem = (await getItemsByIds([itemId], userId))[0];
    if (!sourceItem) {
        console.error(`[DEBUG] [data.js moveItem] ERROR: Source item ${itemId} not found.`);
        report.errors++;
        return report;
    }

    // 构建当前处理项目的相对路径，用于在 resolutions 中查找正确的操作
    const currentRelativePath = path.posix.join(pathPrefix, sourceItem.name);
    console.log(`[DEBUG] [data.js moveItem] Item "${sourceItem.name}" has relative path: ${currentRelativePath}`);
    
    const existingItemInTarget = await findItemInFolder(sourceItem.name, targetFolderId, userId);
    
    // 决定操作：优先使用 `resolutions` 中的具体路径，否则根据是否存在冲突来决定
    const action = resolutions[currentRelativePath] || (existingItemInTarget ? 'skip_default' : 'move');
    console.log(`[DEBUG] [data.js moveItem] Determined action for "${currentRelativePath}": ${action}`);

    try {
        if (action === 'skip' || action === 'skip_default') {
            console.log(`[DEBUG] [data.js moveItem] Action is '${action}'. Skipping.`);
            report.skipped++;
            return report;
        }
        
        if (action === 'merge') {
            console.log(`[DEBUG] [data.js moveItem] Action is 'merge'.`);
            if (!existingItemInTarget || existingItemInTarget.type !== 'folder' || itemType !== 'folder') {
                console.log(`[DEBUG] [data.js moveItem] Merge condition not met. Skipping.`);
                report.skipped++;
                return report;
            }
            
            console.log(`[DEBUG] [data.js moveItem] Merging into existing folder ID: ${existingItemInTarget.id}`);
            const children = await getChildrenOfFolder(itemId, userId);
            let allChildrenProcessedSuccessfully = true;

            for (const child of children) {
                // *** 关键：递归调用 moveItem，并将当前项的相对路径作为新的 pathPrefix ***
                const childReport = await moveItem(child.id, child.type, existingItemInTarget.id, userId, { 
                    resolutions, 
                    pathPrefix: currentRelativePath 
                });
                
                report.moved += childReport.moved;
                report.skipped += childReport.skipped;
                report.errors += childReport.errors;
                if (childReport.errors > 0) { // 只要有任何一个子项移动出错，就认为父文件夹没有完全合并成功
                    allChildrenProcessedSuccessfully = false;
                }
            }
            
            // 如果所有子项都成功处理（没有错误），则可以安全地删除原始的空父资料夹
            if (allChildrenProcessedSuccessfully) {
                console.log(`[DEBUG] [data.js moveItem] All children of '${sourceItem.name}' merged. Deleting original folder.`);
                await unifiedDelete(itemId, 'folder', userId);
            } else {
                 console.log(`[DEBUG] [data.js moveItem] Some children of '${sourceItem.name}' failed to merge. Original folder is kept.`);
            }
            return report;
        }

        // --- 处理 move, overwrite, rename ---
        let finalTargetFolderId = targetFolderId;
        let finalItemName = sourceItem.name;
        let overwriteFlag = false;

        if (action === 'overwrite') {
            console.log(`[DEBUG] [data.js moveItem] Action is 'overwrite'.`);
            if (existingItemInTarget) {
                console.log(`[DEBUG] [data.js moveItem] Deleting existing item in target first.`);
                await unifiedDelete(existingItemInTarget.id, existingItemInTarget.type, userId);
            }
            overwriteFlag = true; // 即使目标已被删除，也要告诉底层 move 这是个覆盖操作
        } else if (action === 'rename') {
            console.log(`[DEBUG] [data.js moveItem] Action is 'rename'. Finding available name.`);
            finalItemName = await findAvailableName(sourceItem.name, targetFolderId, userId, itemType === 'folder');
            console.log(`[DEBUG] [data.js moveItem] New name will be: ${finalItemName}.`);
        }

        // 最终执行移动操作
        console.log(`[DEBUG] [data.js moveItem] Calling moveItems for item '${finalItemName}'`);
        await moveItems(
            itemType === 'file' ? [{ id: itemId, name: finalItemName }] : [],
            itemType === 'folder' ? [{ id: itemId, name: finalItemName }] : [],
            finalTargetFolderId,
            userId,
            overwriteFlag
        );

        report.moved++;
        console.log(`[DEBUG] [data.js moveItem] Move successful for '${finalItemName}'.`);

    } catch (e) {
        console.error(`[DEBUG] [data.js moveItem] **** An error occurred for item '${sourceItem.name}' ****`);
        console.error(e);
        report.errors++;
    }
    return report;
}

async function unifiedDelete(itemId, itemType, userId) {
    console.log(`[DEBUG] [data.js unifiedDelete] Deleting itemId=${itemId}, itemType=${itemType}`);
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
    
    console.log(`[DEBUG] [data.js unifiedDelete] Items to delete from storage:`, { files: filesForStorage.map(f=>f.file_id), folders: foldersForStorage.map(f=>f.path) });

    try {
        await storage.remove(filesForStorage, foldersForStorage, userId);
    } catch (err) {
        console.error(`[DEBUG] [data.js unifiedDelete] FAILED at storage.remove().`, err);
        throw new Error("实体档案删除失败，操作已中止。");
    }
    
    console.log(`[DEBUG] [data.js unifiedDelete] Deleting from database.`);
    await executeDeletion(filesForStorage.map(f => f.message_id), foldersForStorage.map(f => f.id), userId);
    console.log(`[DEBUG] [data.js unifiedDelete] Deletion complete.`);
}


async function moveItems(fileItems = [], folderItems = [], targetFolderId, userId, overwrite = false) {
    console.log(`[DEBUG] [data.js moveItems] Low-level move called. Overwrite Flag: ${overwrite}`);
    const storage = require('./storage').getStorage();

    const targetPathParts = await getFolderPath(targetFolderId, userId);
    // 移除根目录的'/'，因为它会在 path.posix.join 中被处理
    const targetFullPath = path.posix.join(...targetPathParts.slice(1).map(p => p.name));
    console.log(`[DEBUG] [data.js moveItems] Target full path: /${targetFullPath}`);

    const fileIds = fileItems.map(item => item.id);
    const filesToMove = await getFilesByIds(fileIds, userId);
    const fileNameMap = new Map(fileItems.map(item => [item.id, item.name]));

    for (const file of filesToMove) {
        const newFileName = fileNameMap.get(file.message_id) || file.fileName;
        const oldRelativePath = file.file_id;
        const newRelativePath = path.posix.join('/', targetFullPath, newFileName);
        console.log(`[DEBUG] [data.js moveItems] Moving FILE from ${oldRelativePath} to ${newRelativePath}`);
        try {
            await storage.move(oldRelativePath, newRelativePath, overwrite);
            // Now update DB
            await new Promise((res, rej) => db.run('UPDATE files SET fileName = ?, file_id = ?, folder_id = ? WHERE message_id = ?', [newFileName, newRelativePath, targetFolderId, file.message_id], (e) => e ? rej(e) : res()));
            console.log(`[DEBUG] [data.js moveItems] DB updated for file ${newFileName}.`);
        } catch (err) {
            console.error(`[DEBUG] [data.js moveItems] FAILED to move file ${newFileName}.`, err);
            throw new Error(`物理移动文件 ${newFileName} 失败`);
        }
    }
    
    const folderIds = folderItems.map(item => item.id);
    const folderNameMap = new Map(folderItems.map(item => [item.id, item.name]));
    const foldersToMove = (await getItemsByIds(folderIds, userId)).filter(i => i.type === 'folder');

    for (const folder of foldersToMove) {
        const newFolderName = folderNameMap.get(folder.id) || folder.name;
        const oldPathParts = await getFolderPath(folder.id, userId);
        const oldFullPath = path.posix.join('/', ...oldPathParts.slice(1).map(p => p.name));
        const newFullPath = path.posix.join('/', targetFullPath, newFolderName);
        console.log(`[DEBUG] [data.js moveItems] Moving FOLDER from ${oldFullPath} to ${newFullPath}`);

        try {
            await storage.move(oldFullPath, newFullPath, overwrite);
            // Update all descendant files' paths
            const descendantFiles = await getFilesRecursive(folder.id, userId);
            console.log(`[DEBUG] [data.js moveItems] Found ${descendantFiles.length} descendant files to update.`);
            for (const file of descendantFiles) {
                const updatedFileId = file.file_id.replace(oldFullPath, newFullPath);
                await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id], (e) => e ? rej(e) : res()));
            }

            // Update folder's own DB record
            await new Promise((res, rej) => db.run(`UPDATE folders SET name = ?, parent_id = ? WHERE id = ?`, [newFolderName, targetFolderId, folder.id], (e) => e ? rej(e) : res()));
            console.log(`[DEBUG] [data.js moveItems] DB updated for folder ${newFolderName} and its descendants.`);

        } catch (err) {
            console.error(`[DEBUG] [data.js moveItems] FAILED to move folder ${newFolderName}.`, err);
            throw new Error(`物理移动文件夹 ${newFolderName} 失败`);
        }
    }
}


async function renameFile(messageId, newFileName, userId) {
    console.log(`[DEBUG] [data.js renameFile] Renaming fileId ${messageId} to "${newFileName}"`);
    const file = (await getFilesByIds([messageId], userId))[0];
    if (!file) {
        console.error(`[DEBUG] [data.js renameFile] File ${messageId} not found in DB.`);
        return { success: false, message: '文件未找到。' };
    }

    console.log(`[DEBUG] [data.js renameFile] Checking for conflict.`);
    const conflict = await checkFullConflict(newFileName, file.folder_id, userId);
    if (conflict) {
        console.error(`[DEBUG] [data.js renameFile] Conflict found. Aborting.`);
        throw new Error('目标文件夹中已存在同名项目。');
    }

    const storage = require('./storage').getStorage();
    const oldRelativePath = file.file_id;
    const newRelativePath = path.posix.join(path.posix.dirname(oldRelativePath), newFileName);
    console.log(`[DEBUG] [data.js renameFile] Physical rename from ${oldRelativePath} to ${newRelativePath}`);

    try {
        await storage.move(oldRelativePath, newRelativePath, false); // Rename should not overwrite
    } catch(err) {
        console.error(`[DEBUG] [data.js renameFile] FAILED at storage.move()`, err);
        throw new Error(`实体档案重新命名失败: ${err.message}`);
    }
    
    console.log(`[DEBUG] [data.js renameFile] Updating DB.`);
    const sql = `UPDATE files SET fileName = ?, file_id = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFileName, newRelativePath, messageId, userId], function(err) {
             if (err) {
                 console.error(`[DEBUG] [data.js renameFile] FAILED to update DB.`, err);
                 reject(err);
             }
             else {
                console.log(`[DEBUG] [data.js renameFile] Rename complete.`);
                resolve({ success: true });
             }
        });
    });
}

async function renameFolder(folderId, newFolderName, userId) {
    console.log(`[DEBUG] [data.js renameFolder] Renaming folderId ${folderId} to "${newFolderName}"`);
    const folder = await new Promise((res, rej) => db.get("SELECT * FROM folders WHERE id=?", [folderId], (e,r)=>e?rej(e):res(r)));
    if (!folder) {
        console.error(`[DEBUG] [data.js renameFolder] Folder ${folderId} not found in DB.`);
        return { success: false, message: '资料夹未找到。'};
    }
    
    if (folder.parent_id === null) {
        console.error(`[DEBUG] [data.js renameFolder] Attempt to rename root folder. Aborting.`);
        throw new Error('无法重新命名根目录。');
    }

    console.log(`[DEBUG] [data.js renameFolder] Checking for conflict.`);
    const conflict = await checkFullConflict(newFolderName, folder.parent_id, userId);
    if (conflict) {
        console.error(`[DEBUG] [data.js renameFolder] Conflict found. Aborting.`);
        throw new Error('目标文件夹中已存在同名项目。');
    }
    
    const storage = require('./storage').getStorage();
    const oldPathParts = await getFolderPath(folderId, userId);
    const oldFullPath = path.posix.join('/', ...oldPathParts.slice(1).map(p => p.name));
    const newFullPath = path.posix.join(path.posix.dirname(oldFullPath), newFolderName);
    console.log(`[DEBUG] [data.js renameFolder] Physical rename from ${oldFullPath} to ${newFullPath}`);

    try {
        await storage.move(oldFullPath, newFullPath, false); // Rename should not overwrite
        
        console.log(`[DEBUG] [data.js renameFolder] Physical move successful. Updating descendant file paths in DB.`);
        const descendantFiles = await getFilesRecursive(folderId, userId);
        console.log(`[DEBUG] [data.js renameFolder] Found ${descendantFiles.length} descendants to update.`);
        for (const file of descendantFiles) {
            const updatedFileId = file.file_id.replace(oldFullPath, newFullPath);
            await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', [updatedFileId, file.message_id], (e) => e ? rej(e) : res()));
        }
    } catch(e) {
        console.error(`[DEBUG] [data.js renameFolder] FAILED at storage.move()`, e);
        throw new Error(`物理资料夹重新命名失败: ${e.message}`);
    }

    console.log(`[DEBUG] [data.js renameFolder] Updating folder name in DB.`);
    const sql = `UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFolderName, folderId, userId], function(err) {
            if (err) {
                 console.error(`[DEBUG] [data.js renameFolder] FAILED to update DB.`, err);
                reject(err);
            }
            else if (this.changes === 0) resolve({ success: false, message: '资料夹未找到。' });
            else {
                console.log(`[DEBUG] [data.js renameFolder] Rename complete.`);
                resolve({ success: true });
            }
        });
    });
}
// ... (所有其他非檔案操作函數，如 shares, etc. 保持不變)
async function renameAndMoveFile(messageId, newFileName, targetFolderId, userId) {
    console.log(`[DEBUG] [data.js renameAndMoveFile] Called.`);
    const file = (await getFilesByIds([messageId], userId))[0];
    if (!file) throw new Error('File not found for rename and move');

    const storage = require('./storage').getStorage();
    const targetPathParts = await getFolderPath(targetFolderId, userId);
    const targetRelativePath = path.posix.join(...targetPathParts.slice(1).map(p => p.name));
    const newRelativePath = path.posix.join('/', targetRelativePath, newFileName);
    const oldRelativePath = file.file_id;
    console.log(`[DEBUG] [data.js renameAndMoveFile] Physical move from ${oldRelativePath} to ${newRelativePath}`);
    
    try {
        await storage.move(oldRelativePath, newRelativePath, false); // Renaming should not overwrite
    } catch(err) {
        console.error(`[DEBUG] [data.js renameAndMoveFile] FAILED at storage.move()`, err);
        throw new Error(`实体档案移动并重命名失败`);
    }
    
    console.log(`[DEBUG] [data.js renameAndMoveFile] Updating DB.`);
    const sql = `UPDATE files SET fileName = ?, file_id = ?, folder_id = ? WHERE message_id = ? AND user_id = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [newFileName, newRelativePath, targetFolderId, messageId, userId], (err) => err ? reject(err) : resolve({ success: true }));
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

    const allUserFolders = await getAllFolders(userId);
    const folderMap = new Map(allUserFolders.map(f => [f.id, f]));
    
    function buildPath(fId) {
        let pathParts = [];
        let current = folderMap.get(fId);
        while(current && current.parent_id) {
            pathParts.unshift(current.name);
            current = folderMap.get(current.parent_id);
        }
        return path.join(...pathParts);
    }

    const foldersToDeleteWithPaths = foldersToDeleteIds.map(id => ({
        id: id,
        path: buildPath(id)
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
};
