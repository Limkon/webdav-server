// storage/index.js
const webdavStorage = require('./webdav');

// 储存管理器现在只提供 WebDAV 模式
function getStorage() {
    return webdavStorage;
}

module.exports = {
    getStorage
};
