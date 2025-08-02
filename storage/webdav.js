const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

let client = null;

function getWebdavConfig() {
    const storageManager = require('./index'); 
    const config = storageManager.readConfig();
    const webdavConfig = config.webdav && Array.isArray(config.webdav) ? config.webdav[0] : config.webdav;
    if (!webdavConfig || !webdavConfig.url) {
        throw new Error('WebDAV 设定不完整或未设定');
    }
    return webdavConfig;
}

function getClient() {
    if (!client) {
        console.log('[DEBUG] [storage/webdav.js] Creating new WebDAV client instance.');
        const webdavConfig = getWebdavConfig();
        client = createClient(webdavConfig.url, {
            username: webdavConfig.username,
            password: webdavConfig.password
        });
    }
    return client;
}

function resetClient() {
    console.log('[DEBUG] [storage/webdav.js] Resetting WebDAV client.');
    client = null;
}

async function getFolderPath(folderId, userId) {
    const userRoot = await new Promise((resolve, reject) => {
        db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId], (err, row) => {
            if (err) return reject(err);
            if (!row) return reject(new Error('找不到使用者根目录'));
            resolve(row);
        });
    });

    if (folderId === userRoot.id) return '/';
    
    const pathParts = await data.getFolderPath(folderId, userId);
    const resultPath = '/' + pathParts.slice(1).map(p => p.name).join('/');
    console.log(`[DEBUG] [storage/webdav.js getFolderPath] Resolved folderId ${folderId} to path: ${resultPath}`);
    return resultPath;
}

async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    console.log(`[DEBUG] [storage/webdav.js upload] Starting upload. tempFilePath=${tempFilePath}, fileName=${fileName}, folderId=${folderId}`);
    const client = getClient();
    const folderPath = await getFolderPath(folderId, userId);
    const remotePath = path.posix.join(folderPath, fileName);
    console.log(`[DEBUG] [storage/webdav.js upload] Remote path determined as: ${remotePath}`);
    
    if (folderPath && folderPath !== "/") {
        try {
            console.log(`[DEBUG] [storage/webdav.js upload] Attempting to create directory: ${folderPath}`);
            await client.createDirectory(folderPath, { recursive: true });
            console.log(`[DEBUG] [storage/webdav.js upload] Directory creation successful or directory already exists.`);
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 console.error(`[DEBUG] [storage/webdav.js upload] FATAL: Failed to create directory ${folderPath}. Status: ${e.response.status}`, e);
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
            console.log(`[DEBUG] [storage/webdav.js upload] Directory creation returned ignorable status (405 or 501), proceeding.`);
        }
    }

    const fileBuffer = await fsp.readFile(tempFilePath);
    console.log(`[DEBUG] [storage/webdav.js upload] Putting file contents to ${remotePath} with overwrite: true.`);
    const success = await client.putFileContents(remotePath, fileBuffer, { overwrite: true });

    if (!success) {
        console.error(`[DEBUG] [storage/webdav.js upload] FATAL: WebDAV putFileContents returned false.`);
        throw new Error('WebDAV putFileContents 操作失败');
    }
    console.log(`[DEBUG] [storage/webdav.js upload] putFileContents successful. Stat-ing remote file.`);

    const stat = await client.stat(remotePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    console.log(`[DEBUG] [storage/webdav.js upload] Adding file to DB. message_id=${messageId}, file_id=${remotePath}`);
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stat.size,
        file_id: remotePath,
        date: new Date(stat.lastmod).getTime(),
    }, folderId, userId, 'webdav');
    
    console.log(`[DEBUG] [storage/webdav.js upload] Upload complete. DB result fileId: ${dbResult.fileId}`);
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}

