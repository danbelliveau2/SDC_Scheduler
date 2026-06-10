/**
 * migrate-sqlite-to-mysql.js
 *
 * One-time migration: reads the legacy SQLite database (scheduler.db) and
 * inserts all rows into the MySQL sdc_scheduler database.
 *
 * Usage:
 *   node migrate-sqlite-to-mysql.js [--db path/to/scheduler.db]
 *
 * The script is safe to re-run — it uses INSERT IGNORE so existing rows are skipped.
 * After a successful run, verify row counts in MySQL then decommission scheduler.db.
 */

require('dotenv').config();
const path = require('path');
const { pool } = require('./mysqlDb');

// ── SQLite open (try better-sqlite3 first, fall back to node:sqlite) ─────────
function openSqlite(dbPath) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    return {
      all: (sql) => db.prepare(sql).all(),
      close: () => db.close(),
    };
  } catch (_) {
    // node:sqlite (Node 22+)
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    return {
      all: (sql) => db.prepare(sql).all(),
      close: () => db.close(),
    };
  }
}

const BATCH = 200;

async function insertBatch(table, rows, cols) {
  if (!rows.length) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const placeholders = chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    const values = chunk.flatMap(r => cols.map(c => r[c] === undefined ? null : r[c]));
    await pool.query(`INSERT IGNORE INTO \`${table}\` (${cols.map(c => `\`${c}\``).join(',')}) VALUES ${placeholders}`, values);
    inserted += chunk.length;
    process.stdout.write(`  ${table}: ${inserted}/${rows.length}\r`);
  }
  console.log(`  ${table}: ${inserted} rows processed.`);
  return inserted;
}

async function resetAutoIncrement(table) {
  const [[row]] = await pool.query(`SELECT MAX(id) AS m FROM \`${table}\``);
  if (row && row.m) {
    await pool.query(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ?`, [row.m + 1]);
  }
}

async function migrate(dbPath) {
  console.log(`[migrate] Opening SQLite: ${dbPath}`);
  const sqlite = openSqlite(dbPath);

  // ── Dependency order ──────────────────────────────────────────────────────
  // tasks must exist before task_comments (FK), no other cross-table deps.

  const tables = [
    {
      name: 'tasks',
      cols: [
        'id','name','project','phase','phase_group','department','sub_department',
        'assignee','start_date','end_date','duration_days','predecessors',
        'is_milestone','progress','allocation','priority','notes','sort_order',
        'anchor_key','baseline_start_date','baseline_end_date','duration_link_task_id',
        'is_action','completed_on','machine','version','created_at',
      ],
    },
    {
      name: 'settings',
      cols: ['key', 'value', 'updated_at'],
    },
    {
      name: 'team_members',
      cols: ['id','name','discipline','active','sort_order','is_lead','specialty','created_at'],
    },
    {
      name: 'project_financials',
      cols: ['id','project','name','percent','amount','due_date','paid','predecessors','sync_to_anchor','sort_order','created_at'],
    },
    {
      name: 'projects',
      cols: ['id','name','status','is_template','job_number','workspace','created_at'],
    },
    {
      name: 'task_history',
      cols: ['id','task_id','project','action','changed_by','changed_at','before_json','after_json','changed_fields'],
    },
    {
      name: 'task_comments',
      cols: ['id','task_id','project','author_id','author_name','body','mentions','created_at','updated_at'],
    },
    {
      name: 'notification_log',
      cols: ['id','user_email','type','task_id','sent_at','reference_key'],
    },
    {
      name: 'users',
      cols: ['id','email','name','password_hash','role','avatar_color','active','created_at','last_login'],
    },
  ];

  for (const { name, cols } of tables) {
    let rows;
    try {
      rows = sqlite.all(`SELECT * FROM \`${name}\``);
    } catch (e) {
      console.log(`  [skip] ${name} — not found in SQLite (${e.message})`);
      continue;
    }
    // Filter cols to only those that actually exist in the SQLite rows
    const availableCols = rows.length ? cols.filter(c => c in rows[0]) : cols;
    await insertBatch(name, rows, availableCols);
    await resetAutoIncrement(name).catch(() => {}); // settings has no id
  }

  sqlite.close();
  console.log('[migrate] Done. MySQL now contains a copy of the SQLite data.');
  console.log('[migrate] Verify row counts, then you can decommission scheduler.db.');
  await pool.end();
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : path.join(__dirname, 'scheduler.db');

migrate(dbPath).catch(err => {
  console.error('[migrate] Fatal:', err.message);
  process.exit(1);
});
