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
            return config;
        }
    } catch (error) {
        // console.error("读取设定档失败:", error);
    }
    return { webdav: [] };
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


module.exports = {
    getStorage,
    readConfig,
    writeConfig,
    getWebdavConfigByName
};
