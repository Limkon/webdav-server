const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');
const storageManager = require('./index');

// 用 Map 来快取客户端实例
const clientsCache = new Map();

class WebDAVStorage {
    constructor(config) {
        if (!config || !config.id || !config.url) {
            throw new Error("WebDAVStorage 需要一个有效的设定物件，包含 id 和 url");
        }
        this.config = config;
        this.type = 'webdav';

        if (!clientsCache.has(this.config.id)) {
            const client = createClient(this.config.url, {
                username: this.config.username,
                password: this.config.password
            });
            clientsCache.set(this.config.id, client);
        }
        this.client = clientsCache.get(this.config.id);
    }

    static resetAllClients() {
        clientsCache.clear();
    }
    
    // 辅助函数：根据 folderId 获取使用者根目录下的相对路径
    async _getRelativePath(folderId, userId) {
        const pathParts = await data.getFolderPath(folderId, userId);
        // 路径将是挂载点名称之后的部分
        // 例如： /mount1/folderA -> /folderA
        return '/' + pathParts.slice(2).map(p => p.name).join('/');
    }

    async upload(tempFilePath, fileName, mimetype, userId, folderId) {
        // 熔断机制检查
        if (storageManager.isMountFull(this.config.id)) {
            throw new Error(`WebDAV 储存空间已满，暂时无法上传。`);
        }
        
        const relativePath = await this._getRelativePath(folderId, userId);
        const remotePath = path.posix.join('/', relativePath, fileName);
        
        try {
            if (relativePath && relativePath !== "/") {
                await this.client.createDirectory(relativePath, { recursive: true });
            }

            const fileBuffer = await fsp.readFile(tempFilePath);
            const success = await this.client.putFileContents(remotePath, fileBuffer, { overwrite: true });

            if (!success) {
                throw new Error('WebDAV putFileContents 操作失败');
            }

            const stat = await this.client.stat(remotePath);
            const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

            const dbResult = await data.addFile({
                message_id: messageId,
                fileName,
                mimetype,
                size: stat.size,
                file_id: remotePath, // 储存相对于此 WebDAV 根目录的路径
                date: new Date(stat.lastmod).getTime(),
            }, folderId, userId, 'webdav', this.config.id);
            
            return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };

        } catch (error) {
            // 检查是否为空间不足错误 (507 Insufficient Storage)
            if (error.response && error.response.status === 507) {
                storageManager.setMountFull(this.config.id, true);
                throw new Error(`WebDAV 储存空间已满 (507)`);
            }
            throw error; // 重新丢出其他错误
        }
    }

    async remove(files, folders, userId) {
        const results = { success: true, errors: [] };
        const allItemsToDelete = [];

        files.forEach(file => {
            let p = file.file_id.startsWith('/') ? file.file_id : '/' + file.file_id;
            allItemsToDelete.push({ path: path.posix.normalize(p), type: 'file' });
        });
        
        // 注意：WebDAV 的资料夹路径也只是相对于挂载点的
        folders.forEach(folder => {
            if (folder.path && folder.path !== '/') {
                 // 这里的 path 是相对于使用者根目录的完整虚拟路径，如 /mount1/dir1
                 // 我们需要移除挂载点名称部分
                const pathParts = folder.path.split('/').filter(Boolean);
                if (pathParts.length > 1) {
                    const relativePath = '/' + pathParts.slice(1).join('/') + '/';
                    allItemsToDelete.push({ path: relativePath, type: 'folder' });
                }
            }
        });

        allItemsToDelete.sort((a, b) => b.path.length - a.path.length);

        for (const item of allItemsToDelete) {
            try {
                await this.client.deleteFile(item.path);
            } catch (error) {
                if (!(error.response && error.response.status === 404)) {
                    const errorMessage = `删除 WebDAV ${item.type} [${item.path}] 失败: ${error.message}`;
                    console.error(errorMessage);
                    results.errors.push(errorMessage);
                    results.success = false;
                }
            }
        }
        
        // 只要有删除操作，就尝试解除熔断标记
        if (files.length > 0 || folders.length > 0) {
            storageManager.setMountFull(this.config.id, false);
        }

        return results;
    }

    async stream(file_id, userId) {
        // 为流操作创建一次性客户端
        const streamClient = createClient(this.config.url, {
            username: this.config.username,
            password: this.config.password
        });
        return streamClient.createReadStream(path.posix.join('/', file_id));
    }

    async getUrl(file_id, userId) {
        return this.client.getFileDownloadLink(path.posix.join('/', file_id));
    }

    async scan() {
        const log = [];
        const client = this.client;
        const mountId = this.config.id;
        const allUsers = await data.listAllUsers();

        for (const user of allUsers) {
            const userId = user.id;
            log.push({ message: `开始为使用者 ${user.username} (ID: ${userId}) 扫描挂载点 ${mountId}`, type: 'info' });

            const mountFolder = await data.findFolderByName(this.config.name, 1, userId); // 假设根目录 ID 永远是 1
            if (!mountFolder) {
                log.push({ message: `找不到使用者 ${user.username} 的挂载目录，跳过`, type: 'warn' });
                continue;
            }

            try {
                const contents = await client.getDirectoryContents('/', { deep: true });
                for (const item of contents) {
                    if (item.type === 'file') {
                        const existing = await data.findFileByFileIdAndMount(item.filename, mountId, userId);
                        if (existing) {
                            log.push({ message: `已存在: ${item.filename}，跳过。`, type: 'info' });
                        } else {
                            const folderPath = path.posix.dirname(item.filename);
                            const folderId = await data.findOrCreateFolderByPath(`/${this.config.name}${folderPath}`, userId);
                            
                            const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
                            await data.addFile({
                                message_id: messageId,
                                fileName: item.basename,
                                mimetype: item.mime || 'application/octet-stream',
                                size: item.size,
                                file_id: item.filename,
                                date: new Date(item.lastmod).getTime(),
                            }, folderId, userId, 'webdav', mountId);
                            log.push({ message: `已汇入: ${item.filename}`, type: 'success' });
                        }
                    }
                }
            } catch (scanError) {
                 log.push({ message: `扫描挂载点 ${mountId} 时出错: ${scanError.message}`, type: 'error' });
            }
        }
        return log;
    }
}

module.exports = WebDAVStorage;
