const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

// --- 主要修改開始 ---
// 将单一 client 改为 clients 对象，用于储存多个 WebDAV 客户端实例
let clients = {};
let webdavConfigs = [];

// 辅助函数：加载并解析 WebDAV 配置
function loadWebdavConfigs() {
    const storageManager = require('./index'); 
    const config = storageManager.readConfig();
    webdavConfigs = Array.isArray(config.webdav) ? config.webdav : [];
    if (webdavConfigs.length === 0) {
        // 即使没有配置，也保持模块可用，但在实际操作时会报错
    }
}

// 辅助函数：根据文件路径或文件夹ID解析出对应的 WebDAV 挂载点配置
async function getConfigForPath(filePathOrFolderId, userId) {
    if (webdavConfigs.length === 0) loadWebdavConfigs();
    if (webdavConfigs.length === 0) throw new Error('尚未设定任何 WebDAV。');

    let mountName;
    if (typeof filePathOrFolderId === 'number' || !isNaN(parseInt(filePathOrFolderId))) {
        // 如果是 folderId，获取其路径
        const pathParts = await data.getFolderPath(filePathOrFolderId, userId);
        // 根目录下的第一个文件夹即为挂载点名称
        mountName = pathParts.length > 1 ? pathParts[1].name : null;
    } else {
        // 如果是 file_id (路径)
        const normalizedPath = path.posix.normalize(filePathOrFolderId).replace(/^\//, '');
        mountName = normalizedPath.split('/')[0];
    }
    
    if (!mountName) throw new Error('操作无效：不能直接在根目录进行档案操作。');
    
    const config = webdavConfigs.find(c => c.mount_name === mountName);
    if (!config) throw new Error(`找不到名为 "${mountName}" 的 WebDAV 挂载点。`);
    
    return { config, remotePath: path.posix.normalize(filePathOrFolderId).replace(new RegExp(`^/?${mountName}`), '') || '/' };
}


// getClient 现在接收一个 WebDAV 配置对象，并返回或创建一个客户端实例
function getClient(config) {
    if (!clients[config.id]) {
        if (!config.url || !config.username) throw new Error('WebDAV 设定不完整。');
        clients[config.id] = createClient(config.url, {
            username: config.username,
            password: config.password
        });
    }
    return clients[config.id];
}

// 重置所有客户端实例
function resetClient() {
    clients = {};
    loadWebdavConfigs(); // 重新加载配置
}
// --- 主要修改结束 ---


async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const { config, remotePath: folderPath } = await getConfigForPath(folderId, userId);
    const client = getClient(config);
    const remotePath = path.posix.join(folderPath === '/' ? '' : folderPath, fileName);
    
    if (folderPath && folderPath !== "/") {
        try {
            // 在目标 WebDAV 上创建目录
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            // 某些服务器对已存在的目录返回 405/501，这可以被忽略
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
    
    // file_id 现在储存包含挂载点名称的完整相对路径
    const fullRelativePath = path.posix.join('/', config.mount_name, remotePath);

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stat.size,
        file_id: fullRelativePath,
        date: new Date(stat.lastmod).getTime(),
    }, folderId, userId, 'webdav');
    
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}


async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const itemsByMount = {};

    // 1. 将待删除项目按挂载点分组
    for (const file of files) {
        const mountName = file.file_id.split('/')[1];
        if (!itemsByMount[mountName]) itemsByMount[mountName] = [];
        itemsByMount[mountName].push({
            path: file.file_id.replace(`/${mountName}`, '') || '/',
            type: 'file'
        });
    }
    for (const folder of folders) {
        const fullPath = await data.getFolderPath(folder.id, userId);
        if (fullPath.length > 1) { // 确保不是根目录
            const mountName = fullPath[1].name;
            if (!itemsByMount[mountName]) itemsByMount[mountName] = [];
            const remotePath = '/' + fullPath.slice(2).map(p => p.name).join('/');
            itemsByMount[mountName].push({ path: remotePath, type: 'folder' });
        }
    }

    // 2. 对每个挂载点分别执行删除操作
    for (const mountName in itemsByMount) {
        try {
            const { config } = await getConfigForPath(mountName, userId);
            const client = getClient(config);
            const allItemsToDelete = itemsByMount[mountName];

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
        } catch (error) {
             results.errors.push(`处理挂载点 "${mountName}" 的删除时出错: ${error.message}`);
             results.success = false;
        }
    }

    return results;
}


async function stream(file_id, userId) {
    const { config, remotePath } = await getConfigForPath(file_id, userId);
    // 为每个流操作创建一个独立的客户端实例以避免冲突
    const streamClient = createClient(config.url, {
        username: config.username,
        password: config.password
    });
    return streamClient.createReadStream(remotePath);
}

async function getUrl(file_id, userId) {
    const { config, remotePath } = await getConfigForPath(file_id, userId);
    const client = getClient(config);
    return client.getFileDownloadLink(remotePath);
}

async function createDirectory(fullPath, userId) {
    const { config, remotePath } = await getConfigForPath(fullPath, userId);
    const client = getClient(config);
    try {
        if (await client.exists(remotePath)) {
            return true;
        }
        await client.createDirectory(remotePath, { recursive: true });
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) {
            return true; // 忽略目录已存在的错误
        }
        throw new Error(`建立 WebDAV 目录失败: ${e.message}`);
    }
}

// 初始化时加载一次配置
loadWebdavConfigs();

module.exports = { 
    upload, 
    remove, 
    getUrl, 
    stream, 
    resetClient, 
    getClient, // 注意：此处的 getClient 仍保留，但内部逻辑已改变
    createDirectory,
    getConfigForPath, // 导出辅助函数供其他模组使用
    type: 'webdav' 
};