async function move(sourcePath, destinationPath, overwrite = false) {
    console.log(`[DEBUG] [storage/webdav.js move] Initiating move.`);
    console.log(`  - Source: ${sourcePath}`);
    console.log(`  - Destination: ${destinationPath}`);
    console.log(`  - Overwrite: ${overwrite}`);
    
    const client = getClient();
    try {
        await client.moveFile(sourcePath, destinationPath, { overwrite });
        console.log(`[DEBUG] [storage/webdav.js move] Move successful.`);
        return true;
    } catch (error) {
        console.error(`[DEBUG] [storage/webdav.js move] caught an ERROR during moveFile.`);
        if (error.response) {
            console.error(`  - Error Status: ${error.response.status}`);
            console.error(`  - Error Data:`, error.response.data);
        } else {
            console.error(`  - Error Message: ${error.message}`);
        }
        
        // Re-throw the error to be handled by the calling function in data.js
        throw error;
    }
}

async function remove(files, folders, userId) {
    console.log(`[DEBUG] [storage/webdav.js remove] Initiating remove for ${files.length} files and ${folders.length} folders.`);
    const client = getClient();
    const results = { success: true, errors: [] };

    const allItemsToDelete = [];
    
    files.forEach(file => {
        let p = file.file_id.startsWith('/') ? file.file_id : '/' + file.file_id;
        allItemsToDelete.push({ path: path.posix.normalize(p), type: 'file' });
    });
    
    folders.forEach(folder => {
        if (folder.path && folder.path !== '/') {
            let p = folder.path.startsWith('/') ? folder.path : '/' + folder.path;
            allItemsToDelete.push({ path: p, type: 'folder' });
        }
    });

    allItemsToDelete.sort((a, b) => b.path.length - a.path.length);
    console.log(`[DEBUG] [storage/webdav.js remove] Sorted items for deletion:`, allItemsToDelete.map(i => i.path));

    for (const item of allItemsToDelete) {
        try {
            console.log(`[DEBUG] [storage/webdav.js remove] Attempting to delete: ${item.path}`);
            await client.deleteFile(item.path);
            console.log(`[DEBUG] [storage/webdav.js remove] Successfully deleted: ${item.path}`);
        } catch (error) {
            if (error.response && error.response.status === 404) {
                 console.log(`[DEBUG] [storage/webdav.js remove] Item not found, skipping: ${item.path}`);
            } else {
                const errorMessage = `删除 WebDAV ${item.type} [${item.path}] 失败: ${error.message}`;
                console.error(`[DEBUG] [storage/webdav.js remove] ERROR: ${errorMessage}`);
                results.errors.push(errorMessage);
                results.success = false;
            }
        }
    }

    return results;
}

async function stream(file_id, userId) {
    console.log(`[DEBUG] [storage/webdav.js stream] Creating a NEW, ISOLATED client for streaming file: ${file_id}`);
    const webdavConfig = getWebdavConfig();
    const streamClient = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    return streamClient.createReadStream(path.posix.join('/', file_id));
}

async function getUrl(file_id, userId) {
    const client = getClient();
    return client.getFileDownloadLink(path.posix.join('/', file_id));
}

async function createDirectory(fullPath) {
    console.log(`[DEBUG] [storage/webdav.js createDirectory] Creating directory: ${fullPath}`);
    const client = getClient();
    try {
        const remotePath = path.posix.join('/', fullPath);
        if (await client.exists(remotePath)) {
            console.log(`[DEBUG] [storage/webdav.js createDirectory] Directory already exists, skipping.`);
            return true;
        }
        await client.createDirectory(remotePath, { recursive: true });
        console.log(`[DEBUG] [storage/webdav.js createDirectory] Directory created successfully.`);
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) {
            console.log(`[DEBUG] [storage/webdav.js createDirectory] Directory already exists (ignorable error ${e.response.status}).`);
            return true;
        }
        console.error(`[DEBUG] [storage/webdav.js createDirectory] FAILED to create directory.`, e);
        throw new Error(`建立 WebDAV 目录失败: ${e.message}`);
    }
}

module.exports = { upload, remove, getUrl, stream, resetClient, getClient, createDirectory, move, type: 'webdav' };
