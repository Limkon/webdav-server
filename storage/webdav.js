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
    const relativePath = parts.join('/');
    return { mountName, relativePath };
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

// *** 新增：建立远端目录的核心函数 ***
async function createRemoteDirectoryRecursive(client, fullRemotePath) {
    const remoteDir = path.posix.dirname(fullRemotePath);
    if (remoteDir && remoteDir !== "/" && remoteDir !== ".") {
        try {
            await client.createDirectory(remoteDir, { recursive: true });
        } catch (e) {
            // 如果目录已存在，某些服务器会报 405 Method Not Allowed 或 501 Not Implemented，这可以安全地忽略
            if (e.response && (e.response.status !== 405 && e.response.status !== 501 && e.response.status !== 409)) {
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }
}


async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const dbFolderPath = await getFolderPath(folderId, userId);
    const { mountName, relativePath: folderRelativePath } = parseWebdavPath(dbFolderPath);
    
    const { client } = getClientAndConfig(mountName);

    // *** 修改：远端路径包含挂载点名称作为子目录 ***
    const remoteFilePath = path.posix.join('/', mountName, folderRelativePath, fileName);
    
    // 建立远端目录
    await createRemoteDirectoryRecursive(client, remoteFilePath);

    const fileBuffer = await fsp.readFile(tempFilePath);
    const success = await client.putFileContents(remoteFilePath, fileBuffer, { overwrite: true });

    if (!success) {
        throw new Error('WebDAV putFileContents 操作失败');
    }
    
    // file_id 储存的是 "挂载点名称/远端相对路径"
    const fileIdForDb = path.posix.join(mountName, folderRelativePath, fileName);
    const stat = await client.stat(remoteFilePath);
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

    // 按挂载点对所有待删除项进行分组
    const allItems = [
        ...files.map(f => ({ path: f.file_id, type: 'file' })),
        // *** 修改：资料夹路径现在也包含挂载点 ***
        ...folders.map(f => ({ path: f.path.startsWith('/') ? f.path.substring(1) : f.path, type: 'folder' }))
    ];

    for (const item of allItems) {
        try {
            // *** 修改：远端路径现在需要加上挂载点名称作为前缀 ***
            const { mountName, relativePath } = parseWebdavPath(item.path);
            const remotePath = path.posix.join('/', mountName, relativePath);

            if (!itemsByMount.has(mountName)) {
                itemsByMount.set(mountName, []);
            }
            itemsByMount.get(mountName).push({ path: remotePath, type: item.type });
        } catch (e) {
            results.errors.push(`解析路径 "${item.path}" 失败: ${e.message}`);
            results.success = false;
        }
    }

    // 遍历每个挂载点，执行删除操作
    for (const [mountName, itemsToDelete] of itemsByMount.entries()) {
        try {
            const { client } = getClientAndConfig(mountName);
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

// *** 新生：在 WebDAV 上建立资料夹的独立函数 ***
async function createDirectory(mountName, relativePath) {
    const { client } = getClientAndConfig(mountName);
    const remotePath = path.posix.join('/', mountName, relativePath);
    await createRemoteDirectoryRecursive(client, remotePath + '/'); // 加斜线确保是目录
}

async function stream(file_id, userId) {
    const { mountName, relativePath } = parseWebdavPath(file_id);
    const { config } = getClientAndConfig(mountName);
    
    const streamClient = createClient(config.url, {
        username: config.username,
        password: config.password
    });
    
    // *** 修改：串流也需要完整的远端路径 ***
    const remotePath = path.posix.join('/', mountName, relativePath);
    return streamClient.createReadStream(remotePath);
}


async function getUrl(file_id, userId) {
    const { mountName, relativePath } = parseWebdavPath(file_id);
    const { client } = getClientAndConfig(mountName);
    // *** 修改：获取URL也需要完整的远端路径 ***
    const remotePath = path.posix.join('/', mountName, relativePath);
    return client.getFileDownloadLink(remotePath);
}

module.exports = { 
    upload, 
    remove, 
    getUrl, 
    stream, 
    resetClients,
    createDirectory, // 导出新函数
    type: 'webdav' 
};
