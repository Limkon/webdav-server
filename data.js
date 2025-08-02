const db = require('./database.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

// ... (createUser, findUserByName, findUserById, changeUserPassword, listNormalUsers, listAllUsers, deleteUser 函数保持不变) ...

function findFolderById(id, userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM folders WHERE id = ? AND user_id = ?", [id, userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
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

async function getFolderContents(folderId, userId) {
    const folder = await findFolderById(folderId, userId);
    // 如果是根目录，则显示 WebDAV 挂载点作为子目录
    if (folder && folder.parent_id === null) {
        const mounts = await getWebdavMounts(userId);
        const mountFolders = await Promise.all(mounts.map(async mount => {
            let existingFolder = await findFolderByName(mount.mount_name, folderId, userId);
            if (!existingFolder) {
                const result = await createFolder(mount.mount_name, folderId, userId, mount.id);
                existingFolder = { id: result.id };
            }
            return {
                id: existingFolder.id,
                name: mount.mount_name,
                parent_id: folderId,
                type: 'folder',
                is_mount_point: true // 自定义属性用于前端识别
            };
        }));
        return { folders: mountFolders, files: [] };
    }

    // 否则，正常获取文件夹内容
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


async function moveItem(itemId, itemType, targetFolderId, userId, options = {}) {
    const report = { moved: 0, skipped: 0, errors: 0 };
    const { resolutions = {}, pathPrefix = '' } = options;

    const sourceItem = (await getItemsByIds([itemId], userId, itemType))[0];
    if (!sourceItem) {
        report.errors++;
        return report;
    }
    
    // 检查跨 WebDAV 挂载点移动
    const sourceFolder = await findFolderById(itemType === 'folder' ? itemId : sourceItem.parent_id, userId);
    const targetFolder = await findFolderById(targetFolderId, userId);

    if (sourceFolder.webdav_mount_id !== targetFolder.webdav_mount_id) {
         throw new Error('不允许跨 WebDAV 挂载点移动文件或资料夹。');
    }
    
    if (itemType === 'folder' && sourceItem.parent_id === null) {
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
    if (!targetFolder.webdav_mount_id) {
        throw new Error("移动目标不是有效的 WebDAV 挂载子目录。");
    }
    const mountId = targetFolder.webdav_mount_id;

    for (const fileItem of fileItems) {
        const { remotePath: sourcePath } = await storage.getRemotePath(fileItem.id, 'file', userId);
        const { remotePath: targetFolderPath } = await storage.getRemotePath(targetFolderId, 'folder', userId);
        const destinationPath = path.posix.join(targetFolderPath, fileItem.name);
        
        await storage.move(sourcePath, destinationPath, mountId, overwrite);
        await new Promise((res, rej) => db.run('UPDATE files SET fileName = ?, file_id = ?, folder_id = ? WHERE message_id = ?', 
            [fileItem.name, destinationPath, targetFolderId, fileItem.id], (e) => e ? rej(e) : res()));
    }
    
    for (const folderItem of folderItems) {
        const { remotePath: sourcePath } = await storage.getRemotePath(folderItem.id, 'folder', userId);
        const { remotePath: targetFolderPath } = await storage.getRemotePath(targetFolderId, 'folder', userId);
        const destinationPath = path.posix.join(targetFolderPath, folderItem.name);
        
        await storage.move(sourcePath, destinationPath, mountId, overwrite);
        
        const descendantFiles = await getFilesRecursive(folderItem.id, userId);
        for (const file of descendantFiles) {
            const updatedFileId = file.file_id.replace(sourcePath, destinationPath);
            await new Promise((res, rej) => db.run('UPDATE files SET file_id = ? WHERE message_id = ?', 
                [updatedFileId, file.message_id], (e) => e ? rej(e) : res()));
        }
        
        await new Promise((res, rej) => db.run(`UPDATE folders SET name = ?, parent_id = ? WHERE id = ?`, 
            [folderItem.name, targetFolderId, folderItem.id], (e) => e ? rej(e) : res()));
    }
}
//... 其他函数 (createFolder, addFile 等) 也需要相应修改以包含 webdav_mount_id ...

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

module.exports = {
    // ... 导出所有函数
    createUser,
    findUserByName,
    findUserById,
    changeUserPassword,
    listNormalUsers,
    listAllUsers,
    deleteUser,
    getFolderContents,
    // ...
    createFolder,
    addFile,
    findFolderById,
    getWebdavMounts,
    setWebdavMountFullStatus
};
