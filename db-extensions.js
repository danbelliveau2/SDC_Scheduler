'use strict';
/**
 * db-extensions.js — SDC Automation custom schema additions.
 *
 * This file is intentionally SEPARATE from db.js so it survives the
 * auto-updater that wholesale-replaces db.js from Dan's repo.
 * server.js requires this after db.js so our tables are always created.
 *
 * All statements are idempotent (CREATE TABLE IF NOT EXISTS).
 */

const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'editor',
    active       INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
    last_login   TEXT,
    avatar_color TEXT DEFAULT '#1574c4'
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

  CREATE TABLE IF NOT EXISTS task_comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER NOT NULL,
    project     TEXT,
    author_id   INTEGER,
    author_name TEXT NOT NULL,
    body        TEXT NOT NULL,
    mentions    TEXT,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_comments_task_id ON task_comments(task_id);
  CREATE INDEX IF NOT EXISTS idx_comments_project  ON task_comments(project);

  CREATE TABLE IF NOT EXISTS task_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id        INTEGER,
    project        TEXT,
    action         TEXT NOT NULL,
    changed_by     TEXT,
    changed_at     TEXT DEFAULT CURRENT_TIMESTAMP,
    before_json    TEXT,
    after_json     TEXT,
    changed_fields TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_history_project    ON task_history(project);
  CREATE INDEX IF NOT EXISTS idx_history_changed_at ON task_history(changed_at);

  CREATE TABLE IF NOT EXISTS notification_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email    TEXT NOT NULL,
    type          TEXT NOT NULL,
    task_id       INTEGER,
    sent_at       TEXT DEFAULT CURRENT_TIMESTAMP,
    reference_key TEXT UNIQUE
  );
`);

// Add updated_at / updated_by to tasks if they don't exist yet (idempotent)
function colExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);
}
if (!colExists('tasks', 'updated_at')) db.exec('ALTER TABLE tasks ADD COLUMN updated_at TEXT');
if (!colExists('tasks', 'updated_by')) db.exec('ALTER TABLE tasks ADD COLUMN updated_by TEXT');

// Backfill updated_at for any rows that still have NULL
db.exec(`UPDATE tasks SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL`);

module.exports = db;
