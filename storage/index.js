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
            return config;
        }
    } catch (error) {
        // console.error("读取设定档失败:", error);
    }
    // 预设返回一个空的 webdav 配置
    return { webdav: {} }; 
}

function writeConfig(config) {
    try {
        // 确保存储模式始终是 webdav
        config.storageMode = 'webdav';
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        // 重置客户端以使用新设定
        webdavStorage.resetClient();
        return true;
    } catch (error) {
        // console.error("写入设定档失败:", error);
        return false;
    }
}

// 现在 getStorage 始终返回 webdavStorage
function getStorage() {
    return webdavStorage;
}

module.exports = {
    getStorage,
    readConfig,
    writeConfig
};
