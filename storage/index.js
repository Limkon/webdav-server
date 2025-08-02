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
            
            // --- 主要修改開始 ---
            // 確保 webdav 是一個陣列，以支援多個掛載點
            if (!config.webdav) {
                config.webdav = [];
            } else if (!Array.isArray(config.webdav)) {
                // 向下相容：如果舊設定是物件，轉換成只有一個元素的陣列
                config.webdav = [{
                    id: crypto.randomBytes(4).toString('hex'), // 給一個隨機 ID
                    mount_name: 'webdav', // 預設掛載名稱
                    ...config.webdav
                }];
            }
            // --- 主要修改結束 ---

            // 强制将储存模式设为 webdav
            config.storageMode = 'webdav';
            return config;
        }
    } catch (error) {
        console.error("读取设定档失败:", error);
    }
    // 預設值
    return { storageMode: 'webdav', webdav: [] }; 
}

function writeConfig(config) {
    try {
        // 确保储存模式始终为 webdav
        config.storageMode = 'webdav';
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        webdavStorage.resetClient(); // 重設所有客戶端連線
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
