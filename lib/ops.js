'use strict';
/**
 * ops.js — reliability helpers: database backups, health/status, and a small
 * shared state the /health + Status page read from.
 *
 * Everything here is best-effort and self-contained. A failing backup logs
 * (and optionally emails) but never affects the running app.
 *
 * Env:
 *   BACKUP_DIR        where dumps land (default: ./backups)
 *   BACKUP_KEEP_DAYS  retention (default: 14)
 *   MYSQLDUMP_PATH    path to mysqldump.exe (default: 'mysqldump' on PATH)
 */
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const util = require('util');
const execAsync = util.promisify(exec);

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const BACKUP_KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS) || 14;
const MYSQLDUMP = process.env.MYSQLDUMP_PATH || 'mysqldump';

const startedAt = Date.now();

// Mutable shared state — read by getStatus() for the /health + Status page.
const state = {
  lastBackup: null,   // { at, ok, file, sizeBytes, error }
  lastEtoSync: null,  // { at, pos, created, updated, scope }
};

let APP_VERSION = '?';
try { APP_VERSION = require('../package.json').version || '?'; } catch (_) {}

/** Called from the ETO sync paths so the Status page can show last-sync time. */
function recordEtoSync(result) {
  if (!result) return;
  state.lastEtoSync = {
    at: new Date().toISOString(),
    pos: result.pos, created: result.created, updated: result.updated, scope: result.scope,
  };
}

function _pruneOldBackups() {
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400000;
  let removed = 0;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!f.endsWith('.sql')) continue;
    const full = path.join(BACKUP_DIR, f);
    try { if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed++; } } catch (_) {}
  }
  return removed;
}

/**
 * Dump the MySQL database to a timestamped .sql file, prune old ones, and
 * record the outcome. Resolves to the lastBackup record; rejects on failure
 * (caller decides whether to alert).
 */
async function runBackup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const db = process.env.MYSQL_DATABASE || 'sdc_scheduler';
  const host = process.env.MYSQL_HOST || 'localhost';
  const port = process.env.MYSQL_PORT || 3306;
  const user = process.env.MYSQL_USER || 'root';
  const pass = process.env.MYSQL_PASSWORD || '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `${db}_${stamp}.sql`);

  // Password is passed via MYSQL_PWD env, never on the command line, so it
  // can't leak into process listings or logs.
  const cmd = `"${MYSQLDUMP}" -h ${host} -P ${port} -u ${user} --single-transaction --set-gtid-purged=OFF ${db}`;
  try {
    const { stdout } = await execAsync(cmd, {
      env: { ...process.env, MYSQL_PWD: pass },
      maxBuffer: 1024 * 1024 * 512, // 512 MB — ample for this DB
    });
    fs.writeFileSync(file, stdout);
    const sizeBytes = fs.statSync(file).size;
    if (sizeBytes < 100) throw new Error('dump was empty — check mysqldump path / credentials');
    const pruned = _pruneOldBackups();
    state.lastBackup = { at: new Date().toISOString(), ok: true, file: path.basename(file), sizeBytes, pruned };
    console.log(`[ops] DB backup ok — ${path.basename(file)} (${(sizeBytes / 1024).toFixed(0)} KB)${pruned ? `, pruned ${pruned}` : ''}`);
    return state.lastBackup;
  } catch (e) {
    state.lastBackup = { at: new Date().toISOString(), ok: false, error: e.message };
    console.error('[ops] DB backup FAILED:', e.message);
    throw e;
  }
}

/** Liveness + reliability snapshot. Pings the DB; never throws. */
async function getStatus(pool) {
  let dbStat = { ok: false };
  const t0 = Date.now();
  try {
    await pool.query('SELECT 1');
    dbStat = { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    dbStat = { ok: false, error: e.message };
  }
  return {
    ok: dbStat.ok,
    service: 'scheduler',
    version: APP_VERSION,
    node: process.version,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    db: dbStat,
    lastBackup: state.lastBackup,
    lastEtoSync: state.lastEtoSync,
    backup: { dir: BACKUP_DIR, keepDays: BACKUP_KEEP_DAYS },
  };
}

module.exports = { runBackup, getStatus, recordEtoSync, BACKUP_DIR, BACKUP_KEEP_DAYS };
