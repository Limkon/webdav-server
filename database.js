const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// --- 关键修正：使用 __dirname 确保路径总是相对于目前档案，而不是执行指令的位置 ---
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'database.db');

// --- 启动前的诊断检查 ---
console.log(`[诊断] 检查路径: ${DATA_DIR}`);
try {
    // 1. 确保资料夹存在，如果不存在就建立它
    if (!fs.existsSync(DATA_DIR)) {
        console.log(`[诊断] 'data' 资料夹不存在，正在尝试建立...`);
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log(`[诊断] 'data' 资料夹已建立。`);
    }

    // 2. 尝试测试写入权限
    const testFilePath = path.join(DATA_DIR, 'test_write.tmp');
    console.log(`[诊断] 正在测试写入权限: ${testFilePath}`);
    fs.writeFileSync(testFilePath, 'test');
    fs.unlinkSync(testFilePath);
    console.log(`[诊断] 写入权限测试成功。`);

} catch (error) {
    console.error(`[诊断失败] 在初始化资料库前发生权限错误:`, error);
    // 抛出错误以阻止应用程式继续执行
    throw new Error(`无法初始化资料库储存路径，请检查伺服器对 ${DATA_DIR} 目录的写入权限。`);
}
// --- 诊断结束 ---


const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error("无法连接到资料库:", err.message);
        // 如果这里出错，通常意味着档案存在但已损坏或被锁定
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
        
        console.log("资料库结构初始化完成。");
    });
}

module.exports = db;
