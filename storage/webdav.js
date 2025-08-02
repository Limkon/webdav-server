const { createClient } = require('webdav');
const data = require('../data.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

// --- 主要修改开始 ---
// 将单一 client 改为 clients 对象，用于存储多个 WebDAV 客户端实例
let clients = {};
let webdavConfigs = [];
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json'); // 直接定义配置文件路径

// 辅助函数：加载并解析 WebDAV 配置 (不再依赖 index.js)
function loadWebdavConfigs() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const rawData = fs.readFileSync(CONFIG_FILE);
            const config = JSON.parse(rawData);
            
            // 确保 webdav 是一个数组，以支持多个挂载点
            if (config.webdav && Array.isArray(config.webdav)) {
                webdavConfigs = config.webdav;
            } else if (config.webdav && !Array.isArray(config.webdav)) {
                 // 向下兼容：如果旧设置是对象，转换成只有一个元素的数组
                 webdavConfigs = [{
                    id: crypto.randomBytes(4).toString('hex'), // 给一个随机 ID
                    mount_name: 'webdav', // 默认挂载名称
                    ...config.webdav
                }];
            } else {
                webdavConfigs = [];
            }
        } else {
            webdavConfigs = [];
        }
    } catch (error) {
        console.error("在 webdav.js 中读取设置文件失败:", error);
        webdavConfigs = [];
    }
}

