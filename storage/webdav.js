// storage/webdav.js
const { createClient } = require('webdav');
const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// --- 輔助函數：日誌記錄 ---
function log(level, message, ...args) {
    // 调试日志保持原样，按需开启
    if (level === 'debug') {
        // 要启用调试日志，请取消下面的注释
        // const timestamp = new Date().toISOString();
        // console.log(`[${timestamp}] [WEBDAV] [${level.toUpperCase()}] ${message}`, ...args);
        return;
    }
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

// --- *** 关键修正 开始 *** ---
// 重构 upload 函数以接受流
async function upload(fileStream, fileSize, fileName, mimetype, userId, folderPathInfo) {
    const { mountName, remotePath: folderPath } = folderPathInfo;
    log('info', `開始流式上傳到 WebDAV: mount=${mountName}, path=${folderPath}, file=${fileName}`);

    const config = getConfigForMount(mountName);
    const client = getClient(config);
    const remoteFilePath = path.posix.join(folderPath, fileName);
    log('debug', `遠端文件路徑: ${remoteFilePath}`);

    if (folderPath && folderPath !== "/") {
        try {
            await client.createDirectory(folderPath, { recursive: true });
            log('debug', `已確保遠端目錄存在: ${folderPath}`);
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 log('error', `創建 WebDAV 目錄失敗: status=${e.response?.status}, message=${e.message}`);
                 throw new Error(`创建 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
            log('warn', `創建目錄時收到可忽略的錯誤 (可能是已存在): status=${e.response?.status}`);
        }
    }

    return new Promise((resolve, reject) => {
        const writeStream = client.createWriteStream(remoteFilePath, {
            headers: {
                // 如果文件大小已知，则设置 Content-Length，这对某些 WebDAV 服务器是必要的
                ...(fileSize !== undefined && { 'Content-Length': fileSize })
            }
        });

        writeStream.on('finish', async () => {
            log('info', `檔案 ${remoteFilePath} 已成功上傳到 WebDAV。`);
            try {
                const stat = await client.stat(remoteFilePath);
                log('debug', `獲取遠端文件信息成功: size=${stat.size}, lastmod=${stat.lastmod}`);
                const messageId = Date.now() * 1000 + crypto.randomInt(1000);
                const fullDbPath = path.posix.join('/', mountName, remoteFilePath);

                resolve({
                    dbData: {
                        message_id: messageId,
                        fileName,
                        mimetype,
                        size: stat.size,
                        file_id: fullDbPath,
                        date: new Date(stat.lastmod).getTime(),
                    },
                    success: true
                });
            } catch (statError) {
                log('error', `上傳後獲取 WebDAV 文件狀態失敗:`, statError);
                reject(new Error(`上传后获取 WebDAV 文件状态失败: ${statError.message}`));
            }
        });

        writeStream.on('error', (err) => {
            log('error', `WebDAV 寫入流錯誤 for ${remoteFilePath}:`, err);
            fileStream.unpipe(writeStream);
            reject(new Error(`写入 WebDAV 失败: ${err.message}`));
        });
        
        fileStream.on('error', (err) => {
            log('error', `读取上传文件流时出错:`, err);
            writeStream.destroy(err);
            reject(new Error(`读取上传文件流失败: ${err.message}`));
        });
        
        log('debug', `开始管道传输到 ${remoteFilePath}`);
        fileStream.pipe(writeStream);
    });
}
// --- *** 关键修正 结束 *** ---

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
                        log('info', `正在從 WebDAV 刪除: [${mountName}]${item.remotePath}`);
                        await client.deleteFile(item.remotePath);
                    } else {
                        log('warn', `試圖刪除但遠端路徑不存在: [${mountName}]${item.remotePath}`);
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
             log('error', `處理掛載點 "${mountName}" 的刪除時出錯:`, error);
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
    log('info', `為 ${fileDbPath} 創建讀取流。`);
    return streamClient.createReadStream(remotePath);
}

async function moveFile(oldPathInfo, newPathInfo) {
    const { mountName, remotePath: oldRemotePath } = oldPathInfo;
    const { remotePath: newRemotePath } = newPathInfo;
    log('info', `物理移動: from=${oldRemotePath} to=${newRemotePath} on mount=${mountName}`);

    const config = getConfigForMount(mountName);
    const client = getClient(config);

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
    const client = getClient(config);
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

module.exports = { 
    type: 'webdav',
    upload, 
    remove, 
    stream, 
    moveFile,
    createDirectory,
    resetClient, 
};
