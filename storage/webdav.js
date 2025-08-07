// storage/webdav.js
const { createClient } = require('webdav');
const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

function log(level, message, ...args) {
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

function getClient(config) {
    if (!config || !config.id) {
        throw new Error('无效的 WebDAV 配置传入 getClient');
    }
    if (!clients[config.id]) {
        if (!config.url || !config.username) throw new Error(`WebDAV 设置不完整 (ID: ${config.id})。`);
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

async function uploadStream(fileStream, fileName, mimetype, userId, folderPathInfo) {
    const { mountName, remotePath: folderPath } = folderPathInfo;
    log('info', `[WEBDAV-UPLOAD] 開始處理: mount=${mountName}, path=${folderPath}, file=${fileName}`);
    
    const config = getConfigForMount(mountName);
    const client = getClient(config);
    const remoteFilePath = path.posix.join(folderPath, fileName);

    if (folderPath && folderPath !== "/") {
        try {
            log('debug', `[WEBDAV-UPLOAD] 檢查或創建遠端目錄: ${folderPath}`);
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`创建 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }
    
    return new Promise((resolve, reject) => {
        log('debug', `[WEBDAV-UPLOAD] 正在為 ${remoteFilePath} 創建 WebDAV 寫入流...`);
        const writeStream = client.createWriteStream(remoteFilePath, { overwrite: true });

        writeStream.on('finish', async () => {
            log('info', `[WEBDAV-UPLOAD] WebDAV 寫入流 'finish' 事件觸發: ${remoteFilePath}。上傳完成。`);
            try {
                const stat = await client.stat(remoteFilePath);
                const messageId = Date.now() * 1000 + crypto.randomInt(1000);
                const fullDbPath = path.posix.join('/', mountName, remoteFilePath);

                resolve({
                    dbData: { message_id: messageId, fileName, mimetype, size: stat.size, file_id: fullDbPath, date: new Date(stat.lastmod).getTime() },
                    success: true
                });
            } catch (statError) {
                 log('error', `[WEBDAV-UPLOAD] 上傳後獲取檔案狀態失敗: ${remoteFilePath}`, statError);
                 reject(new Error(`上传成功但获取文件状态失败: ${statError.message}`));
            }
        });

        writeStream.on('error', (err) => {
            log('error', `[WEBDAV-UPLOAD] WebDAV 寫入流錯誤 for ${remoteFilePath}:`, err);
            reject(new Error(`写入 WebDAV 失败: ${err.message}`));
        });
        
        fileStream.on('error', (err) => {
             log('error', `[WEBDAV-UPLOAD] 來源檔案讀取流錯誤 for ${fileName}:`, err);
             writeStream.end();
             reject(new Error(`读取来源文件流时出错: ${err.message}`));
        });

        log('debug', `[WEBDAV-UPLOAD] 正在將讀取流 .pipe() 到 WebDAV 寫入流: ${fileName}`);
        fileStream.pipe(writeStream);
    });
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
            const client = getClient(config);
            const allItems = itemsByMount[mountName];

            allItems.sort((a, b) => b.remotePath.length - a.remotePath.length);

            for (const item of allItems) {
                try {
                    if (await client.exists(item.remotePath)) {
                        await client.deleteFile(item.remotePath);
                    }
                } catch (error) {
                    if (!(error.response && error.response.status === 404)) {
                         results.errors.push(`删除 WebDAV [${mountName}${item.remotePath}] 失败: ${error.message}`);
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
        if (e.response && (e.response.status === 405 || e.response.status === 501)) {
            return true; 
        }
        throw new Error(`创建 WebDAV 目录失败: ${e.message}`);
    }
}

module.exports = { 
    type: 'webdav',
    uploadStream,
    remove, 
    stream, 
    moveFile,
    createDirectory,
    resetClient, 
};
