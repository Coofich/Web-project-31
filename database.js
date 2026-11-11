const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./app.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        token TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        task_name TEXT,
        progress INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        server_port INTEGER
    )`);
    
    console.log("База даних успішно ініціалізована.");
});

module.exports = db;
