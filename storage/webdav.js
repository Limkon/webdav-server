const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

// --- 关键修改：移除单一 client 实例 ---
// let client = null; // 不再需要

// --- 新增：根据设定动态创建 client ---
function getClientForConfig(webdavConfig) {
    if (!webdavConfig || !webdavConfig.url) {
        throw new Error('WebDAV 设定不完整或未提供');
    }
    return createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
}

async function getFolderPath(folderId, userId) {
    const userRoot = await new Promise((resolve, reject) => {
        db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId], (err, row) => {
            if (err) return reject(err);
            if (!row) return reject(new Error('找不到使用者根目录'));
            resolve(row.id);
        });
    });

    if (folderId === userRoot) return '/';
    
    const pathParts = await data.getFolderPath(folderId, userId);
    // 移除代表 WebDAV 挂载点的第一层目录
    return '/' + pathParts.slice(2).map(p => p.name).join('/');
}


async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const webdavConfig = await data.getWebdavConfigForFolder(folderId, userId);
    if (!webdavConfig) throw new Error('无法找到此目录关联的 WebDAV 设定');

    const client = getClientForConfig(webdavConfig);
    const folderPath = await getFolderPath(folderId, userId);
    const remotePath = path.posix.join(folderPath, fileName);
    
    if (folderPath && folderPath !== "/") {
        try {
            // WebDAV 远端伺服器上不需要递归创建挂载点名称
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }

    const fileBuffer = await fsp.readFile(tempFilePath);
    const success = await client.putFileContents(remotePath, fileBuffer, { overwrite: true });

    if (!success) {
        throw new Error('WebDAV putFileContents 操作失败');
    }

    const stat = await client.stat(remotePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stat.size,
        file_id: remotePath, // 储存相对于 WebDAV 根的路径
        date: new Date(stat.lastmod).getTime(),
    }, folderId, userId, 'webdav', webdavConfig.id); // 传入 webdav_config_id
    
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}

async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const itemsByConfig = new Map();

    // 1. 按 webdav_config_id 分组
    for (const file of files) {
        if (!itemsByConfig.has(file.webdav_config_id)) {
            itemsByConfig.set(file.webdav_config_id, []);
        }
        itemsByConfig.get(file.webdav_config_id).push({ path: file.file_id, type: 'file' });
    }
    for (const folder of folders) {
         if (!itemsByConfig.has(folder.webdav_config_id)) {
            itemsByConfig.set(folder.webdav_config_id, []);
        }
        itemsByConfig.get(folder.webdav_config_id).push({ path: folder.path, type: 'folder' });
    }

    // 2. 为每个 WebDAV 设定分别执行删除
    for (const [configId, items] of itemsByConfig.entries()) {
        const webdavConfig = await data.getWebdavConfigById(configId, userId);
        if (!webdavConfig) {
            results.errors.push(`找不到 ID 为 ${configId} 的 WebDAV 设定`);
            continue;
        }
        const client = getClientForConfig(webdavConfig);
        items.sort((a, b) => b.path.length - a.path.length); // 确保先删子项

        for (const item of items) {
            try {
                // 如果是资料夹，确保路径以 '/' 结尾
                let deletePath = item.path;
                if (item.type === 'folder' && !deletePath.endsWith('/')) {
                    deletePath += '/';
                }
                await client.deleteFile(deletePath);
            } catch (error) {
                if (!(error.response && error.response.status === 404)) {
                    const errorMessage = `从 [${webdavConfig.mount_name}] 删除 [${item.path}] 失败: ${error.message}`;
                    results.errors.push(errorMessage);
                    results.success = false;
                }
            }
        }
    }
    return results;
}

async function stream(file_id, userId, webdavConfigId) {
    const webdavConfig = await data.getWebdavConfigById(webdavConfigId, userId);
    const streamClient = getClientForConfig(webdavConfig);
    return streamClient.createReadStream(path.posix.join('/', file_id));
}

async function getUrl(file_id, userId, webdavConfigId) {
    const webdavConfig = await data.getWebdavConfigById(webdavConfigId, userId);
    const client = getClientForConfig(webdavConfig);
    return client.getFileDownloadLink(path.posix.join('/', file_id));
}

async function createDirectory(fullPath, webdavConfig) {
    const client = getClientForConfig(webdavConfig);
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

// 移除 resetClient 和 getClient，因为 client 是动态的
module.exports = { upload, remove, getUrl, stream, createDirectory, type: 'webdav' };
