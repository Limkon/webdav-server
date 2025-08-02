const webdavStorage = require('./webdav');

// 移除 config.json 的读写，因为我们将从数据库管理设定

// getStorage 函数现在需要知道是哪个 WebDAV 挂载点
function getStorage(mountId) {
    // 每次都返回 webdavStorage 模块，具体客户端实例在其内部处理
    return webdavStorage;
}


module.exports = {
    getStorage,
};
