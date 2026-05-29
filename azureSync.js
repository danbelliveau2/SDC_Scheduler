/**
 * azureSync.js — Phase 6 SQLite → Azure SQL push.
 *
 * Mode: PUSH ONLY by default (Dan's call — see chat log). The bootstrap
 * overwrites Azure with the current local SQLite contents on first boot
 * after AZURE_PUSH_ON_BOOT=true is set; per-write syncs do a DELETE +
 * INSERT replace of the affected table.
 *
 * The previous "Abhi pull-on-boot" pattern is DISABLED — pulling from
 * Azure would have wiped Dan's local 185 tasks and replaced them with
 * Abhi's stale 355. To re-enable later, set AZURE_PULL_ON_BOOT=true.
 *
 * Public:
 *   init(sqliteDb)   — ensure schema, optionally do the first push, mark
 *                      _syncReady=true
 *   syncTable(name)  — fire-and-forget table replace, debounced to coalesce
 *                      bursts of writes
 *   pushAll()        — manual full overwrite of every table (admin endpoint)
 *   pullAll()        — manual pull from Azure (admin endpoint, dangerous)
 */
'use strict';

const azureDb = require('./azureDb');

const PUSH_ON_BOOT = process.env.AZURE_PUSH_ON_BOOT === 'true';
const PULL_ON_BOOT = process.env.AZURE_PULL_ON_BOOT === 'true';

let db          = null;
let _syncReady  = false;
const _dirty    = new Set();
let _flushTimer = null;

// ── init ─────────────────────────────────────────────────────────────────
async function init(sqliteDb) {
  db = sqliteDb;
  if (!azureDb.ENABLED) return;
  try {
    await azureDb.ensureSchema();
    if (PULL_ON_BOOT) {
      console.warn('[AzureSync] AZURE_PULL_ON_BOOT=true — pulling Azure → local (will OVERWRITE local).');
      await pullAll();
    } else if (PUSH_ON_BOOT) {
      console.log('[AzureSync] AZURE_PUSH_ON_BOOT=true — pushing local → Azure (will OVERWRITE Azure).');
      await pushAll();
    }
    _syncReady = true;
    console.log('[AzureSync] Ready — write-through is push-only.');
  } catch (e) {
    console.warn('[AzureSync] init skipped — running local-only:', e.message);
  }
}

// ── debounced per-table push ─────────────────────────────────────────────
function syncTable(table) {
  if (!_syncReady) return;
  _dirty.add(table);
  if (_flushTimer) return;
  // 500 ms coalesce window — a cascadeSchedule that touches 30 tasks
  // becomes ONE push, not thirty.
  _flushTimer = setTimeout(_flush, 500);
}

async function _flush() {
  _flushTimer = null;
  const tables = [..._dirty];
  _dirty.clear();
  for (const t of tables) {
    try { await _pushTable(t); }
    catch (e) { console.warn(`[AzureSync] push ${t} failed:`, e.message); }
  }
}

async function _pushTable(table) {
  switch (table) {
    case 'tasks':              return _syncTasks();
    case 'team_members':       return _syncTeamMembers();
    case 'settings':           return _syncSettings();
    case 'project_financials': return _syncProjectFinancials();
    case 'task_history':       return _syncTaskHistory();
    case 'task_comments':      return _syncTaskComments();
    case 'projects':           return _syncProjects();
  }
}

// ── manual full pushes ───────────────────────────────────────────────────
async function pushAll() {
  await _syncTasks();
  await _syncTeamMembers();
  await _syncSettings();
  await _syncProjectFinancials();
  await _syncProjects();
  await _syncTaskHistory();
  await _syncTaskComments();
  console.log('[AzureSync] Full push complete.');
}

