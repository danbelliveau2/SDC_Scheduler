/**
 * azureSync.js — Azure SQL sync layer for SDC Scheduler.
 *
 * Strategy: SQLite is the fast local working DB (synchronous, in-process).
 *           Azure SQL is the authoritative persistent store shared across machines.
 *
 * On startup:
 *   1. Connect to Azure SQL and create schema if needed.
 *   2. Pull all data from Azure SQL → overwrite SQLite.
 *      (If Azure SQL is empty and SQLite has data → push SQLite → Azure SQL.)
 *
 * On write (tasks / team_members / settings / project_financials):
 *   - Caller fires syncTable(table) — async, fire-and-forget.
 *   - Bulk-replaces all rows in Azure SQL for that table with current SQLite state.
 *   - Never blocks a response.
 */
'use strict';

const azureDb = require('./azureDb');

let db         = null; // set by init()
let _syncReady = false;

// ── Public: initialise ────────────────────────────────────────────────────────

async function init(sqliteDb) {
  db = sqliteDb;
  try {
    await azureDb.ensureSchema();
    await _bootstrapData();
    _syncReady = true;
    console.log('[AzureSync] Ready — Azure SQL is the authoritative store.');
  } catch (err) {
    console.warn('[AzureSync] Could not connect to Azure SQL (running local-only):', err.message);
  }
}

// ── Public: sync one table after a local write ────────────────────────────────
// Call this fire-and-forget after any mutation.  e.g.: syncTable('tasks')

async function syncTable(table) {
  if (!_syncReady) return;
  try {
    switch (table) {
      case 'tasks':             await _syncTasks();           break;
      case 'team_members':      await _syncTeamMembers();     break;
      case 'settings':          await _syncSettings();        break;
      case 'project_financials':await _syncProjectFinancials();break;
    }
  } catch (err) {
    console.warn(`[AzureSync] syncTable(${table}) failed (non-fatal):`, err.message);
  }
}

// ── Bootstrap: decide direction (Azure → SQLite  or  SQLite → Azure) ─────────

async function _bootstrapData() {
  const pool   = await azureDb.getPool();
  const azRows = await pool.request().query('SELECT COUNT(*) AS n FROM [scheduler].[tasks]');
  const azCount = azRows.recordset[0].n;

  if (azCount > 0) {
    // Azure has data → pull down to SQLite (Azure is authoritative)
    console.log('[AzureSync] Pulling data from Azure SQL → SQLite …');
    await _pullFromAzure();
  } else {
    // Azure is empty → push SQLite up (first-time migration)
    const localRow = db.prepare('SELECT COUNT(*) AS n FROM tasks').get();
    if (localRow.n > 0) {
      console.log('[AzureSync] First migration: pushing SQLite → Azure SQL …');
      await _pushAllToAzure();
    }
  }
}

// ── Pull Azure SQL → SQLite ───────────────────────────────────────────────────

