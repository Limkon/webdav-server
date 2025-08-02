const webdavStorage = require('./webdav');

/**
 * 获取储存处理模块。
 * 在当前设计中，所有操作都通过 webdavStorage 处理。
 * @param {number} [mountId] - WebDAV 挂载点的 ID，用于确定使用哪个 WebDAV 实例。
 * @returns {object} 储存处理模块。
 */
function getStorage(mountId) {
    // 总是返回 webdavStorage 模块，具体的客户端实例在其内部根据 mountId 进行管理。
    return webdavStorage;
}

module.exports = {
    getStorage,
};