// ── manual pull (destructive — overwrites local) ─────────────────────────
async function pullAll() {
  const pool = await azureDb.getPool();

  // tasks
  const tasks = (await pool.request().query('SELECT * FROM [scheduler].[tasks]')).recordset;
  db.exec('DELETE FROM tasks');
  const ins = db.prepare(`
    INSERT OR REPLACE INTO tasks
      (id,name,project,phase,phase_group,department,sub_department,assignee,
       start_date,end_date,duration_days,predecessors,is_milestone,progress,
       allocation,priority,notes,sort_order,anchor_key,
       baseline_start_date,baseline_end_date,created_at,
       duration_link_task_id,is_action,completed_on,machine,version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const t of tasks) {
    ins.run(
      t.id, t.name, t.project, t.phase, t.phase_group, t.department, t.sub_department,
      t.assignee, t.start_date, t.end_date, t.duration_days, t.predecessors,
      t.is_milestone ? 1 : 0, t.progress, t.allocation, t.priority, t.notes,
      t.sort_order, t.anchor_key, t.baseline_start_date, t.baseline_end_date,
      t.created_at,
      t.duration_link_task_id ?? null, t.is_action ? 1 : 0, t.completed_on ?? null,
      t.machine ?? null, t.version ?? 1
    );
  }

  // team_members
  const members = (await pool.request().query('SELECT * FROM [scheduler].[team_members]')).recordset;
  db.exec('DELETE FROM team_members');
  const insM = db.prepare(`INSERT OR REPLACE INTO team_members (id,name,discipline,active,sort_order,is_lead,specialty,created_at) VALUES (?,?,?,?,?,?,?,?)`);
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
  const insF = db.prepare(`INSERT OR REPLACE INTO project_financials (id,project,name,percent,amount,due_date,paid,predecessors,sync_to_anchor,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const f of fin) {
    insF.run(f.id, f.project, f.name, f.percent, f.amount, f.due_date, f.paid ? 1 : 0, f.predecessors, f.sync_to_anchor, f.sort_order, f.created_at);
  }

  // projects
  try {
    const projects = (await pool.request().query('SELECT * FROM [scheduler].[projects]')).recordset;
    if (projects.length > 0) {
      const insP = db.prepare(`INSERT OR REPLACE INTO projects (id,name,status,is_template,job_number,workspace,created_at) VALUES (?,?,?,?,?,?,?)`);
      for (const p of projects) insP.run(p.id, p.name, p.status, p.is_template ? 1 : 0, p.job_number, p.workspace, p.created_at);
    }
  } catch (e) { console.warn('[AzureSync] projects pull skipped:', e.message); }

  // task_history (append)
  try {
    const hist = (await pool.request().query('SELECT * FROM [scheduler].[task_history]')).recordset;
    if (hist.length > 0) {
      const insH = db.prepare(`INSERT OR REPLACE INTO task_history (id,task_id,project,action,changed_by,changed_at,before_json,after_json,changed_fields) VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const h of hist) insH.run(h.id, h.task_id, h.project, h.action, h.changed_by, h.changed_at, h.before_json, h.after_json, h.changed_fields);
    }
  } catch (e) { console.warn('[AzureSync] task_history pull skipped:', e.message); }

  console.log(`[AzureSync] Pulled ${tasks.length} tasks, ${members.length} members from Azure.`);
}

// ── per-table push implementations ───────────────────────────────────────
async function _syncTasks() {
  const pool = await azureDb.getPool();
  const { sql } = azureDb;
  const rows = db.prepare('SELECT * FROM tasks').all();
  await pool.request().query('DELETE FROM [scheduler].[tasks]');
  for (const t of rows) {
    const r = pool.request();
    r.input('id',   sql.Int,            t.id);
    r.input('nm',   sql.NVarChar(500),  t.name || '');
    r.input('pr',   sql.NVarChar(255),  t.project);
    r.input('ph',   sql.NVarChar(100),  t.phase);
    r.input('pg',   sql.NVarChar(100),  t.phase_group);
    r.input('dp',   sql.NVarChar(100),  t.department);
    r.input('sd',   sql.NVarChar(100),  t.sub_department);
    r.input('as_',  sql.NVarChar(255),  t.assignee);
    r.input('sd_',  sql.NVarChar(20),   t.start_date);
    r.input('ed',   sql.NVarChar(20),   t.end_date);
    r.input('dd',   sql.Int,            t.duration_days);
    r.input('pred', sql.NVarChar(500),  t.predecessors);
    r.input('im',   sql.Bit,            t.is_milestone ? 1 : 0);
    r.input('pg2',  sql.Int,            t.progress   || 0);
    r.input('al',   sql.Int,            t.allocation || 100);
    r.input('pri',  sql.Int,            t.priority   || 1);
    r.input('nt',   sql.NVarChar(sql.MAX), t.notes);
    r.input('so',   sql.Int,            t.sort_order || 0);
    r.input('ak',   sql.NVarChar(100),  t.anchor_key);
    r.input('bsd',  sql.NVarChar(20),   t.baseline_start_date);
    r.input('bed',  sql.NVarChar(20),   t.baseline_end_date);
    r.input('ca',   sql.NVarChar(50),   t.created_at);
    r.input('dlt',  sql.Int,            t.duration_link_task_id ?? null);
    r.input('ia',   sql.Bit,            t.is_action ? 1 : 0);
    r.input('co',   sql.NVarChar(20),   t.completed_on ?? null);
    r.input('mc',   sql.NVarChar(100),  t.machine ?? null);
    r.input('vr',   sql.Int,            t.version ?? 1);
    await r.query(`
      INSERT INTO [scheduler].[tasks]
        (id,name,project,phase,phase_group,department,sub_department,assignee,
         start_date,end_date,duration_days,predecessors,is_milestone,progress,
         allocation,priority,notes,sort_order,anchor_key,
         baseline_start_date,baseline_end_date,created_at,
         duration_link_task_id,is_action,completed_on,machine,version)
      VALUES (@id,@nm,@pr,@ph,@pg,@dp,@sd,@as_,@sd_,@ed,@dd,@pred,@im,@pg2,
              @al,@pri,@nt,@so,@ak,@bsd,@bed,@ca,@dlt,@ia,@co,@mc,@vr)
    `);
  }
}

async function _syncTeamMembers() {
  const pool = await azureDb.getPool();
  const { sql } = azureDb;
  const rows = db.prepare('SELECT * FROM team_members').all();
  await pool.request().query('DELETE FROM [scheduler].[team_members]');
  for (const m of rows) {
    const r = pool.request();
    r.input('id', sql.Int,           m.id);
    r.input('nm', sql.NVarChar(255), m.name || '');
    r.input('ds', sql.NVarChar(100), m.discipline || '');
    r.input('ac', sql.Bit,           m.active  ? 1 : 0);
    r.input('so', sql.Int,           m.sort_order || 0);
    r.input('il', sql.Bit,           m.is_lead ? 1 : 0);
    r.input('sp', sql.NVarChar(255), m.specialty || null);
    r.input('ca', sql.NVarChar(50),  m.created_at);
    await r.query(`
      INSERT INTO [scheduler].[team_members] (id,name,discipline,active,sort_order,is_lead,specialty,created_at)
      VALUES (@id,@nm,@ds,@ac,@so,@il,@sp,@ca)
    `);
  }
}

async function _syncSettings() {
  const pool = await azureDb.getPool();
  const { sql } = azureDb;
  const rows = db.prepare('SELECT * FROM settings').all();
  for (const s of rows) {
    const r = pool.request();
    r.input('k',  sql.NVarChar(200),     s.key);
    r.input('v',  sql.NVarChar(sql.MAX), s.value || '');
    r.input('ua', sql.NVarChar(50),      s.updated_at);
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
  const { sql } = azureDb;
  const rows = db.prepare('SELECT * FROM project_financials').all();
  await pool.request().query('DELETE FROM [scheduler].[project_financials]');
  for (const f of rows) {
    const r = pool.request();
    r.input('id', sql.Int,           f.id);
    r.input('pj', sql.NVarChar(255), f.project || '');
    r.input('nm', sql.NVarChar(255), f.name || '');
    r.input('pc', sql.Float,         f.percent);
    r.input('am', sql.Float,         f.amount);
    r.input('dd', sql.NVarChar(20),  f.due_date);
    r.input('pd', sql.Bit,           f.paid ? 1 : 0);
    r.input('pr', sql.NVarChar(500), f.predecessors);
    r.input('sa', sql.NVarChar(100), f.sync_to_anchor);
    r.input('so', sql.Int,           f.sort_order || 0);
    r.input('ca', sql.NVarChar(50),  f.created_at);
    await r.query(`
      INSERT INTO [scheduler].[project_financials]
        (id,project,name,[percent],amount,due_date,paid,predecessors,sync_to_anchor,sort_order,created_at)
      VALUES (@id,@pj,@nm,@pc,@am,@dd,@pd,@pr,@sa,@so,@ca)
    `);
  }
}

async function _syncProjects() {
  const pool = await azureDb.getPool();
  const { sql } = azureDb;
  const rows = db.prepare('SELECT * FROM projects').all();
  await pool.request().query('DELETE FROM [scheduler].[projects]');
  for (const p of rows) {
    const r = pool.request();
    r.input('id', sql.Int,           p.id);
    r.input('nm', sql.NVarChar(255), p.name || '');
    r.input('st', sql.NVarChar(50),  p.status || 'active');
    r.input('it', sql.Bit,           p.is_template ? 1 : 0);
    r.input('jn', sql.NVarChar(100), p.job_number);
    r.input('ws', sql.NVarChar(100), p.workspace || 'default');
    r.input('ca', sql.NVarChar(50),  p.created_at);
    await r.query(`
      INSERT INTO [scheduler].[projects] (id,name,status,is_template,job_number,workspace,created_at)
      VALUES (@id,@nm,@st,@it,@jn,@ws,@ca)
    `);
  }
}

// Append-only: only push history rows that don't yet exist in Azure (by id).
async function _syncTaskHistory() {
  const pool = await azureDb.getPool();
  const { sql } = azureDb;
  const res = await pool.request().query(`SELECT ISNULL(MAX(id), 0) AS max_id FROM [scheduler].[task_history]`);
  const maxAzureId = res.recordset[0].max_id;
  const newRows = db.prepare('SELECT * FROM task_history WHERE id > ?').all(maxAzureId);
  for (const row of newRows) {
    const r = pool.request();
    r.input('id',  sql.Int,                  row.id);
    r.input('tid', sql.Int,                  row.task_id);
    r.input('pj',  sql.NVarChar(255),        row.project);
    r.input('ac',  sql.NVarChar(20),         row.action);
    r.input('cb',  sql.NVarChar(255),        row.changed_by);
    r.input('ca',  sql.NVarChar(50),         row.changed_at);
    r.input('bj',  sql.NVarChar(sql.MAX),    row.before_json);
    r.input('aj',  sql.NVarChar(sql.MAX),    row.after_json);
    r.input('cf',  sql.NVarChar(500),        row.changed_fields);
    await r.query(`
      INSERT INTO [scheduler].[task_history]
        (id,task_id,project,action,changed_by,changed_at,before_json,after_json,changed_fields)
      VALUES (@id,@tid,@pj,@ac,@cb,@ca,@bj,@aj,@cf)
    `);
  }
  if (newRows.length > 0) console.log(`[AzureSync] task_history: synced ${newRows.length} new row(s).`);
}

// Append-only same pattern as history — comments rarely change after post.
async function _syncTaskComments() {
  const pool = await azureDb.getPool();
  const { sql } = azureDb;
  const res = await pool.request().query(`SELECT ISNULL(MAX(id), 0) AS max_id FROM [scheduler].[task_comments]`);
  const maxAzureId = res.recordset[0].max_id;
  const newRows = db.prepare('SELECT * FROM task_comments WHERE id > ?').all(maxAzureId);
  for (const row of newRows) {
    const r = pool.request();
    r.input('id',  sql.Int,                  row.id);
    r.input('tid', sql.Int,                  row.task_id);
    r.input('pj',  sql.NVarChar(255),        row.project);
    r.input('aid', sql.Int,                  row.author_id);
    r.input('anm', sql.NVarChar(255),        row.author_name);
    r.input('bd',  sql.NVarChar(sql.MAX),    row.body);
    r.input('mt',  sql.NVarChar(sql.MAX),    row.mentions);
    r.input('ca',  sql.NVarChar(50),         row.created_at);
    r.input('ua',  sql.NVarChar(50),         row.updated_at);
    await r.query(`
      INSERT INTO [scheduler].[task_comments]
        (id,task_id,project,author_id,author_name,body,mentions,created_at,updated_at)
      VALUES (@id,@tid,@pj,@aid,@anm,@bd,@mt,@ca,@ua)
    `);
  }
  if (newRows.length > 0) console.log(`[AzureSync] task_comments: synced ${newRows.length} new row(s).`);
}

module.exports = { ENABLED: azureDb.ENABLED, init, syncTable, pushAll, pullAll };
