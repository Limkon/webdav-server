// storage/webdav.js - 完整重构版

// CommonJS 模块保持不变
const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

// --- WebDAV 模块加载器 ---
// 为动态导入的 ES Module 创建一个占位符
let createClient;

// 使用一个异步函数来动态导入 ES Module
async function initializeWebdavModule() {
    // 这个if判断确保了 'webdav' 包在整个应用生命周期中只被导入一次
    if (!createClient) {
        // 使用动态 import() 异步加载 ES Module
        const webdavModule = await import('webdav');
        createClient = webdavModule.createClient;
        log('info', 'WebDAV 模块已动态加载。');
    }
}

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// --- 辅助函数：日志记录 ---
function log(level, message, ...args) {
    if (level === 'debug') return; // 移除调试日志
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [WEBDAV] [${level.toUpperCase()}] ${message}`, ...args);
}

let clients = {};
let webdavConfigs = [];

// 独立加载配置的函数
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

// 在模块加载时立即读取配置
loadWebdavConfigs();

// getClient 函数现在必须是异步的，因为它依赖于异步加载的 createClient
async function getClient(config) {
    await initializeWebdavModule(); // 确保在使用 createClient 之前它已经被加载

    if (!config || !config.id) {
        throw new Error('无效的 WebDAV 配置传入 getClient');
    }
    if (!clients[config.id]) {
        if (!config.url || !config.username) throw new Error(`WebDAV 设置不完整 (ID: ${config.id})。`);
        // 现在可以安全地使用 createClient
        clients[config.id] = createClient(config.url, {
            username: config.username,
            password: config.password
        });
        log('info', `為 ${config.mount_name} 創建了新的 WebDAV 客戶端實例。`);
    }
    return clients[config.id];
}

function resetClient() {
    log('info', '正在重置所有 WebDAV 客戶端實例...');
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
    log('info', `開始上傳到 WebDAV: mount=${mountName}, path=${folderPath}, file=${fileName}`);
    const config = getConfigForMount(mountName);
    // 由于 getClient 是异步的，这里必须使用 await
    const client = await getClient(config);
    const remoteFilePath = path.posix.join(folderPath, fileName);

    if (folderPath && folderPath !== "/") {
        try {
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            // 405 Method Not Allowed, 501 Not Implemented: 某些服务器不支持创建已存在的目录，可忽略
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`创建 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }

    const fileBuffer = await fsp.readFile(tempFilePath);
    await client.putFileContents(remoteFilePath, fileBuffer, { overwrite: true });
    log('info', `檔案 ${remoteFilePath} 已成功上傳到 WebDAV。`);
    
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
            // 由于 getClient 是异步的，这里必须使用 await
            const client = await getClient(config);
            const allItems = itemsByMount[mountName];

            // 优先删除子项，所以按路径深度降序排序
            allItems.sort((a, b) => b.remotePath.length - a.remotePath.length);

            for (const item of allItems) {
                try {
                    if (await client.exists(item.remotePath)) {
                        log('info', `正在從 WebDAV 刪除: [${mountName}]${item.remotePath}`);
                        await client.deleteFile(item.remotePath);
                    } else {
                        log('warn', `試圖刪除但遠端路徑不存在: [${mountName}]${item.remotePath}`);
                    }
                } catch (error) {
                    // 404 Not Found 错误可以安全忽略
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
             log('error', `處理掛載點 "${mountName}" 的刪除時出錯:`, error);
        }
    }
    return results;
}

async function stream(fileDbPath) {
    // 确保在使用 createClient 之前它已经被加载
    await initializeWebdavModule();
    const parts = fileDbPath.split('/').filter(Boolean);
    const mountName = parts[0];
    const remotePath = '/' + parts.slice(1).join('/');

    const config = getConfigForMount(mountName);
    // 此处每次都创建新客户端，以确保流操作的独立性
    const streamClient = createClient(config.url, {
        username: config.username,
        password: config.password
    });
    log('info', `為 ${fileDbPath} 創建讀取流。`);
    return streamClient.createReadStream(remotePath);
}

async function moveFile(oldPathInfo, newPathInfo) {
    const { mountName, remotePath: oldRemotePath } = oldPathInfo;
    const { remotePath: newRemotePath } = newPathInfo;
    log('info', `物理移動: from=${oldRemotePath} to=${newRemotePath} on mount=${mountName}`);

    const config = getConfigForMount(mountName);
    // 由于 getClient 是异步的，这里必须使用 await
    const client = await getClient(config);

    try {
        if (await client.exists(oldRemotePath)) {
            const targetDir = path.posix.dirname(newRemotePath);
            if (targetDir && targetDir !== "/") {
                 await client.createDirectory(targetDir, { recursive: true });
            }
            await client.moveFile(oldRemotePath, newRemotePath);
            log('info', `物理移動成功。`);
        } else {
            log('warn', `物理移動失敗: 來源路徑 ${oldRemotePath} 不存在。`);
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
    // 由于 getClient 是异步的，这里必须使用 await
    const client = await getClient(config);
    try {
        if (remotePath && remotePath !== '/') {
            log('info', `在 WebDAV 上創建物理目錄: ${remotePath}`);
            await client.createDirectory(remotePath, { recursive: true });
        }
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) {
            log('warn', `WebDAV 伺服器回報無法創建目錄 (可能是已存在): status=${e.response.status}`);
            return true; 
        }
        log('error', `創建 WebDAV 目錄失敗:`, e);
        throw new Error(`创建 WebDAV 目录失败: ${e.message}`);
    }
}

// 导出的接口保持不变
module.exports = { 
    type: 'webdav',
    upload, 
    remove, 
    stream, 
    moveFile,
    createDirectory,
    resetClient, 
};
