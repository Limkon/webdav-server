// storage/index.js
const fs = require('fs');
const path = require('path');
const webdav = require('./webdav.js');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

let config = {}; // 模組級別的設定快取

function log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [STORAGE] [${level.toUpperCase()}] ${message}`, ...args);
}

// 載入/重新載入設定
function readConfig() {
    log('info', '正在讀取/重新讀取設定檔...');
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE, 'utf-8');
            // 處理檔案為空的情況
            if (rawData.trim() === '') {
                log('warn', '設定檔為空，將初始化為預設值。');
                config = { storage_type: 'webdav', webdav: [] };
            } else {
                config = JSON.parse(rawData);
            }
            
            if (!config.webdav) {
                config.webdav = [];
            }
            log('info', `設定檔讀取成功，找到 ${config.webdav.length} 個 WebDAV 設定。`);
        } else {
            config = { storage_type: 'webdav', webdav: [] };
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
            log('warn', '設定檔不存在，已建立新的空設定檔。');
        }
    } catch (error) {
        log('error', "讀取或解析設定檔失敗:", error);
        config = { storage_type: 'webdav', webdav: [] };
    }
    
    // *** 關鍵修正: 使用正確的函數名 resetAllClients ***
    const storage = getStorage();
    if (storage.type === 'webdav' && typeof storage.resetAllClients === 'function') {
        storage.resetAllClients();
    } else if (storage.type === 'webdav') {
        log('error', 'webdav 儲存模組中找不到 resetAllClients 函數!');
    }
    
    return config;
}

// 寫入設定
function writeConfig(newConfig) {
    log('info', '正在寫入新設定到檔案...');
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf-8');
        readConfig(); // 寫入後立即重新讀取，以更新快取並重置客戶端
        return true;
    } catch (error) {
        log('error', "寫入設定檔失敗:", error);
        // 將錯誤訊息也輸出到 console.error，方便追蹤
        console.error("写入设定档失败:", error);
        return false;
    }
}

// 獲取當前儲存引擎的介面
function getStorage() {
    // 修正: 確保即使 config.storage_type 不存在，也能正確處理
    if (!config.storage_type || config.storage_type === 'webdav') {
        if (!config.storage_type) {
            log('warn', '設定檔中缺少 storage_type，將預設使用 WebDAV。');
        }
        return webdav;
    }
    log('error', `不支援的儲存類型: ${config.storage_type}`);
    return webdav; // 作為最終備用
}

// 新增：獲取特定掛載點設定的函數
function getMountConfig(mountName) {
    if (!config.webdav) return null;
    return config.webdav.find(c => c.mount_name === mountName) || null;
}
function getMountConfigById(mountId) {
    if (!config.webdav) return null;
    return config.webdav.find(c => c.id === mountId) || null;
}
function getMountConfigForPath(fullPath) {
    if (!config.webdav) return null;
    const mountName = fullPath.split('/')[1];
    return getMountConfig(mountName);
}


// 首次載入
readConfig();

module.exports = {
    readConfig,
    writeConfig,
    getStorage,
    getMountConfig,
    getMountConfigById,
    getMountConfigForPath,
};
