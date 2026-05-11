const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'scheduler.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    project TEXT,
    phase TEXT,
    assignee TEXT,
    start_date TEXT,
    end_date TEXT,
    duration_days INTEGER,
    predecessors TEXT,
    is_milestone INTEGER DEFAULT 0,
    progress INTEGER DEFAULT 0,
    allocation INTEGER DEFAULT 100,
    priority INTEGER DEFAULT 1,
    notes TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase);
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
  CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    discipline TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_team_discipline ON team_members(discipline);

  -- Per-project financial milestones. Independent from the schedule's predecessor
  -- graph (they don't drive task scheduling), but they DO have a predecessor-style
  -- trigger so the user can tie a payment to "PO date", "FAT date + 1 week", or
  -- "task #5 finish", and the due date is derived. Rendered as an overlay on the
  -- Gantt when the $ Financial toggle is on. Auto-seeded from the
  -- default_financial_milestones setting when a project first appears.
  CREATE TABLE IF NOT EXISTS project_financials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    name TEXT NOT NULL,
    percent REAL,
    amount REAL,            -- optional $ amount; if null, computed from project_value * percent
    due_date TEXT,          -- ISO date; manual override OR derived from predecessors
    paid INTEGER DEFAULT 0,
    predecessors TEXT,      -- e.g. 'PO', 'FAT +1w', '5FS' — drives due_date when set
    sync_to_anchor TEXT,    -- legacy: 'fat' etc. Migrated to predecessors on startup.
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_financials_project ON project_financials(project);
`);

// project_financials migrations — add columns to existing tables without dropping data.
{
  const cols = db.prepare('PRAGMA table_info(project_financials)').all().map(r => r.name);
  if (!cols.includes('predecessors')) {
    db.exec('ALTER TABLE project_financials ADD COLUMN predecessors TEXT');
  }
}

// One-time migration: convert any legacy sync_to_anchor values into the equivalent
// predecessors string. Anchors get short aliases ("PO", "FAT", etc.) so the trigger
// column reads cleanly. Idempotent — only runs on rows that don't yet have
// predecessors set.
db.exec(`
  UPDATE project_financials SET predecessors = 'PO'
    WHERE sync_to_anchor = 'receipt_of_po' AND (predecessors IS NULL OR predecessors = '');
  UPDATE project_financials SET predecessors = 'Power-Up'
    WHERE sync_to_anchor = 'machine_power_up' AND (predecessors IS NULL OR predecessors = '');
  UPDATE project_financials SET predecessors = 'FAT'
    WHERE sync_to_anchor = 'fat' AND (predecessors IS NULL OR predecessors = '');
  UPDATE project_financials SET predecessors = 'Ship'
    WHERE sync_to_anchor = 'ship_machine' AND (predecessors IS NULL OR predecessors = '');
`);

const DEFAULT_SETTINGS = {
  brand_palette: [
    { name: 'SDC Blue',   hex: '#1574c4' },
    { name: 'Light Blue', hex: '#aacee8' },
    { name: 'Navy',       hex: '#061d39' },
    { name: 'Light Gray', hex: '#d9d9d9' },
    { name: 'Yellow',     hex: '#ffde51' },
    { name: 'Green',      hex: '#74c415' },
    { name: 'Lime',       hex: '#befa4f' },
  ],
  theme: {
    primary: '#1574c4',
    dark:    '#061d39',
    accent:  '#ffde51',
  },
  phases: [
    { key: 'me',          label: 'ME — Mechanical', color: '#aacee8', text: '#061d39' },
    { key: 'ce',          label: 'CE — Controls',   color: '#befa4f', text: '#1d4220' },
    { key: 'engineering', label: 'Engineering',     color: '#d9d9d9', text: '#061d39' },
    { key: 'build',       label: 'Build',           color: '#ffde51', text: '#5a4500' },
    { key: 'wire',        label: 'Wire',            color: '#74c415', text: '#0a2e07' },
    { key: 'testing',     label: 'Testing',         color: '#1574c4', text: '#ffffff' },
  ],
  // Standard project milestone templates — names that show up as quick-pick suggestions
  // when adding a milestone task. Editable on Setup → Standard Project Milestones.
  // Anchors (Receipt of PO / Machine Power-Up / FAT / Ship Machine) are NOT in here —
  // those are hard-coded spine markers, auto-created per project.
  project_milestone_library: [
    { name: 'Mech Release 1',        suggested_section: 'design_build',     suggested_dept: 'engineering', suggested_sub: 'mech' },
    { name: 'Mech Release 2',        suggested_section: 'design_build',     suggested_dept: 'engineering', suggested_sub: 'mech' },
    { name: 'Design Review',         suggested_section: 'design_build',     suggested_dept: 'engineering', suggested_sub: 'general' },
    { name: 'Order Long Lead Items', suggested_section: 'design_build',     suggested_dept: 'procurement', suggested_sub: null },
    { name: 'Order Commercial Parts',suggested_section: 'design_build',     suggested_dept: 'procurement', suggested_sub: null },
    { name: 'First Part Full Auto',  suggested_section: 'machine_testing',  suggested_dept: 'engineering', suggested_sub: null },
  ],
  // Default financial milestones — auto-applied to every new project on creation. Edit
  // names/percentages here to change the defaults; per-project overrides are stored on
  // the project_financials table and don't follow this list once a project exists.
  // `predecessors` uses the same syntax as task predecessors plus anchor name aliases
  // (PO / Power-Up / FAT / Ship) so the user doesn't have to know line numbers.
  default_financial_milestones: [
    { name: 'Down Payment',                 percent: 30, predecessors: 'PO' },
    { name: 'Major Commercials',            percent: 40, predecessors: '' },
    { name: 'Acceptance at SDC (FAT)',      percent: 20, predecessors: 'FAT' },
    { name: 'Acceptance at Customer (SAT)', percent: 10, predecessors: 'Ship' },
  ],
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  insertSetting.run(k, JSON.stringify(v));
}

// Fix-up migration: if the list-shaped settings (default_financial_milestones,
// project_milestone_library) exist but were saved as an EMPTY array, refill them
// with the defaults. Happens when the user hit Save on Setup before these defaults
// had been seeded — the empty initial setupDraft overwrote them.
{
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const set = db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?');
  for (const k of ['default_financial_milestones', 'project_milestone_library']) {
    const row = get.get(k);
    let saved = null;
    try { saved = row ? JSON.parse(row.value) : null; } catch {}
    if (Array.isArray(saved) && saved.length === 0) {
      set.run(JSON.stringify(DEFAULT_SETTINGS[k]), k);
    }
  }
}

// Upgrade default_financial_milestones from the legacy sync_to_anchor format to the
// new predecessors format. Idempotent — only adds `predecessors` where missing, and
// only translates the four known anchor keys; custom sync values pass through.
{
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const set = db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?');
  const ALIAS = { receipt_of_po: 'PO', machine_power_up: 'Power-Up', fat: 'FAT', ship_machine: 'Ship' };
  const row = get.get('default_financial_milestones');
  if (row) {
    let arr = null;
    try { arr = JSON.parse(row.value); } catch {}
    if (Array.isArray(arr)) {
      let mutated = false;
      const upgraded = arr.map(e => {
        if (e && typeof e === 'object' && e.predecessors == null && e.sync_to_anchor) {
          mutated = true;
          return { ...e, predecessors: ALIAS[e.sync_to_anchor] || '' };
        }
        return e;
      });
      if (mutated) set.run(JSON.stringify(upgraded), 'default_financial_milestones');
    }
  }
}

function columnExists(table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === col);
}
const migrations = [
  { col: 'project',        sql: 'ALTER TABLE tasks ADD COLUMN project TEXT' },
  { col: 'phase',          sql: 'ALTER TABLE tasks ADD COLUMN phase TEXT' },
  { col: 'is_milestone',   sql: 'ALTER TABLE tasks ADD COLUMN is_milestone INTEGER DEFAULT 0' },
  { col: 'duration_days',  sql: 'ALTER TABLE tasks ADD COLUMN duration_days INTEGER' },
  { col: 'phase_group',    sql: 'ALTER TABLE tasks ADD COLUMN phase_group TEXT' },
  { col: 'department',     sql: 'ALTER TABLE tasks ADD COLUMN department TEXT' },
  { col: 'sub_department', sql: 'ALTER TABLE tasks ADD COLUMN sub_department TEXT' },
  { col: 'allocation',     sql: 'ALTER TABLE tasks ADD COLUMN allocation INTEGER DEFAULT 100' },
  { col: 'priority',       sql: 'ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 1' },
  // anchor_key: when set, this task is a project-level anchor milestone (e.g.
  // 'receipt_of_po', 'fat'). Auto-created per project; rendered as a bigger diamond
  // outside the section hierarchy. Null for ordinary tasks.
  { col: 'anchor_key',     sql: 'ALTER TABLE tasks ADD COLUMN anchor_key TEXT' },
];
for (const m of migrations) {
  if (!columnExists('tasks', m.col)) db.exec(m.sql);
}

if (columnExists('tasks', 'category')) {
  db.exec(`UPDATE tasks SET project = COALESCE(project, category) WHERE category IS NOT NULL AND project IS NULL`);
}

// Anchor-milestone reconciliation — runs every startup. Two stages:
//   1. Backfill anchor_key for any task whose name matches a known anchor but the
//      column is null (happens when the column was added AFTER such tasks existed,
//      or when the API didn't yet accept anchor_key on a previous run).
//   2. Deduplicate: per (project, anchor_key) keep the oldest row, delete the rest.
//      Without this we end up with one Receipt of PO / FAT per page reload.
db.exec(`
  UPDATE tasks SET anchor_key = 'receipt_of_po'
    WHERE LOWER(TRIM(name)) = 'receipt of po' AND (anchor_key IS NULL OR anchor_key = '');
  UPDATE tasks SET anchor_key = 'machine_power_up'
    WHERE LOWER(TRIM(name)) IN ('machine power-up', 'machine powerup', 'machine power up')
      AND (anchor_key IS NULL OR anchor_key = '');
  UPDATE tasks SET anchor_key = 'fat'
    WHERE LOWER(TRIM(name)) = 'fat'           AND (anchor_key IS NULL OR anchor_key = '');
  UPDATE tasks SET anchor_key = 'ship_machine'
    WHERE LOWER(TRIM(name)) = 'ship machine'  AND (anchor_key IS NULL OR anchor_key = '');
  -- Anchor tasks are always milestones — ensure the flag is set so they render as
  -- diamonds even on rows whose name match was inferred after the fact.
  UPDATE tasks SET is_milestone = 1 WHERE anchor_key IS NOT NULL AND anchor_key <> '';
  -- Machine Power-Up lives inside section 10 → Shop → Wire (it's the end of wire
  -- work, when the panel turns on). Backfill placement for any rows that were
  -- created before this convention (i.e. anchor exists but phase_group is unset).
  UPDATE tasks
    SET phase_group    = 'design_build',
        department     = 'shop',
        sub_department = 'wire'
    WHERE anchor_key = 'machine_power_up'
      AND (phase_group IS NULL OR phase_group = '');

  -- Spine-floater anchors (Receipt of PO / FAT / Ship Machine) must NOT have a
  -- phase_group — they render outside the hierarchy walk at fixed positions. Any
  -- non-null phase_group on these rows is leftover from a prior section-50 split
  -- migration that wrapped everything in 'teardown_install', and would cause the
  -- anchor to double-render (once on the spine, once inside the migrated bucket).
  -- Clear the placement fields so they render cleanly.
  UPDATE tasks
    SET phase_group    = NULL,
        department     = NULL,
        sub_department = NULL
    WHERE anchor_key IN ('receipt_of_po', 'fat', 'ship_machine');
`);

// One-time cleanup of weekend dates. Tasks scheduled before we switched to
// business-day math may have start/end on a Saturday or Sunday. Snap start forward
// to the next Monday and end backward to the previous Friday so the duration column
// reads the way the user typed it. Idempotent — runs are no-ops once dates are
// clean.
{
  const isWeekend = (iso) => {
    const day = new Date(iso + 'T00:00:00Z').getUTCDay();
    return day === 0 || day === 6;
  };
  const snap = (iso, dir) => {
    const d = new Date(iso + 'T00:00:00Z');
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      d.setUTCDate(d.getUTCDate() + (dir > 0 ? 1 : -1));
    }
    return d.toISOString().slice(0, 10);
  };
  const rows = db.prepare("SELECT id, start_date, end_date FROM tasks WHERE start_date IS NOT NULL OR end_date IS NOT NULL").all();
  const upd = db.prepare('UPDATE tasks SET start_date = ?, end_date = ? WHERE id = ?');
  for (const r of rows) {
    const ns = r.start_date && isWeekend(r.start_date) ? snap(r.start_date,  1) : r.start_date;
    const ne = r.end_date   && isWeekend(r.end_date)   ? snap(r.end_date,   -1) : r.end_date;
    if (ns !== r.start_date || ne !== r.end_date) upd.run(ns, ne, r.id);
  }
}

// Backfill duration_days for legacy tasks that have start/end but no stored duration.
// Going forward, duration_days is the source of truth — every duration edit writes
// it explicitly. This pass populates it once for existing data so the duration cell
// reads consistently after the migration. Idempotent.
{
  const businessDaysBetweenISO = (s, e) => {
    if (!s || !e) return null;
    const sD = new Date(s + 'T00:00:00Z'), eD = new Date(e + 'T00:00:00Z');
    if (isNaN(sD) || isNaN(eD) || eD < sD) return null;
    let count = 0;
    const cur = new Date(sD);
    while (cur <= eD) {
      const day = cur.getUTCDay();
      if (day !== 0 && day !== 6) count++;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return count;
  };
  const rows = db.prepare("SELECT id, start_date, end_date, is_milestone FROM tasks WHERE duration_days IS NULL AND start_date IS NOT NULL AND end_date IS NOT NULL").all();
  const upd = db.prepare('UPDATE tasks SET duration_days = ? WHERE id = ?');
  for (const r of rows) {
    if (r.is_milestone) { upd.run(0, r.id); continue; }
    const dur = businessDaysBetweenISO(r.start_date, r.end_date);
    if (dur != null && dur > 0) upd.run(dur, r.id);
  }
}

// Section 50 reunified: teardown_install is the single section that spans both
// teardown (at SDC) and install (at the customer's site). Inside it: TEARDOWN dept
// (shop-only) and INSTALL dept (engineering + shop subs). Anything caught in a prior
// split — phase_group='teardown' or 'install' — flows back into teardown_install.
db.exec(`
  UPDATE tasks SET phase_group = 'teardown_install'
    WHERE phase_group IN ('teardown', 'install');

  -- Tasks under engineering/shop directly inside teardown_install are install work
  -- (teardown has no engineering subdept). Promote: department='install',
  -- sub_department=<engineering|shop>. Idempotent — only runs on rows that haven't
  -- already been wrapped.
  UPDATE tasks
    SET sub_department = department,
        department = 'install'
    WHERE phase_group = 'teardown_install'
      AND department IN ('engineering', 'shop')
      AND (sub_department IS NULL OR sub_department = '');
`);
db.exec(`
  DELETE FROM tasks WHERE id IN (
    SELECT id FROM tasks t1
    WHERE t1.anchor_key IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM tasks t2
        WHERE t2.anchor_key = t1.anchor_key
          AND COALESCE(t2.project, '') = COALESCE(t1.project, '')
          AND t2.id < t1.id
      )
  );
