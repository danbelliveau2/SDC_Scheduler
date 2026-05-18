const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const db = new Database('scheduler.db');
db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
const hash = bcrypt.hashSync('sdc_secure_password', 10);
db.prepare('INSERT OR IGNORE INTO users (email, password_hash, role) VALUES (?, ?, ?)').run('akamuju@sdcautomation.com', hash, 'admin');
console.log('Admin user created.');