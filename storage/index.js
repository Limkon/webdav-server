// storage/index.js
const webdavStorage = require('./webdav');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE);
            const config = JSON.parse(rawData);
            
            if (!config.webdav) {
                config.webdav = [];
            } else if (!Array.isArray(config.webdav)) {
                config.webdav = [{
                    id: crypto.randomBytes(4).toString('hex'),
                    mount_name: 'webdav',
                    ...config.webdav
                }];
            }
            
            config.storageMode = 'webdav';
            return config;
        }
    } catch (error) {
        console.error("读取设定档失败:", error);
    }
    return { storageMode: 'webdav', webdav: [] }; 
}

function writeConfig(config) {
    try {
        config.storageMode = 'webdav';
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        webdavStorage.resetClient(); // 重设所有客户端连线
        return true;
    } catch (error) {
        console.error("写入设定档失败:", error);
        return false;
    }
}

function getStorage() {
    // 强制返回 webdav 储存模式
    return webdavStorage;
}

module.exports = {
    getStorage,
    readConfig,
    writeConfig
};
