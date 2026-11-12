const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./app.db');

db.configure('busyTimeout', 5000);
db.run('PRAGMA journal_mode = WAL;');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        token TEXT
    )`);

    db.run(`ALTER TABLE users ADD COLUMN password TEXT`, () => {});

    db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        task_name TEXT,
        progress INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        server_port INTEGER
    )`);
});

module.exports = db;
