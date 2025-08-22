// limkon/webdav-server/webdav-server-c537b63a2d01ddbeb66471106304717d5eb7ad03/storage/index.js
// storage/index.js
const webdavStorage = require('./webdav');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE);
            const config = JSON.parse(rawData);
            // 确保 webdav 设定存在且为阵列
            if (!config.webdav || !Array.isArray(config.webdav)) {
                config.webdav = [];
            }
            // 新增：确保熔断器物件存在
            if (!config.circuitBreaker) {
                config.circuitBreaker = {};
            }
            return config;
        }
    } catch (error) {
        // console.error("读取设定档失败:", error);
    }
    // 返回包含预设空熔断器物件的设定
    return { webdav: [], circuitBreaker: {} };
}

function writeConfig(config) {
    try {
        // 确保 storageMode 字段被移除或固定
        delete config.storageMode; 
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        return true;
    } catch (error) {
        // console.error("写入设定档失败:", error);
        return false;
    }
}

// 始终返回 WebDAV 存储引擎
function getStorage() {
    return webdavStorage;
}

// 新增：根据挂载点名称获取特定 WebDAV 设定
function getWebdavConfigByName(name) {
    const config = readConfig();
    return config.webdav.find(c => c.name === name);
}

/**
 * 修改：标记一个挂载点为容量已满 (熔断)，并持久化到 config.json
 * @param {string} mountName - 挂载点名称
 * @param {boolean} isFull - 是否已满
 */
function setMountFull(mountName, isFull) {
    const config = readConfig();
    config.circuitBreaker[mountName] = isFull;
    writeConfig(config);
    // console.log(`[熔断机制] ${mountName} 状态已更新并持久化: ${isFull ? '已熔断 (容量满)' : '正常'}`);
}

/**
 * 修改：从 config.json 检查一个挂载点是否已熔断
 * @param {string} mountName - 挂载点名称
 * @returns {boolean} - 如果已满则返回 true
 */
function isMountFull(mountName) {
    const config = readConfig();
    return config.circuitBreaker[mountName] || false;
}

/**
 * 修改：清除一个挂载点的熔断状态，并持久化到 config.json
 * @param {string} mountName - 挂载点名称
 */
function clearMountStatus(mountName) {
    const config = readConfig();
    if (config.circuitBreaker && config.circuitBreaker[mountName]) {
        config.circuitBreaker[mountName] = false;
        writeConfig(config);
        // console.log(`[熔断机制] ${mountName} 的熔断状态已被清除并持久化。`);
    }
}


module.exports = {
    getStorage,
    readConfig,
    writeConfig,
    getWebdavConfigByName,
    setMountFull,
    isMountFull,
    clearMountStatus
};
