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
            // 确保 webdav 设定存在且为物件
            if (!config.webdav || Array.isArray(config.webdav)) {
                config.webdav = {}; 
            }
            // 强制将储存模式设为 webdav
            config.storageMode = 'webdav';
            return config;
        }
    } catch (error) {
        console.error("读取设定档失败:", error);
    }
    // --- 预设值强制为 'webdav' ---
    return { storageMode: 'webdav', webdav: {} }; 
}

function writeConfig(config) {
    try {
        // 强制将储存模式设为 webdav
        config.storageMode = 'webdav';
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        // 如果是 WebDAV 设定变更，则重置客户端以使用新设定
        if (config.storageMode === 'webdav') {
            webdavStorage.resetClient();
        }
        return true;
    } catch (error) {
        console.error("写入设定档失败:", error);
        return false;
    }
}

let config = readConfig();

function getStorage() {
    config = readConfig(); 
    return webdavStorage;
}

function setStorageMode(mode) {
    if (mode === 'webdav') {
        config.storageMode = mode;
        return writeConfig(config);
    }
    return false;
}

module.exports = {
    getStorage,
    setStorageMode,
    readConfig,
    writeConfig
};
