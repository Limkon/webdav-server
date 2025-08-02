// storage/index.js
const webdavStorage = require('./webdav');
const fs = require('fs');
const path = require('path');

// 关键变更：不再需要 CONFIG_FILE

function getStorage() {
    // 逻辑简化：现在系统只使用 webdav 模式
    return webdavStorage;
}

// 移除 readConfig 和 writeConfig 函数，因为设定已移至数据库

module.exports = {
    getStorage,
};
