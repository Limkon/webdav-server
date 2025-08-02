const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

// 使用 Map 来缓存不同 WebDAV 设定的客户端实例
const clients = new Map();

async function getWebdavConfig(mountId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM webdav_configs WHERE id = ?', [mountId], (err, row) => {
            if (err) return reject(new Error('查询 WebDAV 设定时发生错误'));
            if (!row) return reject(new Error(`找不到 ID 为 ${mountId} 的 WebDAV 设定`));
            resolve(row);
        });
    });
}

async function getClient(mountId) {
    if (clients.has(mountId)) {
        return clients.get(mountId);
    }
    
    console.log(`[DEBUG] [storage/webdav.js] Creating new WebDAV client for mount ID: ${mountId}`);
    const webdavConfig = await getWebdavConfig(mountId);
    
    const newClient = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    clients.set(mountId, newClient);
    return newClient;
}

function resetClient(mountId) {
    if (mountId) {
        console.log(`[DEBUG] [storage/webdav.js] Resetting WebDAV client for mount ID: ${mountId}`);
        clients.delete(mountId);
    } else {
        console.log('[DEBUG] [storage/webdav.js] Resetting all WebDAV clients.');
        clients.clear();
    }
}

async function getRemotePath(itemId, itemType, userId) {
    let item;
    if (itemType === 'folder') {
        item = await data.findFolderById(itemId, userId);
    } else {
        item = (await data.getFilesByIds([itemId], userId))[0];
    }

    if (!item) throw new Error('项目未找到');
    
    const mountId = item.webdav_mount_id;
    if (!mountId) {
        const rootFolder = await data.getRootFolder(userId);
        if (item.id === rootFolder.id) { // 是根目录
            return { remotePath: '/', mountId: null };
        }
        throw new Error('项目不属于任何 WebDAV 挂载点');
    }
    
    const pathParts = await data.getFolderPath(itemType === 'folder' ? itemId : item.folder_id, userId);
    // 移除代表挂载点的第一层目录
    const relativePath = path.posix.join(...pathParts.slice(1).map(p => p.name));
    
    const remotePath = itemType === 'file' ? path.posix.join('/', relativePath, item.fileName) : path.posix.join('/', relativePath);
    console.log(`[DEBUG] [storage/webdav.js getRemotePath] Resolved item ID ${itemId} to remote path: ${remotePath} on mount ${mountId}`);
    return { remotePath, mountId };
}

async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    console.log(`[DEBUG] [storage/webdav.js upload] Starting upload. tempFilePath=${tempFilePath}, fileName=${fileName}, folderId=${folderId}`);
    
    const targetFolder = await data.findFolderById(folderId, userId);
    if (!targetFolder || !targetFolder.webdav_mount_id) {
        throw new Error('上传目标资料夹无效或不是一个 WebDAV 挂载子目录');
    }
    const mountId = targetFolder.webdav_mount_id;

    // 熔断机制：检查 WebDAV 目录是否已满
    const mountConfig = await getWebdavConfig(mountId);
    if (mountConfig.is_full) {
        throw new Error(`WebDAV 储存空间 (${mountConfig.mount_name}) 可能已满，上传操作已暂停。请删除一些档案后再试。`);
    }

    const client = await getClient(mountId);
    const { remotePath: folderRemotePath } = await getRemotePath(folderId, 'folder', userId);
    const remotePath = path.posix.join(folderRemotePath, fileName);
    console.log(`[DEBUG] [storage/webdav.js upload] Remote path determined as: ${remotePath}`);
    
    if (folderRemotePath && folderRemotePath !== "/") {
        try {
            await client.createDirectory(folderRemotePath, { recursive: true });
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }

    const fileBuffer = await fsp.readFile(tempFilePath);
    try {
        const success = await client.putFileContents(remotePath, fileBuffer, { overwrite: true });
        if (!success) throw new Error('WebDAV putFileContents 操作失败');
    } catch (error) {
        if (error.response && error.response.status === 507) {
            await data.setWebdavMountFullStatus(mountId, true);
            throw new Error(`上传失败：WebDAV 储存空间不足 (507)。该挂载点已被标记为已满。`);
        }
        throw error;
    }

    const stat = await client.stat(remotePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stat.size,
        file_id: remotePath,
        date: new Date(stat.lastmod).getTime(),
    }, folderId, userId, 'webdav', mountId);
    
    console.log(`[DEBUG] [storage/webdav.js upload] Upload complete. DB result fileId: ${dbResult.fileId}`);
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}

