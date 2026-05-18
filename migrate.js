/**
 * migrate.js — One-time migration: SDC Scheduler SQLite → Azure SQL [scheduler]
 *
 * Run once: node migrate.js
 * Safe to re-run — uses MERGE (upsert) so existing rows are updated, not duplicated.
 */
'use strict';
require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { getPool, ensureSchema, sql } = require('./azureDb');

const DB_PATH = path.join(__dirname, 'scheduler.db');

async function migrateTable(pool, tableName, rows, upsertFn) {
  if (!rows.length) { console.log(`  [${tableName}] No rows — skipped.`); return; }
  let ok = 0, fail = 0;
  for (const row of rows) {
    try {
      await upsertFn(pool, row);
      ok++;
    } catch (e) {
      fail++;
      if (fail <= 3) console.warn(`  [${tableName}] Row ${row.id ?? '?'} failed: ${e.message}`);
    }
  }
  console.log(`  [${tableName}] ${ok} upserted, ${fail} failed.`);
}

async function main() {
  console.log('=== SDC Scheduler → Azure SQL migration ===');

  // Open SQLite
  const sqlite = new DatabaseSync(DB_PATH);
  console.log(`SQLite opened: ${DB_PATH}`);

  // Connect and ensure Azure SQL schema
  const pool = await getPool();
  await ensureSchema();

  // ── tasks ──────────────────────────────────────────────────────────────────
  const tasks = sqlite.prepare('SELECT * FROM tasks').all();
  console.log(`\nMigrating ${tasks.length} tasks…`);
  await migrateTable(pool, 'tasks', tasks, async (pool, r) => {
    const req = pool.request();
    req.input('id',                  sql.Int,           r.id);
    req.input('name',                sql.NVarChar(500),  r.name);
    req.input('project',             sql.NVarChar(255),  r.project             ?? null);
    req.input('phase',               sql.NVarChar(100),  r.phase               ?? null);
    req.input('phase_group',         sql.NVarChar(100),  r.phase_group         ?? null);
    req.input('department',          sql.NVarChar(100),  r.department          ?? null);
    req.input('sub_department',      sql.NVarChar(100),  r.sub_department      ?? null);
    req.input('assignee',            sql.NVarChar(255),  r.assignee            ?? null);
    req.input('start_date',          sql.NVarChar(20),   r.start_date          ?? null);
    req.input('end_date',            sql.NVarChar(20),   r.end_date            ?? null);
    req.input('duration_days',       sql.Int,            r.duration_days       ?? null);
    req.input('predecessors',        sql.NVarChar(500),  r.predecessors        ?? null);
    req.input('is_milestone',        sql.Bit,            r.is_milestone ? 1 : 0);
    req.input('progress',            sql.Int,            r.progress            ?? 0);
    req.input('allocation',          sql.Int,            r.allocation          ?? 100);
    req.input('priority',            sql.Int,            r.priority            ?? 1);
    req.input('notes',               sql.NVarChar(sql.MAX), r.notes            ?? null);
    req.input('sort_order',          sql.Int,            r.sort_order          ?? 0);
    req.input('anchor_key',          sql.NVarChar(100),  r.anchor_key          ?? null);
    req.input('baseline_start_date', sql.NVarChar(20),   r.baseline_start_date ?? null);
    req.input('baseline_end_date',   sql.NVarChar(20),   r.baseline_end_date   ?? null);
    req.input('created_at',          sql.NVarChar(50),   r.created_at          ?? null);
    await req.query(`
      MERGE [scheduler].[tasks] AS target
      USING (SELECT @id AS id) AS src ON target.id = src.id
      WHEN MATCHED THEN UPDATE SET
        name=@name, project=@project, phase=@phase, phase_group=@phase_group,
        department=@department, sub_department=@sub_department, assignee=@assignee,
        start_date=@start_date, end_date=@end_date, duration_days=@duration_days,
        predecessors=@predecessors, is_milestone=@is_milestone, progress=@progress,
        allocation=@allocation, priority=@priority, notes=@notes,
        sort_order=@sort_order, anchor_key=@anchor_key,
        baseline_start_date=@baseline_start_date, baseline_end_date=@baseline_end_date,
        created_at=@created_at
      WHEN NOT MATCHED THEN INSERT
        (id,name,project,phase,phase_group,department,sub_department,assignee,
         start_date,end_date,duration_days,predecessors,is_milestone,progress,
         allocation,priority,notes,sort_order,anchor_key,
         baseline_start_date,baseline_end_date,created_at)
      VALUES
        (@id,@name,@project,@phase,@phase_group,@department,@sub_department,@assignee,
         @start_date,@end_date,@duration_days,@predecessors,@is_milestone,@progress,
         @allocation,@priority,@notes,@sort_order,@anchor_key,
         @baseline_start_date,@baseline_end_date,@created_at);
    `);
  });

  // ── settings ────────────────────────────────────────────────────────────────
  const settings = sqlite.prepare('SELECT key, value, updated_at FROM settings').all();
  console.log(`\nMigrating ${settings.length} settings…`);
  await migrateTable(pool, 'settings', settings.map((r,i) => ({...r, id: i})), async (pool, r) => {
    const req = pool.request();
    req.input('key',        sql.NVarChar(200),      r.key);
    req.input('value',      sql.NVarChar(sql.MAX),  r.value);
    req.input('updated_at', sql.NVarChar(50),       r.updated_at ?? null);
    await req.query(`
      MERGE [scheduler].[settings] AS target
      USING (SELECT @key AS [key]) AS src ON target.[key] = src.[key]
      WHEN MATCHED THEN UPDATE SET value=@value, updated_at=@updated_at
      WHEN NOT MATCHED THEN INSERT ([key], value, updated_at) VALUES (@key, @value, @updated_at);
    `);
  });

  // ── team_members ─────────────────────────────────────────────────────────────
  const members = sqlite.prepare('SELECT * FROM team_members').all();
  console.log(`\nMigrating ${members.length} team members…`);
  await migrateTable(pool, 'team_members', members, async (pool, r) => {
    const req = pool.request();
    req.input('id',         sql.Int,          r.id);
    req.input('name',       sql.NVarChar(255), r.name);
    req.input('discipline', sql.NVarChar(100), r.discipline);
    req.input('active',     sql.Bit,           r.active ? 1 : 0);
    req.input('sort_order', sql.Int,           r.sort_order ?? 0);
    req.input('is_lead',    sql.Bit,           r.is_lead ? 1 : 0);
    req.input('specialty',  sql.NVarChar(255), r.specialty  ?? null);
    req.input('created_at', sql.NVarChar(50),  r.created_at ?? null);
    await req.query(`
      MERGE [scheduler].[team_members] AS target
      USING (SELECT @id AS id) AS src ON target.id = src.id
      WHEN MATCHED THEN UPDATE SET
        name=@name, discipline=@discipline, active=@active, sort_order=@sort_order,
        is_lead=@is_lead, specialty=@specialty, created_at=@created_at
      WHEN NOT MATCHED THEN INSERT
        (id,name,discipline,active,sort_order,is_lead,specialty,created_at)
      VALUES (@id,@name,@discipline,@active,@sort_order,@is_lead,@specialty,@created_at);
    `);
  });

  // ── project_financials ────────────────────────────────────────────────────────
  const financials = sqlite.prepare('SELECT * FROM project_financials').all();
  console.log(`\nMigrating ${financials.length} project financial milestones…`);
  await migrateTable(pool, 'project_financials', financials, async (pool, r) => {
    const req = pool.request();
    req.input('id',             sql.Int,          r.id);
    req.input('project',        sql.NVarChar(255), r.project);
    req.input('name',           sql.NVarChar(255), r.name);
    req.input('percent',        sql.Float,         r.percent        ?? null);
    req.input('amount',         sql.Float,         r.amount         ?? null);
    req.input('due_date',       sql.NVarChar(20),  r.due_date       ?? null);
    req.input('paid',           sql.Bit,           r.paid ? 1 : 0);
    req.input('predecessors',   sql.NVarChar(500), r.predecessors   ?? null);
    req.input('sync_to_anchor', sql.NVarChar(100), r.sync_to_anchor ?? null);
    req.input('sort_order',     sql.Int,           r.sort_order     ?? 0);
    req.input('created_at',     sql.NVarChar(50),  r.created_at     ?? null);
    await req.query(`
      MERGE [scheduler].[project_financials] AS target
      USING (SELECT @id AS id) AS src ON target.id = src.id
      WHEN MATCHED THEN UPDATE SET
        project=@project, name=@name, [percent]=@percent, amount=@amount,
        due_date=@due_date, paid=@paid, predecessors=@predecessors,
        sync_to_anchor=@sync_to_anchor, sort_order=@sort_order, created_at=@created_at
      WHEN NOT MATCHED THEN INSERT
        (id,project,name,[percent],amount,due_date,paid,predecessors,sync_to_anchor,sort_order,created_at)
      VALUES (@id,@project,@name,@percent,@amount,@due_date,@paid,@predecessors,@sync_to_anchor,@sort_order,@created_at);
    `);
  });

  // ── summary ──────────────────────────────────────────────────────────────────
  console.log('\n✅ Migration complete. Azure SQL [scheduler] schema is now populated.');
  console.log('   The app continues to use its local SQLite file as primary storage.');
  console.log('   Re-run this script anytime to refresh the Azure SQL copy.');
  process.exit(0);
}

main().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