async function _pullFromAzure() {
  const pool = await azureDb.getPool();

  // tasks
  const tasks = (await pool.request().query('SELECT * FROM [scheduler].[tasks]')).recordset;
  db.exec('DELETE FROM tasks');
  const ins = db.prepare(`
    INSERT OR REPLACE INTO tasks
      (id,name,project,phase,phase_group,department,sub_department,assignee,
       start_date,end_date,duration_days,predecessors,is_milestone,progress,
       allocation,priority,notes,sort_order,anchor_key,
       baseline_start_date,baseline_end_date,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const t of tasks) {
    ins.run(
      t.id, t.name, t.project, t.phase, t.phase_group, t.department, t.sub_department,
      t.assignee, t.start_date, t.end_date, t.duration_days, t.predecessors,
      t.is_milestone ? 1 : 0, t.progress, t.allocation, t.priority, t.notes,
      t.sort_order, t.anchor_key, t.baseline_start_date, t.baseline_end_date,
      t.created_at
    );
  }

  // team_members
  const members = (await pool.request().query('SELECT * FROM [scheduler].[team_members]')).recordset;
  db.exec('DELETE FROM team_members');
  const insM = db.prepare(`
    INSERT OR REPLACE INTO team_members (id,name,discipline,active,sort_order,is_lead,specialty,created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  for (const m of members) {
    insM.run(m.id, m.name, m.discipline, m.active ? 1 : 0, m.sort_order, m.is_lead ? 1 : 0, m.specialty, m.created_at);
  }

  // settings
  const settings = (await pool.request().query('SELECT * FROM [scheduler].[settings]')).recordset;
  if (settings.length > 0) {
    const insS = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)');
    for (const s of settings) insS.run(s.key, s.value, s.updated_at);
  }

  // project_financials
  const fin = (await pool.request().query('SELECT * FROM [scheduler].[project_financials]')).recordset;
  db.exec('DELETE FROM project_financials');
  const insF = db.prepare(`
    INSERT OR REPLACE INTO project_financials
      (id,project,name,percent,amount,due_date,paid,predecessors,sync_to_anchor,sort_order,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const f of fin) {
    insF.run(f.id, f.project, f.name, f.percent, f.amount, f.due_date, f.paid ? 1 : 0,
             f.predecessors, f.sync_to_anchor, f.sort_order, f.created_at);
  }

  console.log(`[AzureSync] Pulled ${tasks.length} tasks, ${members.length} members from Azure SQL.`);
}

// ── Push SQLite → Azure SQL (full replace per table) ─────────────────────────

async function _pushAllToAzure() {
  await _syncTasks();
  await _syncTeamMembers();
  await _syncSettings();
  await _syncProjectFinancials();
  console.log('[AzureSync] Initial push to Azure SQL complete.');
}

async function _syncTasks() {
  const pool  = await azureDb.getPool();
  const rows  = db.prepare('SELECT * FROM tasks').all();
  const { sql } = azureDb;

  await pool.request().query('DELETE FROM [scheduler].[tasks]');

  for (const t of rows) {
    const r = pool.request();
    r.input('id',   sql.Int,         t.id);
    r.input('nm',   sql.NVarChar(500),t.name || '');
    r.input('pr',   sql.NVarChar(255),t.project);
    r.input('ph',   sql.NVarChar(100),t.phase);
    r.input('pg',   sql.NVarChar(100),t.phase_group);
    r.input('dp',   sql.NVarChar(100),t.department);
    r.input('sd',   sql.NVarChar(100),t.sub_department);
    r.input('as_',  sql.NVarChar(255),t.assignee);
    r.input('sd_',  sql.NVarChar(20), t.start_date);
    r.input('ed',   sql.NVarChar(20), t.end_date);
    r.input('dd',   sql.Int,         t.duration_days);
    r.input('pred', sql.NVarChar(500),t.predecessors);
    r.input('im',   sql.Bit,         t.is_milestone ? 1 : 0);
    r.input('pg2',  sql.Int,         t.progress  || 0);
    r.input('al',   sql.Int,         t.allocation|| 100);
    r.input('pri',  sql.Int,         t.priority  || 1);
    r.input('nt',   sql.NVarChar(sql.MAX), t.notes);
    r.input('so',   sql.Int,         t.sort_order|| 0);
    r.input('ak',   sql.NVarChar(100),t.anchor_key);
    r.input('bsd',  sql.NVarChar(20), t.baseline_start_date);
    r.input('bed',  sql.NVarChar(20), t.baseline_end_date);
    r.input('ca',   sql.NVarChar(50), t.created_at);
    await r.query(`
      INSERT INTO [scheduler].[tasks]
        (id,name,project,phase,phase_group,department,sub_department,assignee,
         start_date,end_date,duration_days,predecessors,is_milestone,progress,
         allocation,priority,notes,sort_order,anchor_key,
         baseline_start_date,baseline_end_date,created_at)
      VALUES (@id,@nm,@pr,@ph,@pg,@dp,@sd,@as_,@sd_,@ed,@dd,@pred,@im,@pg2,
              @al,@pri,@nt,@so,@ak,@bsd,@bed,@ca)
    `);
  }
}

async function _syncTeamMembers() {
  const pool = await azureDb.getPool();
  const rows = db.prepare('SELECT * FROM team_members').all();
  const { sql } = azureDb;

  await pool.request().query('DELETE FROM [scheduler].[team_members]');

  for (const m of rows) {
    const r = pool.request();
    r.input('id', sql.Int,          m.id);
    r.input('nm', sql.NVarChar(255),m.name || '');
    r.input('ds', sql.NVarChar(100),m.discipline || '');
    r.input('ac', sql.Bit,         m.active  ? 1 : 0);
    r.input('so', sql.Int,         m.sort_order || 0);
    r.input('il', sql.Bit,         m.is_lead ? 1 : 0);
    r.input('sp', sql.NVarChar(255),m.specialty);
    r.input('ca', sql.NVarChar(50), m.created_at);
    await r.query(`
      INSERT INTO [scheduler].[team_members] (id,name,discipline,active,sort_order,is_lead,specialty,created_at)
      VALUES (@id,@nm,@ds,@ac,@so,@il,@sp,@ca)
    `);
  }
}

async function _syncSettings() {
  const pool = await azureDb.getPool();
  const rows = db.prepare('SELECT * FROM settings').all();
  const { sql } = azureDb;

  for (const s of rows) {
    const r = pool.request();
    r.input('k',  sql.NVarChar(200),s.key);
    r.input('v',  sql.NVarChar(sql.MAX), s.value || '');
    r.input('ua', sql.NVarChar(50), s.updated_at);
    await r.query(`
      MERGE [scheduler].[settings] AS tgt
      USING (SELECT @k AS [key]) AS src ON tgt.[key] = src.[key]
      WHEN MATCHED     THEN UPDATE SET value = @v, updated_at = @ua
      WHEN NOT MATCHED THEN INSERT ([key],value,updated_at) VALUES (@k,@v,@ua);
    `);
  }
}

async function _syncProjectFinancials() {
  const pool = await azureDb.getPool();
  const rows = db.prepare('SELECT * FROM project_financials').all();
  const { sql } = azureDb;

  await pool.request().query('DELETE FROM [scheduler].[project_financials]');

  for (const f of rows) {
    const r = pool.request();
    r.input('id', sql.Int,         f.id);
    r.input('pj', sql.NVarChar(255),f.project || '');
    r.input('nm', sql.NVarChar(255),f.name    || '');
    r.input('pc', sql.Float,       f.percent);
    r.input('am', sql.Float,       f.amount);
    r.input('dd', sql.NVarChar(20), f.due_date);
    r.input('pd', sql.Bit,         f.paid ? 1 : 0);
    r.input('pr', sql.NVarChar(500),f.predecessors);
    r.input('sa', sql.NVarChar(100),f.sync_to_anchor);
    r.input('so', sql.Int,         f.sort_order || 0);
    r.input('ca', sql.NVarChar(50), f.created_at);
    await r.query(`
      INSERT INTO [scheduler].[project_financials]
        (id,project,name,[percent],amount,due_date,paid,predecessors,sync_to_anchor,sort_order,created_at)
      VALUES (@id,@pj,@nm,@pc,@am,@dd,@pd,@pr,@sa,@so,@ca)
    `);
  }
}

module.exports = { init, syncTable };