// 辅助函数：根据文件路径或文件夹ID解析出对应的 WebDAV 挂载点配置
async function getConfigForPath(filePathOrFolderId, userId) {
    if (webdavConfigs.length === 0) loadWebdavConfigs(); // 确保配置已加载
    if (webdavConfigs.length === 0) throw new Error('尚未设置任何 WebDAV。');

    let mountName;
    if (typeof filePathOrFolderId === 'number' || !isNaN(parseInt(filePathOrFolderId))) {
        // 如果是 folderId，获取其路径
        const pathParts = await data.getFolderPath(filePathOrFolderId, userId);
        // 根目录下的第一个文件夹即为挂载点名称
        mountName = pathParts.length > 1 ? pathParts[1].name : null;
    } else {
        // 如果是 file_id (路径)
        const normalizedPath = path.posix.normalize(String(filePathOrFolderId)).replace(/^\//, '');
        mountName = normalizedPath.split('/')[0];
    }
    
    if (!mountName) {
        // 允许对挂载点本身进行操作（例如，删除时）
        const configByMountName = webdavConfigs.find(c => c.mount_name === filePathOrFolderId);
        if (configByMountName) {
            return { config: configByMountName, remotePath: '/' };
        }
        throw new Error('操作无效：不能直接在根目录进行文件操作。');
    }
    
    const config = webdavConfigs.find(c => c.mount_name === mountName);
    if (!config) throw new Error(`找不到名为 "${mountName}" 的 WebDAV 挂载点。`);
    
    const remotePath = path.posix.normalize(String(filePathOrFolderId)).replace(new RegExp(`^/?${mountName}`), '') || '/';
    return { config, remotePath };
}


// getClient 现在接收一个 WebDAV 配置对象，并返回或创建一个客户端实例
function getClient(config) {
    if (!clients[config.id]) {
        if (!config.url || !config.username) throw new Error('WebDAV 设置不完整。');
        clients[config.id] = createClient(config.url, {
            username: config.username,
            password: config.password
        });
    }
    return clients[config.id];
}

// 重置所有客户端实例
function resetClient() {
    clients = {};
    loadWebdavConfigs(); // 重新加载配置
}
// --- 主要修改结束 ---

// 初始化时加载一次配置 (现在是安全的)
loadWebdavConfigs();

// 以下是原有的函数，它们现在可以正确工作了
async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const { config, remotePath: folderPath } = await getConfigForPath(folderId, userId);
    const client = getClient(config);
    const remotePath = path.posix.join(folderPath === '/' ? '' : folderPath, fileName);
    
    if (folderPath && folderPath !== "/") {
        try {
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`创建 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }

    const fileBuffer = await fsp.readFile(tempFilePath);
    await client.putFileContents(remotePath, fileBuffer, { overwrite: true });
    
    const stat = await client.stat(remotePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
    
    const fullRelativePath = path.posix.join('/', config.mount_name, remotePath);

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stat.size,
        file_id: fullRelativePath,
        date: new Date(stat.lastmod).getTime(),
    }, folderId, userId, 'webdav');
    
    return { success: true, message: '文件已上传至 WebDAV。', fileId: dbResult.fileId };
}


async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const itemsByMount = {};

    for (const file of files) {
        const parts = file.file_id.split('/');
        if (parts.length > 1) {
            const mountName = parts[1];
            if (!itemsByMount[mountName]) itemsByMount[mountName] = { files: [], folders: [] };
            itemsByMount[mountName].files.push({
                path: file.file_id.replace(`/${mountName}`, '') || '/',
                type: 'file'
            });
        }
    }
    for (const folder of folders) {
        const fullPath = await data.getFolderPath(folder.id, userId);
        if (fullPath.length > 1) { // 确保不是根目录
            const mountName = fullPath[1].name;
            if (!itemsByMount[mountName]) itemsByMount[mountName] = { files: [], folders: [] };
            const remotePath = '/' + fullPath.slice(1).map(p => p.name).join('/');
            itemsByMount[mountName].folders.push({ path: remotePath, type: 'folder' });
        }
    }

    for (const mountName in itemsByMount) {
        try {
            const { config } = await getConfigForPath(mountName, userId);
            const client = getClient(config);
            const allItemsToDelete = [...itemsByMount[mountName].folders, ...itemsByMount[mountName].files];

            allItemsToDelete.sort((a, b) => b.path.length - a.path.length);

            for (const item of allItemsToDelete) {
                try {
                    // 检查文件或目录是否存在，如果不存在则跳过
                    const itemExists = await client.exists(item.path);
                    if (itemExists) {
                        await client.deleteFile(item.path);
                    }
                } catch (error) {
                    if (!(error.response && error.response.status === 404)) {
                        const errorMessage = `删除 WebDAV [${mountName}${item.path}] 失败: ${error.message}`;
                        results.errors.push(errorMessage);
                        results.success = false;
                    }
                }
            }
        } catch (error) {
             results.errors.push(`处理挂载点 "${mountName}" 的删除时出错: ${error.message}`);
             results.success = false;
        }
    }

    return results;
}


async function stream(file_id, userId) {
    const { config, remotePath } = await getConfigForPath(file_id, userId);
    const streamClient = createClient(config.url, {
        username: config.username,
        password: config.password
    });
    return streamClient.createReadStream(remotePath);
}

async function getUrl(file_id, userId) {
    const { config, remotePath } = await getConfigForPath(file_id, userId);
    const client = getClient(config);
    return client.getFileDownloadLink(remotePath);
}

async function createDirectory(fullPathArray, userId) {
    // 传入的 fullPathArray 是 getFolderPath 的结果
    if (!Array.isArray(fullPathArray) || fullPathArray.length < 2) return;
    const mountName = fullPathArray[1].name;
    const remotePath = '/' + fullPathArray.slice(2).map(p => p.name).join('/');
    
    const { config } = await getConfigForPath(mountName, userId);
    const client = getClient(config);

    try {
        if (remotePath && remotePath !== '/') {
            await client.createDirectory(remotePath, { recursive: true });
        }
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) {
            return true;
        }
        throw new Error(`创建 WebDAV 目录失败: ${e.message}`);
    }
}

module.exports = { 
    upload, 
    remove, 
    getUrl, 
    stream, 
    resetClient, 
    getClient,
    createDirectory,
    getConfigForPath,
    type: 'webdav' 
};
