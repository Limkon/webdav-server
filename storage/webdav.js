const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fs = require('fs'); 
const path = require('path');
const storageManager = require('./index');

// 动态获取客户端
function getClient(mountName) {
    const webdavConfig = storageManager.getWebdavConfigByName(mountName);
    if (!webdavConfig) {
        throw new Error(`找不到名为 '${mountName}' 的 WebDAV 挂载点设定`);
    }
    return createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
}

// 上传逻辑
async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '') {
    const rootFolder = await data.getRootFolder(userId);
    if(folderId === rootFolder.id) {
         throw new Error("逻辑错误：无法上传到根目录。请选择一个挂载点内的资料夹。");
    }

    const folderPathParts = await data.getFolderPath(folderId, userId);
    if (folderPathParts.length < 2) {
        throw new Error("无效的目标资料夹，无法确定挂载点。");
    }
    const mountName = folderPathParts[1].name;

    // --- 熔断机制：检查点 ---
    if (storageManager.isMountFull(mountName)) {
        throw new Error(`WebDAV [${mountName}] 容量已满，上传操作已熔断。`);
    }

    const client = getClient(mountName);

    const remoteFolderPath = '/' + folderPathParts.slice(2).map(p => p.name).join('/');
    const remotePath = (remoteFolderPath === '/' ? '' : remoteFolderPath) + '/' + fileName;

    if (remoteFolderPath && remoteFolderPath !== "/") {
        try {
            await client.createDirectory(remoteFolderPath, { recursive: true });
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }
    
    try {
        const success = await client.putFileContents(remotePath, fileStream, { overwrite: true });
        if (!success) {
            throw new Error('WebDAV putFileContents 操作失败');
        }
    } catch (error) {
        // --- 熔断机制：触发点 ---
        if (error.response && error.response.status === 507) { // HTTP 507 Insufficient Storage
            storageManager.setMountFull(mountName, true);
            throw new Error(`WebDAV [${mountName}] 容量已满，上传失败。熔断机制已启动。`);
        }
        throw error; // 重新抛出其他错误
    }

    const stats = await client.stat(remotePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
    
    const fileIdForDb = path.posix.join(mountName, remotePath);

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stats.size,
        file_id: fileIdForDb,
        date: Date.now(),
    }, folderId, userId, 'webdav');
    
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}


async function remove(files, folders, userId) {
    const itemsByMount = {};

    for (const file of files) {
        const mountName = file.file_id.split('/')[0];
        if (!itemsByMount[mountName]) itemsByMount[mountName] = { files: [], folders: [] };
        itemsByMount[mountName].files.push(file);
    }

    for (const folder of folders) {
        const folderPathParts = await data.getFolderPath(folder.id, userId);
        if (folderPathParts.length > 1) {
            const mountName = folderPathParts[1].name;
            if (!itemsByMount[mountName]) itemsByMount[mountName] = { files: [], folders: [] };
            const relativePath = path.posix.join(...folderPathParts.slice(2).map(p => p.name));
            itemsByMount[mountName].folders.push({ path: relativePath });
        }
    }

    const results = { success: true, errors: [] };

    for (const mountName in itemsByMount) {
        const client = getClient(mountName);
        const { files, folders } = itemsByMount[mountName];
        
        const allItemsToDelete = [];
        files.forEach(file => {
            let p = file.file_id.substring(mountName.length);
            allItemsToDelete.push({ path: path.posix.normalize(p), type: 'file' });
        });
        folders.forEach(folder => {
            if (folder.path) {
                let p = '/' + folder.path;
                if (!p.endsWith('/')) p += '/';
                allItemsToDelete.push({ path: p, type: 'folder' });
            }
        });
        
        allItemsToDelete.sort((a, b) => b.path.length - a.path.length);
        let successfullyDeleted = false;

        for (const item of allItemsToDelete) {
            try {
                await client.deleteFile(item.path);
                successfullyDeleted = true;
            } catch (error) {
                if (!(error.response && error.response.status === 404)) {
                    const errorMessage = `删除 WebDAV [${mountName}${item.path}] 失败: ${error.message}`;
                    results.errors.push(errorMessage);
                    results.success = false;
                } else {
                    successfullyDeleted = true; // 如果档案本就不存在，也视为成功，以便清除资料库
                }
            }
        }
        
        // --- 熔断机制：重置点 ---
        if (successfullyDeleted) {
            storageManager.clearMountStatus(mountName);
        }
    }

    return results;
}

async function stream(file_id, userId) {
    const mountName = file_id.split('/')[0];
    const remotePath = file_id.substring(mountName.length);
    const client = getClient(mountName);
    return client.createReadStream(remotePath);
}

async function getUrl(file_id, userId) {
    const mountName = file_id.split('/')[0];
    const remotePath = file_id.substring(mountName.length);
    const client = getClient(mountName);
    return client.getFileDownloadLink(remotePath);
}

async function createDirectory(fullPath) {
    const mountName = fullPath.split('/')[0];
    const remotePath = '/' + fullPath.substring(mountName.length + 1);
    const client = getClient(mountName);
    try {
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

module.exports = { upload, remove, getUrl, stream, getClient, createDirectory, type: 'webdav' };
