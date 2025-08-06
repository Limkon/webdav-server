// storage/webdav.js - 完整重构版

const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

// --- WebDAV 模块加载器 ---
let createClient;

async function initializeWebdavModule() {
    if (!createClient) {
        const webdavModule = await import('webdav');
        createClient = webdavModule.createClient;
        log('info', 'WebDAV 模块已动态加载。');
    }
}

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// --- 輔助函數：日誌記錄 ---
function log(level, message, ...args) {
    if (level === 'debug') return;
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [WEBDAV] [${level.toUpperCase()}] ${message}`, ...args);
}

let clients = {};
let webdavConfigs = [];

function loadWebdavConfigs() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE);
            const config = JSON.parse(rawData);
            
            if (config.webdav && Array.isArray(config.webdav)) {
                webdavConfigs = config.webdav;
            } else if (config.webdav && !Array.isArray(config.webdav)) {
                 webdavConfigs = [{
                     id: crypto.randomBytes(4).toString('hex'),
                     mount_name: 'webdav',
                     ...config.webdav
                 }];
            } else {
                webdavConfigs = [];
            }
        } else {
            webdavConfigs = [];
        }
        log('info', `已加载 ${webdavConfigs.length} 个 WebDAV 配置。`);
    } catch (error) {
        log('error', "在 webdav.js 中读取设置文件失败:", error);
        webdavConfigs = [];
    }
}

loadWebdavConfigs();

async function getClient(config) {
    await initializeWebdavModule(); 

    if (!config || !config.id) {
        throw new Error('无效的 WebDAV 配置传入 getClient');
    }
    if (!clients[config.id]) {
        if (!config.url || !config.username) throw new Error(`WebDAV 设置不完整 (ID: ${config.id})。`);
        clients[config.id] = createClient(config.url, {
            username: config.username,
            password: config.password
        });
        log('info', `为 ${config.mount_name} 创建了新的 WebDAV 客户端实例。`);
    }
    return clients[config.id];
}

function resetClient() {
    log('info', '正在重置所有 WebDAV 客户端实例...');
    clients = {};
    loadWebdavConfigs();
}

function getConfigForMount(mountName) {
    if (webdavConfigs.length === 0) loadWebdavConfigs();
    const config = webdavConfigs.find(c => c.mount_name === mountName);
    if (!config) throw new Error(`找不到名为 "${mountName}" 的 WebDAV 挂载点。`);
    return config;
}

async function upload(fileStream, fileName, mimetype, userId, folderPathInfo, options = {}) {
    const { mountName, remotePath: folderPath } = folderPathInfo;
    log('info', `开始流式上传到 WebDAV: mount=${mountName}, path=${folderPath}, file=${fileName}`);
    const config = getConfigForMount(mountName);
    const client = await getClient(config);
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

    const putOptions = {
        overwrite: true,
    };
    if(options.contentLength) {
        putOptions.contentLength = options.contentLength;
    }

    await client.putFileContents(remoteFilePath, fileStream, putOptions);

    log('info', `档案 ${remoteFilePath} 已成功流式上传到 WebDAV。`);
    
    const stat = await client.stat(remoteFilePath);
    const messageId = Date.now() * 1000 + crypto.randomInt(1000);
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

    for (const item of itemsToRemove) {
        if (!itemsByMount[item.mountName]) {
            itemsByMount[item.mountName] = [];
        }
        itemsByMount[item.mountName].push(item);
    }
    
    for (const mountName in itemsByMount) {
        try {
            const config = getConfigForMount(mountName);
            const client = await getClient(config);
            const allItems = itemsByMount[mountName];

            allItems.sort((a, b) => b.remotePath.length - a.remotePath.length);

            for (const item of allItems) {
                try {
                    if (await client.exists(item.remotePath)) {
                        log('info', `正在从 WebDAV 删除: [${mountName}]${item.remotePath}`);
                        await client.deleteFile(item.remotePath);
                    } else {
                        log('warn', `试图删除但远端路径不存在: [${mountName}]${item.remotePath}`);
                    }
                } catch (error) {
                    if (!(error.response && error.response.status === 404)) {
                        const errorMessage = `删除 WebDAV [${mountName}${item.remotePath}] 失败: ${error.message}`;
                        results.errors.push(errorMessage);
                        results.success = false;
                        log('error', errorMessage);
                    }
                }
            }
        } catch (error) {
             results.errors.push(`处理挂载点 "${mountName}" 的删除时出错: ${error.message}`);
             results.success = false;
             log('error', `处理挂载点 "${mountName}" 的删除时出错:`, error);
        }
    }
    return results;
}

async function stream(fileDbPath) {
    await initializeWebdavModule();
    const parts = fileDbPath.split('/').filter(Boolean);
    const mountName = parts[0];
    const remotePath = '/' + parts.slice(1).join('/');

    const config = getConfigForMount(mountName);
    const streamClient = createClient(config.url, {
        username: config.username,
        password: config.password
    });
    log('info', `为 ${fileDbPath} 创建读取流。`);
    return streamClient.createReadStream(remotePath);
}

async function moveFile(oldPathInfo, newPathInfo) {
    const { mountName, remotePath: oldRemotePath } = oldPathInfo;
    const { remotePath: newRemotePath } = newPathInfo;
    log('info', `物理移动: from=${oldRemotePath} to=${newRemotePath} on mount=${mountName}`);

    const config = getConfigForMount(mountName);
    const client = await getClient(config);

    try {
        if (await client.exists(oldRemotePath)) {
            const targetDir = path.posix.dirname(newRemotePath);
            if (targetDir && targetDir !== "/") {
                 await client.createDirectory(targetDir, { recursive: true });
            }
            await client.moveFile(oldRemotePath, newRemotePath);
            log('info', `物理移动成功。`);
        } else {
            log('warn', `物理移动失败: 来源路径 ${oldRemotePath} 不存在。`);
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
    const client = await getClient(config);
    try {
        if (remotePath && remotePath !== '/') {
            log('info', `在 WebDAV 上创建物理目录: ${remotePath}`);
            await client.createDirectory(remotePath, { recursive: true });
        }
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) {
            log('warn', `WebDAV 服务器回报无法创建目录 (可能是已存在): status=${e.response.status}`);
            return true; 
        }
        log('error', `创建 WebDAV 目录失败:`, e);
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