`);

// Phase-key migrations. Run idempotently on every startup so the DB is always aligned
// with whatever phase set is current in phases.js.
const phaseRemap = {
  // First-pass legacy keys (from the original 14-phase set)
  mech_review: 'me',
  receive:     'engineering',
  powerup:     'wire',
  configure:   'testing',
  test:        'testing',
  fat:         'testing',
  acceptance:  'testing',
  setup:       null,
  // Second-pass (from the 6-phase consolidated set)
  mech_design: 'me',
  controls:    'ce',
  software:    'ce',
  procurement: 'engineering',
  shop:        'build', // refined below by task name
  test_fat:    'testing',
};
const remapStmt = db.prepare('UPDATE tasks SET phase = ? WHERE phase = ?');
for (const [oldKey, newKey] of Object.entries(phaseRemap)) {
  remapStmt.run(newKey, oldKey);
}

// Smart split: anything tagged Build whose name implies wiring/electrical/power moves to Wire.
db.exec(`
  UPDATE tasks SET phase = 'wire'
  WHERE phase = 'build' AND (
    LOWER(name) LIKE '%wire%' OR
    LOWER(name) LIKE '%panel%' OR
    LOWER(name) LIKE '%electrical%' OR
    LOWER(name) LIKE '%power-up%' OR
    LOWER(name) LIKE '%power up%'
  );
`);

// One-time backfill: when priorities are still all-default-1 across the whole table,
// assign sequential priorities per-assignee in id order so existing data has sensible
// initial rankings (priority 1 = the oldest task they own). Skipped if any task already
// has a priority > 1, which signals the user has started ranking by hand.
const someoneHasPriority = db.prepare('SELECT 1 AS x FROM tasks WHERE priority IS NOT NULL AND priority > 1 LIMIT 1').get();
if (!someoneHasPriority) {
  const all = db.prepare("SELECT id, assignee FROM tasks WHERE assignee IS NOT NULL AND assignee <> '' ORDER BY assignee, id").all();
  const counter = {};
  const upd = db.prepare('UPDATE tasks SET priority = ? WHERE id = ?');
  for (const r of all) {
    counter[r.assignee] = (counter[r.assignee] || 0) + 1;
    upd.run(counter[r.assignee], r.id);
  }
}

module.exports = db;
