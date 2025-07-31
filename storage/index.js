const WebDAVStorage = require('./webdav');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

// 熔断状态暂存于记忆体中，伺服器重启后重置
const circuitBreakerState = new Map();

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE);
            const config = JSON.parse(rawData);
            // 确保 webdavs 设定存在且为阵列
            if (!config.webdavs || !Array.isArray(config.webdavs)) {
                config.webdavs = [];
            }
            return config;
        }
    } catch (error) {
        console.error("读取设定档失败:", error);
    }
    // 预设值
    return { storageMode: 'webdav', webdavs: [] };
}

function writeConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        // 设定变更后，重置所有 WebDAV 客户端实例
        WebDAVStorage.resetAllClients();
        return true;
    } catch (error) {
        console.error("写入设定档失败:", error);
        return false;
    }
}

// 熔断器相关函数
function isMountFull(mountId) {
    return circuitBreakerState.get(mountId) === true;
}

function setMountFull(mountId, isFull) {
    if (isFull) {
        circuitBreakerState.set(mountId, true);
        console.warn(`熔断机制：WebDAV 挂载点 ${mountId} 已标记为已满。`);
    } else {
        if (circuitBreakerState.has(mountId)) {
            circuitBreakerState.delete(mountId);
            console.log(`熔断机制：WebDAV 挂载点 ${mountId} 已移除已满标记。`);
        }
    }
}


function getStorage(mountId) {
    const config = readConfig();
    const mountConfig = config.webdavs.find(w => w.id === mountId);
    if (!mountConfig) {
        // 返回一个符合介面的空物件，避免在找不到挂载点时系统崩溃
        console.error(`请求的储存实例未找到，挂载点 ID: ${mountId}`);
        return {
            upload: () => Promise.reject(new Error(`挂载点 ${mountId} 未设定`)),
            remove: () => Promise.reject(new Error(`挂载点 ${mountId} 未设定`)),
            stream: () => Promise.reject(new Error(`挂载点 ${mountId} 未设定`)),
            getUrl: () => Promise.reject(new Error(`挂载点 ${mountId} 未设定`)),
            scan: () => Promise.reject(new Error(`挂载点 ${mountId} 未设定`)),
            type: 'webdav'
        };
    }
    return new WebDAVStorage(mountConfig);
}

module.exports = {
    getStorage,
    readConfig,
    writeConfig,
    isMountFull,
    setMountFull
};
