// storage/webdav.js
const { createClient } = require('webdav');
const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

// 从 storage/index.js 引入配置读取函数，避免循环依赖
const { readConfig } = require('./index');

let clients = {};
let webdavConfigs = [];

function loadWebdavConfigs() {
    webdavConfigs = readConfig().webdav || [];
}

// 首次加载
loadWebdavConfigs();

function getClient(config) {
    if (!config || !config.id) {
        throw new Error('无效的 WebDAV 配置傳入 getClient');
    }
    if (!clients[config.id]) {
        if (!config.url || !config.username) throw new Error(`WebDAV 设置不完整 (ID: ${config.id})。`);
        clients[config.id] = createClient(config.url, {
            username: config.username,
            password: config.password
        });
    }
    return clients[config.id];
}

function resetClient() {
    clients = {};
    loadWebdavConfigs();
}

function getConfigForMount(mountName) {
    if (webdavConfigs.length === 0) loadWebdavConfigs();
    const config = webdavConfigs.find(c => c.mount_name === mountName);
    if (!config) throw new Error(`找不到名为 "${mountName}" 的 WebDAV 挂载点。`);
    return config;
}

async function upload(tempFilePath, fileName, mimetype, userId, folderPathInfo) {
    const { mountName, remotePath: folderPath } = folderPathInfo;
    const config = getConfigForMount(mountName);
    const client = getClient(config);
    const remoteFilePath = path.posix.join(folderPath, fileName);

    if (folderPath && folderPath !== "/") {
        try {
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`创建 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }

    const fileBuffer = await fsp.readFile(tempFilePath);
    await client.putFileContents(remoteFilePath, fileBuffer, { overwrite: true });
    
    const stat = await client.stat(remoteFilePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
    
    // 储存包含挂载点的完整相对路径
    const fullDbPath = path.posix.join('/', mountName, remoteFilePath);

    return {
        dbData: {
            message_id: messageId,
            fileName,
            mimetype,
            size: stat.size,
            file_id: fullDbPath,
            date: new Date(stat.lastmod).getTime(),
        },
        success: true
    };
}

async function remove(itemsToRemove) {
    const results = { success: true, errors: [] };
    const itemsByMount = {};

    // 按挂载点对项目进行分组
    for (const item of itemsToRemove) {
        if (!itemsByMount[item.mountName]) {
            itemsByMount[item.mountName] = [];
        }
        itemsByMount[item.mountName].push(item);
    }
    
    // 对每个挂载点分别执行操作
    for (const mountName in itemsByMount) {
        try {
            const config = getConfigForMount(mountName);
            const client = getClient(config);
            const allItems = itemsByMount[mountName];

            // 优先删除文件和子目录
            allItems.sort((a, b) => b.remotePath.length - a.remotePath.length);

            for (const item of allItems) {
                try {
                    if (await client.exists(item.remotePath)) {
                        await client.deleteFile(item.remotePath);
                    }
                } catch (error) {
                    if (!(error.response && error.response.status === 404)) {
                        const errorMessage = `删除 WebDAV [${mountName}${item.remotePath}] 失败: ${error.message}`;
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


async function stream(fileDbPath) {
    const parts = fileDbPath.split('/').filter(Boolean);
    const mountName = parts[0];
    const remotePath = '/' + parts.slice(1).join('/');

    const config = getConfigForMount(mountName);
    // 为 stream 创建独立的 client，避免潜在的并发问题
    const streamClient = createClient(config.url, {
        username: config.username,
        password: config.password
    });
    return streamClient.createReadStream(remotePath);
}

async function moveFile(oldPathInfo, newPathInfo) {
    const { mountName, remotePath: oldRemotePath } = oldPathInfo;
    const { remotePath: newRemotePath } = newPathInfo;

    const config = getConfigForMount(mountName);
    const client = getClient(config);

    try {
        if (await client.exists(oldRemotePath)) {
            const targetDir = path.posix.dirname(newRemotePath);
            if (targetDir && targetDir !== "/") {
                 await client.createDirectory(targetDir, { recursive: true });
            }
            await client.moveFile(oldRemotePath, newRemotePath);
        }
    } catch(err) {
        if (!(err.response && err.response.status === 404)) {
           throw new Error(`物理移动文件失败: ${err.message}`);
        }
    }
}

async function createDirectory(folderPathInfo) {
    const { mountName, remotePath } = folderPathInfo;
    const config = getConfigForMount(mountName);
    const client = getClient(config);
    try {
        if (remotePath && remotePath !== '/') {
            await client.createDirectory(remotePath, { recursive: true });
        }
        return true;
    } catch (e) {
        // 405 (Method Not Allowed) or 501 (Not Implemented) might mean directory already exists.
        if (e.response && (e.response.status === 405 || e.response.status === 501)) {
            return true; 
        }
        throw new Error(`创建 WebDAV 目录失败: ${e.message}`);
    }
}

module.exports = {
    type: 'webdav',
    upload,
    remove,
    stream,
    moveFile,
    createDirectory,
    resetClient,
};
