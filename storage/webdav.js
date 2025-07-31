const { createClient } = require('webdav');
const data = require('../data.js'); // 将用于从数据库获取配置
const fsp = require('fs').promises;
const path = require('path');

// 此物件将快取多个 WebDAV 客户端实例
let clients = {};

// 重置所有快取的客户端，在配置变更后呼叫
function resetClients() {
    clients = {};
}

// 依据挂载点ID取得对应的 WebDAV 客户端
async function getClient(mountId, userId) {
    if (clients[mountId]) {
        return clients[mountId];
    }

    const config = await data.getWebdavConfigById(mountId, userId);
    if (!config || !config.url) {
        throw new Error(`WebDAV 设定 ID ${mountId} 不完整或未找到`);
    }

    const client = createClient(config.url, {
        username: config.username,
        password: config.password
    });

    clients[mountId] = client;
    return client;
}

// 辅助函数：解析前端传来的虚拟路径，分解为 [挂载点设定, 远端WebDAV路径]
async function parsePath(virtualPath, userId) {
    const pathParts = virtualPath.split('/').filter(p => p);
    if (pathParts.length === 0) {
        // 代表是根目录 '/'
        return { mount: null, remotePath: '/' };
    }

    const mountName = pathParts[0];
    const remotePath = '/' + pathParts.slice(1).join('/');

    const mount = await data.getWebdavConfigByName(mountName, userId);
    if (!mount) {
        throw new Error(`找不到名为 "${mountName}" 的 WebDAV 挂载点`);
    }

    return { mount, remotePath };
}

async function upload(tempFilePath, virtualPath, userId, overwrite = false) {
    const { mount, remotePath } = await parsePath(virtualPath, userId);
    if (!mount) throw new Error("无法上传到根目录");

    const client = await getClient(mount.id, userId);
    const remoteDir = path.posix.dirname(remotePath);

    // 尝试建立远端目录（如果不存在）
    if (remoteDir && remoteDir !== "/") {
        try {
            await client.createDirectory(remoteDir, { recursive: true });
        } catch (e) {
            // 忽略目录已存在的错误 (例如 405 Method Not Allowed)
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }

    const fileBuffer = await fsp.readFile(tempFilePath);
    const success = await client.putFileContents(remotePath, fileBuffer, { overwrite });

    if (!success) {
        throw new Error('WebDAV putFileContents 操作失败');
    }
    
    return { success: true, message: '档案已上传至 WebDAV。' };
}

async function remove(virtualPath, userId) {
    const { mount, remotePath } = await parsePath(virtualPath, userId);
    if (!mount || remotePath === '/') throw new Error("无法删除挂载点本身");

    const client = await getClient(mount.id, userId);

    try {
        await client.deleteFile(remotePath);
    } catch (error) {
        // 忽略“找不到档案”的错误，但抛出其他错误
        if (!(error.response && error.response.status === 404)) {
            const errorMessage = `删除 WebDAV 项目 [${remotePath}] 失败: ${error.message}`;
            console.error(errorMessage);
            throw new Error(errorMessage);
        }
    }
    return { success: true };
}

async function stream(virtualPath, userId) {
    const { mount, remotePath } = await parsePath(virtualPath, userId);
    if (!mount) throw new Error("无法从根目录读取串流");

    // 为每个串流操作建立独立的客户端以避免冲突
    const streamClient = createClient(mount.url, {
        username: mount.username,
        password: mount.password
    });
    return streamClient.createReadStream(remotePath);
}

module.exports = { 
    upload, 
    remove, 
    stream, 
    resetClients, 
    parsePath, 
    getClient, 
    type: 'webdav' 
};
