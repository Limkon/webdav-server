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

            // --- 主要修改开始 ---
            // 确保 webdav 是一个阵列，以支持多个挂载点
            if (!config.webdav) {
                config.webdav = [];
            } else if (!Array.isArray(config.webdav)) {
                // 向下相容：如果旧设定是物件，转换成只有壹个元素的阵列
                config.webdav = [{
                    id: crypto.randomBytes(4).toString('hex'), // 给一个随机 ID
                    mount_name: 'webdav', // 预设挂载名称
                    ...config.webdav
                }];
            }
            // --- 主要修改结束 ---

            // 强制将储存模式设为 webdav
            config.storageMode = 'webdav';
            return config;
        }
    } catch (error) {
        console.error("读取设定档失败:", error);
    }
    // 预设值
    return { storageMode: 'webdav', webdav: [] };
}

function writeConfig(config) {
    try {
        // 确保储存模式始终为 webdav
        config.storageMode = 'webdav';
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        webdavStorage.resetClient(); // 重设所有客户端连线
        return true;
    } catch (error) {
        console.error("写入设定档失败:", error);
        return false;
    }
}

// 现在 getStorage 总是返回 WebDAV 储存模组
function getStorage() {
    return webdavStorage;
}

module.exports = {
    getStorage,
    readConfig,
    writeConfig
};
