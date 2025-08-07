const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fs = require('fs'); 
const path = require('path');
const storageManager = require('./index');

// 移除单一的 client 实例

// 动态获取客户端，现在需要传入挂载点名称
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

// resetClient 不再需要，因为我们不再缓存 client

async function getFolderPath(folderId, userId) {
    const userRoot = await new Promise((resolve, reject) => {
        db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId], (err, row) => {
            if (err) return reject(err);
            if (!row) return reject(new Error('找不到使用者根目录'));
            resolve(row);
        });
    });

    if (folderId === userRoot.id) return '/';
    
    const pathParts = await data.getFolderPath(folderId, userId);
    // 路径现在包含挂载点名称，我们需要移除第一个部分（挂载点）
    return '/' + pathParts.slice(1).map(p => p.name).join('/');
}

// 上传逻辑现在需要挂载点名称
async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '') {
    const folderPathParts = await data.getFolderPath(folderId, userId);
    if (folderPathParts.length < 2) {
        throw new Error("无效的目标资料夹，无法确定挂载点。");
    }
    const mountName = folderPathParts[1].name;
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
    
    const success = await client.putFileContents(remotePath, fileStream, { overwrite: true });

    if (!success) {
        throw new Error('WebDAV putFileContents 操作失败');
    }

    const stats = await client.stat(remotePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
    
    // file_id 现在储存包含挂载点的完整路径
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
    // 按挂载点对项目进行分组
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

        for (const item of allItemsToDelete) {
            try {
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

// 流操作现在需要挂载点信息
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
    const remotePath = fullPath.substring(mountName.length);
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
