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
    // [DEBUG] 日志：显示正在使用的 WebDAV 客户端设定
    // console.log(`[DEBUG] [WebDAV] Creating client for mount: '${mountName}' with URL: ${webdavConfig.url}`);
    return createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
}

// 上传逻辑
async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '') {
    // [DEBUG] 日志：进入上传函数
    // console.log(`[DEBUG] [WebDAV] Starting upload for user ${userId}, folder ${folderId}, file "${fileName}"`);

    // **新增**：在函数开头进行双重检查，防止上传到根目录
    const rootFolder = await data.getRootFolder(userId);
    if(folderId === rootFolder.id) {
         throw new Error("逻辑错误：无法上传到根目录。请选择一个挂载点内的资料夹。");
    }

    const folderPathParts = await data.getFolderPath(folderId, userId);
    if (folderPathParts.length < 2) {
        // 这个错误现在理论上不应该再被触发，但作为最后的防线保留
        throw new Error("无效的目标资料夹，无法确定挂载点。");
    }
    const mountName = folderPathParts[1].name;
    const client = getClient(mountName);

    const remoteFolderPath = '/' + folderPathParts.slice(2).map(p => p.name).join('/');
    const remotePath = (remoteFolderPath === '/' ? '' : remoteFolderPath) + '/' + fileName;

    // [DEBUG] 日志：显示最终的远端路径
    // console.log(`[DEBUG] [WebDAV] Calculated remote path: '${remotePath}' on mount '${mountName}'`);

    if (remoteFolderPath && remoteFolderPath !== "/") {
        try {
            await client.createDirectory(remoteFolderPath, { recursive: true });
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }
    
    const success = await client.putFileContents(remotePath, fileStream, { overwrite: true });

    if (!success) {
        throw new Error('WebDAV putFileContents 操作失败');
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
    
    // [DEBUG] 日志：上传成功
    // console.log(`[DEBUG] [WebDAV] Upload successful for file "${fileName}", DB ID: ${dbResult.id}`);
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
        // [DEBUG] 日志：删除操作
        // console.log(`[DEBUG] [WebDAV] Performing delete on mount '${mountName}'`);
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

        for (const item of allItemsToDelete) {
            try {
                // [DEBUG] 日志：删除单个项目
                // console.log(`[DEBUG] [WebDAV] Deleting item: ${item.path}`);
                await client.deleteFile(item.path);
            } catch (error) {
                if (!(error.response && error.response.status === 404)) {
                    const errorMessage = `删除 WebDAV [${mountName}${item.path}] 失败: ${error.message}`;
                    results.errors.push(errorMessage);
                    results.success = false;
                }
            }
        }
    }

    return results;
}

// 流操作
async function stream(file_id, userId) {
    const mountName = file_id.split('/')[0];
    const remotePath = file_id.substring(mountName.length);
    // [DEBUG] 日志：创建读取流
    // console.log(`[DEBUG] [WebDAV] Creating read stream for '${remotePath}' on mount '${mountName}'`);
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
    const remotePath = fullPath.substring(mountName.length);
    // [DEBUG] 日志：创建目录
    // console.log(`[DEBUG] [WebDAV] Creating directory '${remotePath}' on mount '${mountName}'`);
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
