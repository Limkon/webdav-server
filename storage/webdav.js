const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// WebDAV 储存对象的工厂函数
function createWebdavStorage(config) {
    const { mountPoint, url, username, password } = config;

    // 为每个实例建立独立的客户端
    const getClient = () => createClient(url, { username, password });

    // 内部函数，获取相对于使用者根目录的 WebDAV 路径
    async function getWebdavPath(folderId, userId, fileName = '') {
        const userRoot = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId], (err, row) => {
                if (err) return reject(err);
                if (!row) return reject(new Error('找不到使用者根目录'));
                resolve(row.id);
            });
        });

        if (folderId === userRoot) {
            throw new Error('不允许直接在使用者根目录进行操作');
        }

        const pathParts = await data.getFolderPath(folderId, userId);
        // 路径从挂载点下一级开始计算
        const relativePath = path.posix.join(...pathParts.slice(2).map(p => p.name), fileName);
        return path.posix.join('/', relativePath);
    }
    
    // 返回一个完整的储存接口对象
    return {
        type: 'webdav',
        mountPoint: mountPoint,

        async upload(tempFilePath, fileName, mimetype, userId, folderId) {
            const client = getClient();
            const remotePath = await getWebdavPath(folderId, userId, fileName);
            const remoteDir = path.posix.dirname(remotePath);

            // 递归创建远端目录
            if (remoteDir && remoteDir !== "/") {
                try {
                    await client.createDirectory(remoteDir, { recursive: true });
                } catch (e) {
                     if (e.response && (e.response.status !== 405 && e.response.status !== 501)) { // 405/501: Method Not Allowed/Not Implemented (目录已存在)
                         throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
                    }
                }
            }

            const fileBuffer = await fsp.readFile(tempFilePath);
            const success = await client.putFileContents(remotePath, fileBuffer, { overwrite: true });

            if (!success) throw new Error('WebDAV putFileContents 操作失败');
            
            const stat = await client.stat(remotePath);
            const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
            
            // 在 file_id 中储存完整的 WebDAV 路径和挂载点资讯
            const fileIdentifier = `${mountPoint}:${remotePath}`;

            const dbResult = await data.addFile({
                message_id: messageId,
                fileName,
                mimetype,
                size: stat.size,
                file_id: fileIdentifier,
                date: new Date(stat.lastmod).getTime(),
            }, folderId, userId, 'webdav');
            
            return { success: true, message: `档案已上传至 ${mountPoint}。`, fileId: dbResult.fileId };
        },

        async remove(files, folders, userId) {
            const client = getClient();
            const results = { success: true, errors: [] };
            const allItemsToDelete = [];

            files.forEach(file => {
                const remotePath = file.file_id.split(':')[1];
                allItemsToDelete.push({ path: remotePath, type: 'file' });
            });

            // 注意：删除资料夹时，我们需要从数据库中重建其在WebDAV上的完整路径
            for (const folder of folders) {
                const remotePath = await getWebdavPath(folder.id, userId);
                 // 确保路径以斜线结尾以表示资料夹
                if (remotePath && remotePath !== '/') {
                   allItemsToDelete.push({ path: remotePath + '/', type: 'folder' });
                }
            }

            allItemsToDelete.sort((a, b) => b.path.length - a.path.length);

            for (const item of allItemsToDelete) {
                try {
                    await client.deleteFile(item.path);
                } catch (error) {
                    if (!(error.response && error.response.status === 404)) {
                        results.errors.push(`删除 WebDAV ${item.type} [${item.path}] 失败: ${error.message}`);
                        results.success = false;
                    }
                }
            }
            return results;
        },

        async stream(file_id, userId) {
            // file_id 格式为 "mountPoint:remote/path/to/file"
            const remotePath = file_id.split(':')[1];
            if (!remotePath) throw new Error('无效的 WebDAV file_id 格式');

            const streamClient = getClient();
            return streamClient.createReadStream(remotePath);
        },

        async getUrl(file_id, userId) {
            const remotePath = file_id.split(':')[1];
            if (!remotePath) throw new Error('无效的 WebDAV file_id 格式');
            const client = getClient();
            return client.getFileDownloadLink(remotePath);
        },
        
        // 移动操作现在在此处处理物理文件移动
        async moveFile(oldFileId, newParentFolderId, newFileName, userId) {
            const client = getClient();
            const oldRemotePath = oldFileId.split(':')[1];
            const newRemotePath = await getWebdavPath(newParentFolderId, userId, newFileName);
            
            if (await client.exists(newRemotePath)) {
                throw new Error("目标位置已存在同名档案。");
            }

            await client.moveFile(oldRemotePath, newRemotePath);
            return `${mountPoint}:${newRemotePath}`; // 返回新的 file_id
        },
        
        async renameFile(file, newFileName, userId) {
            const client = getClient();
            const oldRemotePath = file.file_id.split(':')[1];
            const newRemotePath = path.posix.join(path.posix.dirname(oldRemotePath), newFileName);
            
            await client.moveFile(oldRemotePath, newRemotePath);
            return `${mountPoint}:${newRemotePath}`;
        },
        
        async renameFolder(folder, newName, userId) {
             const client = getClient();
             const oldPath = await getWebdavPath(folder.id, userId);
             const newPath = path.posix.join(path.posix.dirname(oldPath), newName);
             await client.moveFile(oldPath, newPath);
        }
    };
}

module.exports = { createWebdavStorage };
