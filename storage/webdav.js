// storage/webdav.js
const { createClient } = require('webdav');
const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

// --- 輔助函數：日誌記錄 ---
function log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [WEBDAV] [${level.toUpperCase()}] ${message}`, ...args);
}

// --- 輔助函數：延遲 ---
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let clients = {};

// getClient 現在直接接收完整的設定物件
function getClient(config) {
    if (!config || !config.id || !config.url || !config.username) {
        throw new Error('傳入 getClient 的 WebDAV 設定不完整或無效');
    }
    if (!clients[config.id]) {
        clients[config.id] = createClient(config.url, {
            username: config.username,
            password: config.password
        });
        log('info', `為 ${config.mount_name} 創建了新的 WebDAV 客戶端實例。`);
    }
    return clients[config.id];
}

function resetAllClients() {
    log('info', '正在重置所有 WebDAV 客戶端實例...');
    clients = {};
}

// --- 上传函数 ---
async function upload(fileStream, fileName, mimetype, userId, folderPathInfo, mountConfig) {
    const { mountName, remotePath: folderPath } = folderPathInfo;
    log('info', `开始流式上传到 WebDAV: mount=${mountName}, path=${folderPath}, file=${fileName}`);
    
    const client = getClient(mountConfig);
    const remoteFilePath = path.posix.join(folderPath, fileName);

    if (folderPath && folderPath !== "/") {
        try {
            await client.createDirectory(folderPath, { recursive: true });
            log('debug', `WebDAV 目录已确认/创建: ${folderPath}`);
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`创建 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }

    const writeStream = client.createWriteStream(remoteFilePath, { overwrite: true });
    
    return new Promise((resolve, reject) => {
        fileStream.pipe(writeStream);

        writeStream.on('finish', async () => {
            log('info', `文件 ${remoteFilePath} 已成功流式上传到 WebDAV。现在开始验证...`);
            
            const maxRetries = 5;
            const retryDelay = 500;
            let lastError = null;

            for (let i = 0; i < maxRetries; i++) {
                try {
                    await delay(retryDelay * (i + 1));
                    log('debug', `第 ${i + 1} 次尝试获取文件状态: ${remoteFilePath}`);
                    const stat = await client.stat(remoteFilePath);
                    
                    const messageId = Date.now() * 1000 + crypto.randomInt(1000);
                    const fullDbPath = path.posix.join('/', mountName, remoteFilePath);

                    log('info', `文件状态获取成功: ${remoteFilePath}`);
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
                    return;

                } catch (statError) {
                    lastError = statError;
                    if (statError.status === 404) {
                        log('warn', `第 ${i + 1} 次尝试获取状态失败 (404 Not Found)，将在 ${retryDelay * (i + 2)}ms 后重试...`);
                    } else {
                        log('error', `获取文件状态时发生非 404 错误:`, statError);
                        reject(statError);
                        return;
                    }
                }
            }

            log('error', `重试 ${maxRetries} 次后，仍无法获取文件状态: ${remoteFilePath}`, lastError);
            reject(lastError);
        });

        writeStream.on('error', (err) => {
            log('error', `WebDAV 写出流错误: ${remoteFilePath}`, err);
            reject(err);
        });

        fileStream.on('error', (err) => {
            log('error', `文件读取流错误: ${fileName}`, err);
            writeStream.end();
            reject(err);
        });
    });
}

async function remove(itemsToRemove, mountConfig) {
    const client = getClient(mountConfig);
    const mountName = mountConfig.mount_name;
    const results = { success: true, errors: [] };

    itemsToRemove.sort((a, b) => b.remotePath.length - a.remotePath.length);

    for (const item of itemsToRemove) {
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
    return results;
}

async function stream(fileDbPath, mountConfig) {
    const parts = fileDbPath.split('/').filter(Boolean);
    const remotePath = '/' + parts.slice(1).join('/');

    const streamClient = createClient(mountConfig.url, {
        username: mountConfig.username,
        password: mountConfig.password
    });
    log('info', `為 ${fileDbPath} 創建讀取流。`);
    return streamClient.createReadStream(remotePath);
}

async function moveFile(oldPathInfo, newPathInfo, mountConfig) {
    const { remotePath: oldRemotePath } = oldPathInfo;
    const { remotePath: newRemotePath } = newPathInfo;
    log('info', `物理移動: from=${oldRemotePath} to=${newRemotePath} on mount=${mountConfig.mount_name}`);

    const client = getClient(mountConfig);

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

async function createDirectory(folderPathInfo, mountConfig) {
    const { remotePath } = folderPathInfo;
    const client = getClient(mountConfig);
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
    resetAllClients,
};
