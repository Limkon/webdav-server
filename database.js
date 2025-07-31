const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// --- 请加入这两行 ---
const absoluteDataDir = path.join(__dirname, 'data');
console.log(`[侦错资讯] 程式执行的绝对路径 (__dirname): ${__dirname}`);
console.log(`[侦错资讯] 资料库应该位于这个资料夹: ${absoluteDataDir}`);
// --- 侦错程式码结束 ---

const DATA_DIR = path.join(__dirname, 'data'); // 将这里原本的路径改掉
const DB_PATH = path.join(DATA_DIR, 'database.db');

// 确保资料资料夹存在
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error("无法连接到资料库:", err.message);
    } else {
        console.log("成功连接到 SQLite 资料库。");
        initializeDb();
    }
});

function initializeDb() {
    db.serialize(() => {
        // 启用外键约束
        db.run("PRAGMA foreign_keys = ON;");

        // 建立使用者资料表
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0
        )`);

        // 建立资料夹资料表
        db.run(`CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER,
            user_id INTEGER NOT NULL,
            share_token TEXT UNIQUE,
            share_expires_at INTEGER,
            FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(name, parent_id, user_id)
        )`);

        // 建立档案资料表
        db.run(`CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER UNIQUE NOT NULL,
            fileName TEXT NOT NULL,
            mimetype TEXT,
            size INTEGER,
            date INTEGER,
            file_id TEXT NOT NULL,
            thumb_file_id TEXT,
            folder_id INTEGER,
            user_id INTEGER,
            storage_type TEXT NOT NULL,
            share_token TEXT UNIQUE,
            share_expires_at INTEGER,
            FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        
        console.log("资料库初始化完成。");
    });
}

module.exports = db;
