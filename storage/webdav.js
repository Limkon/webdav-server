const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

// 管理多个 WebDAV 客户端实例
let clients = new Map();

// 辅助函数：从 file_id 中解析出挂载点名称和真实路径
function parseWebdavPath(filePath) {
    if (!filePath) throw new Error('无效的 WebDAV 路径');
    const parts = filePath.replace(/^\//, '').split('/');
    const mountName = parts.shift();
    const remotePath = '/' + parts.join('/');
    return { mountName, remotePath };
}


// 辅助函数：根据挂载点名称获取客户端和配置
function getClientAndConfig(mountName) {
    if (clients.has(mountName)) {
        return clients.get(mountName);
    }

    const storageManager = require('./index');
    const config = storageManager.readConfig();
    const webdavConfig = config.webdav.find(c => c.name === mountName);

    if (!webdavConfig) {
        throw new Error(`找不到名为 "${mountName}" 的 WebDAV 挂载设定`);
    }

    const client = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    
    const clientData = { client, config: webdavConfig };
    clients.set(mountName, clientData);
    return clientData;
}


// 重置所有客户端实例
function resetClients() {
    clients.clear();
}

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
    // 移除根目录'/'，因为它不属于远端路径的一部分
    return pathParts.slice(1).map(p => p.name).join('/');
}


async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const fullFolderPath = await getFolderPath(folderId, userId);
    const { mountName, remotePath: folderRemotePath } = parseWebdavPath(fullFolderPath);
    
    const { client } = getClientAndConfig(mountName);

    const remotePath = path.posix.join(folderRemotePath, fileName);
    const remoteDir = path.posix.dirname(remotePath);

    if (remoteDir && remoteDir !== "/") {
        try {
            // WebDAV 创建目录需要递归创建
            await client.createDirectory(remoteDir, { recursive: true });
        } catch (e) {
            // 如果目录已存在，某些服务器会报 405 Method Not Allowed 或 501 Not Implemented，这可以安全地忽略
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
    
    // file_id 现在储存的是 "挂载点名称/远端路径"
    const fileIdForDb = path.posix.join(mountName, remotePath);
    const stat = await client.stat(remotePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stat.size,
        file_id: fileIdForDb,
        date: new Date(stat.lastmod).getTime(),
    }, folderId, userId, 'webdav');
    
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}


async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const itemsByMount = new Map();

    // 1. 按挂载点对所有待删除项进行分组
    const allItems = [
        ...files.map(f => ({ path: f.file_id, type: 'file' })),
        ...folders.map(f => ({ path: f.path, type: 'folder' }))
    ];

    for (const item of allItems) {
        try {
            const { mountName, remotePath } = parseWebdavPath(item.path);
            if (!itemsByMount.has(mountName)) {
                itemsByMount.set(mountName, []);
            }
            itemsByMount.get(mountName).push({ path: remotePath, type: item.type });
        } catch (e) {
            results.errors.push(`解析路径 "${item.path}" 失败: ${e.message}`);
            results.success = false;
        }
    }

    // 2. 遍历每个挂载点，执行删除操作
    for (const [mountName, itemsToDelete] of itemsByMount.entries()) {
        try {
            const { client } = getClientAndConfig(mountName);

            // 按路径深度降序排序，确保先删除子项
            itemsToDelete.sort((a, b) => b.path.length - a.path.length);

            for (const item of itemsToDelete) {
                try {
                    await client.deleteFile(item.path);
                } catch (error) {
                    if (!(error.response && error.response.status === 404)) {
                        const errorMessage = `删除 WebDAV [${mountName}:${item.path}] 失败: ${error.message}`;
                        console.error(errorMessage);
                        results.errors.push(errorMessage);
                        results.success = false;
                    }
                }
            }
        } catch (mountError) {
             results.errors.push(`处理挂载点 "${mountName}" 时出错: ${mountError.message}`);
             results.success = false;
        }
    }

    return results;
}


async function stream(file_id, userId) {
    const { mountName, remotePath } = parseWebdavPath(file_id);
    const { config } = getClientAndConfig(mountName);
    
    // 为每个流操作创建一个独立的客户端实例以避免冲突
    const streamClient = createClient(config.url, {
        username: config.username,
        password: config.password
    });

    return streamClient.createReadStream(remotePath);
}


async function getUrl(file_id, userId) {
    const { mountName, remotePath } = parseWebdavPath(file_id);
    const { client } = getClientAndConfig(mountName);
    return client.getFileDownloadLink(remotePath);
}

module.exports = { 
    upload, 
    remove, 
    getUrl, 
    stream, 
    resetClients, // 导出重置函数
    type: 'webdav' 
};