async function move(sourcePath, destinationPath, mountId, overwrite = false) {
    console.log(`[DEBUG] [storage/webdav.js move] Initiating move on mount ${mountId}.`);
    console.log(`  - Source: ${sourcePath}`);
    console.log(`  - Destination: ${destinationPath}`);
    console.log(`  - Overwrite: ${overwrite}`);
    
    const client = await getClient(mountId);
    try {
        await client.moveFile(sourcePath, destinationPath, { overwrite });
        console.log(`[DEBUG] [storage/webdav.js move] Move successful.`);
        return true;
    } catch (error) {
        console.error(`[DEBUG] [storage/webdav.js move] caught an ERROR during moveFile.`);
        if (error.response) {
            console.error(`  - Error Status: ${error.response.status}`);
            console.error(`  - Error Data:`, error.response.data);
        } else {
            console.error(`  - Error Message: ${error.message}`);
        }
        throw error;
    }
}

async function remove(files, folders, userId) {
    console.log(`[DEBUG] [storage/webdav.js remove] Initiating remove for ${files.length} files and ${folders.length} folders.`);
    const results = { success: true, errors: [] };
    const mountsWithDeletions = new Set();

    const allItemsToDelete = [];
    
    files.forEach(file => {
        if(file.webdav_mount_id) {
            allItemsToDelete.push({ path: file.file_id, type: 'file', mountId: file.webdav_mount_id });
            mountsWithDeletions.add(file.webdav_mount_id);
        }
    });
    
    folders.forEach(folder => {
        if (folder.path && folder.path !== '/' && folder.webdav_mount_id) {
            allItemsToDelete.push({ path: folder.path, type: 'folder', mountId: folder.webdav_mount_id });
            mountsWithDeletions.add(folder.webdav_mount_id);
        }
    });

    allItemsToDelete.sort((a, b) => b.path.length - a.path.length);

    for (const item of allItemsToDelete) {
        try {
            const client = await getClient(item.mountId);
            console.log(`[DEBUG] [storage/webdav.js remove] Attempting to delete: ${item.path} on mount ${item.mountId}`);
            await client.deleteFile(item.path);
            console.log(`[DEBUG] [storage/webdav.js remove] Successfully deleted: ${item.path}`);
        } catch (error) {
            if (error.response && error.response.status === 404) {
                 console.log(`[DEBUG] [storage/webdav.js remove] Item not found, skipping: ${item.path}`);
            } else {
                const errorMessage = `删除 WebDAV ${item.type} [${item.path}] 失败: ${error.message}`;
                console.error(`[DEBUG] [storage/webdav.js remove] ERROR: ${errorMessage}`);
                results.errors.push(errorMessage);
                results.success = false;
            }
        }
    }
    
    // 只要有删除操作，就假定空间可能已经释放，移除熔断标记
    for (const mountId of mountsWithDeletions) {
        await data.setWebdavMountFullStatus(mountId, false);
    }

    return results;
}

async function stream(file_id, userId, mountId) {
    console.log(`[DEBUG] [storage/webdav.js stream] Creating stream for file: ${file_id} on mount ${mountId}`);
    const client = await getClient(mountId);
    return client.createReadStream(path.posix.join('/', file_id));
}

async function getUrl(file_id, userId, mountId) {
    const client = await getClient(mountId);
    return client.getFileDownloadLink(path.posix.join('/', file_id));
}

async function createDirectory(fullPath, mountId) {
    const client = await getClient(mountId);
    try {
        const remotePath = path.posix.join('/', fullPath);
        if (await client.exists(remotePath)) {
            return true;
        }
        await client.createDirectory(remotePath, { recursive: true });
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) {
            return true;
        }
        throw new Error(`建立 WebDAV 目录失败: ${e.message}`);
    }
}

module.exports = { 
    upload, 
    remove, 
    getUrl, 
    stream, 
    resetClient, 
    getClient, 
    createDirectory, 
    move, 
    getRemotePath,
    type: 'webdav' 
};
