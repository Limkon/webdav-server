// storage/webdav.js - 完整重構版

// CommonJS 模塊保持不變
const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

// --- WebDAV 模塊加載器 ---
// 為動態導入的 ES Module 創建一個佔位符
let createClient;

// 使用一個異步函數來動態導入 ES Module
async function initializeWebdavModule() {
    // 這個if判斷確保了 'webdav' 包在整個應用生命周期中只被導入一次
    if (!createClient) {
        // 使用動態 import() 異步加載 ES Module
        const webdavModule = await import('webdav');
        createClient = webdavModule.createClient;
        log('info', 'WebDAV 模塊已動態加載。');
    }
}

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// --- 輔助函數：日誌記錄 ---
function log(level, message, ...args) {
    if (level === 'debug') return; // 移除調試日誌
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [WEBDAV] [${level.toUpperCase()}] ${message}`, ...args);
}

let clients = {};
let webdavConfigs = [];

// 獨立加載配置的函數
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
        log('info', `已加載 ${webdavConfigs.length} 個 WebDAV 配置。`);
    } catch (error) {
        log('error', "在 webdav.js 中讀取設置文件失敗:", error);
        webdavConfigs = [];
    }
}

// 在模塊加載時立即讀取配置
loadWebdavConfigs();

// getClient 函數現在必須是異步的，因為它依賴於異步加載的 createClient
async function getClient(config) {
    await initializeWebdavModule(); // 確保在使用 createClient 之前它已經被加載

    if (!config || !config.id) {
        throw new Error('無效的 WebDAV 配置傳入 getClient');
    }
    if (!clients[config.id]) {
        if (!config.url || !config.username) throw new Error(`WebDAV 設置不完整 (ID: ${config.id})。`);
        // 現在可以安全地使用 createClient
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
    if (!config) throw new Error(`找不到名為 "${mountName}" 的 WebDAV 掛載點。`);
    return config;
}

async function upload(tempFilePath, fileName, mimetype, userId, folderPathInfo) {
    const { mountName, remotePath: folderPath } = folderPathInfo;
    log('info', `開始上傳到 WebDAV: mount=${mountName}, path=${folderPath}, file=${fileName}`);
    const config = getConfigForMount(mountName);
    const client = await getClient(config);
    const remoteFilePath = path.posix.join(folderPath, fileName);

    if (folderPath && folderPath !== "/") {
        try {
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`創建 WebDAV 目錄失敗 (${e.response.status}): ${e.message}`);
            }
        }
    }

    const readStream = fs.createReadStream(tempFilePath);
    await client.putFileContents(remoteFilePath, readStream, { overwrite: true });

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
            const client = await getClient(config);
            const allItems = itemsByMount[mountName];

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
                    if (!(error.response && error.response.status === 404)) {
                        const errorMessage = `刪除 WebDAV [${mountName}${item.remotePath}] 失敗: ${error.message}`;
                        results.errors.push(errorMessage);
                        results.success = false;
                        log('error', errorMessage);
                    }
                }
            }
        } catch (error) {
             results.errors.push(`處理掛載點 "${mountName}" 的刪除時出錯: ${error.message}`);
             results.success = false;
             log('error', `處理掛載點 "${mountName}" 的刪除時出錯:`, error);
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
    log('info', `為 ${fileDbPath} 創建讀取流。`);
    return streamClient.createReadStream(remotePath);
}

async function moveFile(oldPathInfo, newPathInfo) {
    const { mountName, remotePath: oldRemotePath } = oldPathInfo;
    const { remotePath: newRemotePath } = newPathInfo;
    log('info', `物理移動: from=${oldRemotePath} to=${newRemotePath} on mount=${mountName}`);

    const config = getConfigForMount(mountName);
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
           throw new Error(`物理移動文件失敗: ${err.message}`);
        }
    }
}

async function createDirectory(folderPathInfo) {
    const { mountName, remotePath } = folderPathInfo;
    const config = getConfigForMount(mountName);
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
        throw new Error(`創建 WebDAV 目錄失敗: ${e.message}`);
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
