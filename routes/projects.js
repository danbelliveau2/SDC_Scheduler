'use strict';
const { Router } = require('express');
const XLSX = require('xlsx');

// ── Smartsheet phase header → SDC hierarchy mapping ──────────────────────────
const SMARTSHEET_PHASES = {
  'me development phase':   { phase_group: 'design_build',    department: 'engineering', sub_department: 'mech',     discipline: 'mech' },
  'machine control phase':  { phase_group: 'design_build',    department: 'engineering', sub_department: 'controls', discipline: 'controls' },
  'procurement phase':      { phase_group: 'design_build',    department: 'procurement', sub_department: null,       discipline: null },
  'mechanical build phase': { phase_group: 'design_build',    department: 'shop',        sub_department: 'build',    discipline: 'build' },
  'electrical build phase': { phase_group: 'design_build',    department: 'shop',        sub_department: 'wire',     discipline: 'wire' },
  'testing at sdc phase':   { phase_group: 'machine_testing', department: 'engineering', sub_department: null,       discipline: 'controls' },
};

const SMARTSHEET_ANCHORS = {
  'receipt of po':    'receipt_of_po',
  'mech 1 release':   'mech_release_1',
  'mech release 1':   'mech_release_1',
  'machine power-up': 'machine_power_up',
  'machine powerup':  'machine_power_up',
  'machine power up': 'machine_power_up',
  'fat':              'fat',
  'ship machine':     'ship_machine',
};

const SMARTSHEET_SKIP_PATTERNS = [
  /to completion$/i,
  /design to fat$/i,
  /^kick-?off phase$/i,
  /^project start date$/i,
  /^flagged tasks?$/i,
  /^internal deadlines$/i,
  /^machine concepting$/i,
  /^project (links|planner|information log|management|name)$/i,
  /^communication plan$/i,
  /^dashboard$/i,
  /^bom$/i,
  /^task health$/i,
  /^variance\d*$/i,
  /^mech [12]$/i,
  /^controls [12]$/i,
  /^ready for /i,
  /^controls release \([0-9]+ weeks? out\)$/i,
];

const SMARTSHEET_TASK_HINTS = [
  { re: /^machine teardown$/i,                phase_group: 'teardown_install', department: 'teardown', sub_department: null },
  { re: /^teardown( \d+)?$/i,                 phase_group: 'teardown_install', department: 'teardown', sub_department: null },
  { re: /^install at buyer'?s?$/i,            phase_group: 'teardown_install', department: 'install',  sub_department: null },
  { re: /^install( at site)?$/i,              phase_group: 'teardown_install', department: 'install',  sub_department: null },
  { re: /^sat$/i,                             phase_group: 'teardown_install', department: 'install',  sub_department: null },
  { re: /^send final documentation/i,         phase_group: 'teardown_install', department: 'install',  sub_department: null },
  { re: /^conduct project wrap meeting$/i,    phase_group: 'teardown_install', department: 'install',  sub_department: null },
  { re: /^project wrap-?up$/i,                phase_group: 'teardown_install', department: 'install',  sub_department: null },
];

function parseSmartsheetDuration(str) {
  if (str == null || str === '') return null;
  const m = String(str).trim().match(/^([\d.]+)\s*([wd])?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const unit = (m[2] || 'd').toLowerCase();
  return unit === 'w' ? Math.round(n * 5) : Math.round(n);
}

function parseSmartsheetDate(val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const str = String(val).trim();
  const slash = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slash) {
    const mo = parseInt(slash[1], 10);
    const da = parseInt(slash[2], 10);
    let yr = parseInt(slash[3], 10);
    if (yr < 100) yr += 2000;
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    return `${yr}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  return null;
}

// ── Estimate sheet column layout ─────────────────────────────────────────────
const SUMMARY_COLS = {
  parts:       1,
  mech_eng:    4,
  ce_design:   5,
  ce_software: 6,
  ce_database: 7,
  gen_hmi:     8,
  gen_robot:   9,
  gen_vision:  10,
  gen_device:  11,
  mech_build:  12,
  elec_build:  13,
};

function parseEstimateWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const summarySheet = wb.Sheets['SUMMARY FOR RELEASE'];
  if (!summarySheet) {
    throw new Error('Expected sheet "SUMMARY FOR RELEASE" not found. Is this an SDC estimate workbook?');
  }
  const rows = XLSX.utils.sheet_to_json(summarySheet, { header: 1, defval: null, raw: true });
  const findSection = (prefix) => {
    for (const r of rows) {
      if (r && r[0] && String(r[0]).startsWith(prefix)) return r;
    }
    return null;
  };
  const numAt = (r, col) => {
    if (!r) return 0;
    const v = r[col];
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  };
  const extractHours = (sectionRow) => {
    const out = {};
    for (const [key, col] of Object.entries(SUMMARY_COLS)) {
      out[key] = numAt(sectionRow, col);
    }
    return out;
  };
  let section10 = extractHours(findSection('10-'));
  let section40 = extractHours(findSection('40-'));
  let section50 = extractHours(findSection('50-'));

  const looksHorizontal = !findSection('10-') && rows.length >= 5 && rows[3] &&
    rows[3].some(c => /\bME General\b/i.test(String(c || ''))) &&
    rows[3].some(c => /\bMechanical Build\b/i.test(String(c || '')));
  if (looksHorizontal) {
    const header  = rows[3] || [];
    const dataRow = rows[4] || [];
    const colByLabel = (labelRe) => header.findIndex(c => labelRe.test(String(c || '').trim()));
    const val = (col) => col < 0 ? 0 : (Number(dataRow[col]) || 0);
    section10 = {
      parts:       0,
      mech_eng:    val(colByLabel(/^ME General$/i)),
      ce_design:   val(colByLabel(/^Design and Drawings$/i)),
      ce_software: val(colByLabel(/^Software$/i)),
      ce_database: 0,
      gen_hmi:     val(colByLabel(/^HMI$/i)),
      gen_robot:   val(colByLabel(/^Robot$/i)),
      gen_vision:  val(colByLabel(/^Vision$/i)),
      gen_device:  val(colByLabel(/Database/i)),
      mech_build:  val(colByLabel(/^Mechanical Build$/i)),
      elec_build:  val(colByLabel(/^Electrical Build$/i)),
    };
    const groupRow = rows[1] || [];
    const groupAt = [];
    { let g = ''; for (let i = 0; i < header.length; i++) { const raw = String(groupRow[i] == null ? '' : groupRow[i]).trim(); if (raw) g = raw; groupAt[i] = g; } }
    const blankSection = () => ({
      parts: 0, mech_eng: 0, ce_design: 0, ce_software: 0, ce_database: 0,
      gen_hmi: 0, gen_robot: 0, gen_vision: 0, gen_device: 0, mech_build: 0, elec_build: 0,
    });
    section40 = blankSection();
    section50 = blankSection();
    header.forEach((c, i) => {
      const label = String(c == null ? '' : c).trim();
      const g = groupAt[i] || '';
      const tgt = /testing/i.test(g) ? section40 : (/teardown|install/i.test(g) ? section50 : null);
      if (!tgt) return;
      if (/^ME & CE$/i.test(label))      tgt.mech_eng   += val(i);
      else if (/^MB & EB$/i.test(label)) tgt.mech_build += val(i);
    });
    for (let i = 16; i < dataRow.length; i++) {
      const v = Number(dataRow[i]);
      if (Number.isFinite(v) && v > 1000) { section10.parts = v; break; }
    }
  }

  const totals = {
    mech_eng:    section10.mech_eng + section40.mech_eng + section50.mech_eng,
    controls_eng: ['ce_design','ce_software','ce_database'].reduce((s, k) => s + section10[k] + section40[k] + section50[k], 0),
    general_eng: ['gen_hmi','gen_robot','gen_vision','gen_device'].reduce((s, k) => s + section10[k] + section40[k] + section50[k], 0),
    build:       section10.mech_build + section40.mech_build + section50.mech_build,
    wire:        section10.elec_build + section40.elec_build + section50.elec_build,
  };

  let quote_number = '', customer = '', machine_title = '';
  const estSheet = wb.Sheets['ESTIMATE SHEET'];
  if (estSheet) {
    const estRows = XLSX.utils.sheet_to_json(estSheet, { header: 1, defval: null, raw: true });
    for (const r of estRows.slice(0, 10)) {
      if (!r) continue;
      const label = String(r[0] || '').toLowerCase();
      const v = r[1];
      if (v == null) continue;
      if (label.includes('quote') && !quote_number)              quote_number = String(v).trim();
      else if (label === 'customer' && !customer)                customer = String(v).trim();
      else if (label.includes('machine title') && !machine_title) machine_title = String(v).trim();
    }
  }
  const suggested_project_name = [quote_number, customer, machine_title].filter(Boolean).join(' - ') || 'New Project';

  return {
    quote_number, customer, machine_title, suggested_project_name,
    hours_per_section: { section_10: section10, section_40: section40, section_50: section50 },
    discipline_hours: totals,
    section_10_parts_cost: section10.parts,
    section_40_parts_cost: section40.parts,
    section_50_parts_cost: section50.parts,
  };
}

function classifyTask(t) {
  const pg = t.phase_group, d = t.department, sd = t.sub_department;
  const name = (t.name || '').trim();
  if (pg === 'design_build' && d === 'engineering' && sd === 'controls') {
    if (/^controls\s*software$/i.test(name)) return ['section_10', 'controls_software'];
    return ['section_10', 'controls_design'];
  }
  if (pg === 'design_build' && d === 'engineering' && sd === 'general') {
    if (/hmi/i.test(name))    return ['section_10', 'gen_hmi'];
    if (/robot/i.test(name))  return ['section_10', 'gen_robot'];
    if (/vision/i.test(name)) return ['section_10', 'gen_vision'];
    if (/device/i.test(name)) return ['section_10', 'gen_device'];
    return ['section_10', 'gen_hmi'];
  }
  if (pg === 'design_build' && d === 'engineering' && sd === 'mech')     return ['section_10', 'mech_eng'];
  if (pg === 'design_build' && d === 'shop'        && sd === 'build')    return ['section_10', 'build'];
  if (pg === 'design_build' && d === 'shop'        && sd === 'wire')     return ['section_10', 'wire'];
  if (pg === 'machine_testing' && d === 'shop')                          return ['section_40', 'shop_debug'];
  if (pg === 'machine_testing')                                          return ['section_40', 'testing'];
  if (pg === 'teardown_install' && d === 'teardown')                     return ['section_50', 'teardown'];
  if (pg === 'teardown_install' && d === 'install')                      return ['section_50', 'install'];
  return [null, null];
}

function _serverTaskBucket(t) {
  const raw = String(t.name || '').trim();
  const base = raw.replace(/[\s\-_]\d+\s*$/, '').trim();
  const test = (re) => re.test(base) || re.test(raw);
  const pg = t.phase_group, d = t.department, sd = t.sub_department;
  if (test(/^configure machine/i))                return 'configure';
  if (test(/^(engineering\s*testing|me\s*(&|and)\s*ce.*test)/i)) return 'test_debug';
  if (test(/test\/?debug.*(engineer|machine)/i))   return 'test_debug';
  if (pg === 'machine_testing' && d === 'engineering') return 'test_debug';
  if (test(/^(shop\s*debug|shop\s*testing)/i))    return 'shop_debug';
  if (test(/^mb\s*(&|and)\s*eb.*test/i))          return 'shop_debug';
  if (pg === 'machine_testing' && d === 'shop')   return 'shop_debug';
  if (test(/^(controls|ce)\s*(engineering|eng)\b/i)) return 'ce_engineering';
  if (test(/^(controls|ce)[\s\-_]?software/i))    return 'ce_software';
  if (test(/^(controls|ce)[\s\-_]?design/i))      return 'ce_design';
  if (test(/^(controls|ce)[\s\-_]?drawings?/i))   return 'ce_drawings';
  if (test(/^hmi/i))                              return 'gen_hmi';
  if (test(/^robot/i))                            return 'gen_robot';
  if (test(/^vision/i))                           return 'gen_vision';
  if (test(/^(device|general)\s*(programming|engineering)|general machine programming/i)) return 'gen_engineering';
  if (test(/^electrical\s*build/i))               return 'elec_build';
  if (test(/wire[\s\-_]?panel|panel[\s\-_]?(build|wir)/i)) return 'wire_panel';
  if (test(/wire[\s\-_]?machine|machine[\s\-_]?wir/i))    return 'wire_machine';
  if (test(/^(build|builder)\b/i) && pg === 'design_build')                  return 'build';
  if (test(/^(mech|mechanical)[\s\-_]?(design|eng)/i) && pg === 'design_build') return 'mech_eng';
  if (pg === 'design_build' && sd === 'mech')     return 'mech_eng';
  if (pg === 'design_build' && sd === 'controls') return 'ce_engineering';
  if (pg === 'design_build' && sd === 'general')  return 'gen_engineering';
  if (pg === 'design_build' && sd === 'build')    return 'build';
  if (pg === 'design_build' && sd === 'wire')     return 'wire_other';
  if (pg === 'teardown_install' && d === 'teardown') return 'teardown';
  if (pg === 'teardown_install' && d === 'install')  return 'install';
  return null;
}

const _PROMOTE_PEOPLE_FANOUT = {
  ce_engineering:  ['ce_engineering', 'ce_design', 'ce_drawings', 'ce_software'],
  gen_engineering: ['gen_engineering', 'gen_hmi', 'gen_robot', 'gen_vision'],
  elec_build:      ['elec_build', 'wire_panel', 'wire_machine', 'wire_other'],
};

function _promoteDefaultAlloc(bucket) {
  if (!bucket) return 90;
  if (bucket === 'configure' || bucket === 'test_debug') return 85;
  if (bucket === 'shop_debug') return 90;
  if (bucket === 'mech_eng' || bucket.startsWith('ce_') || bucket.startsWith('gen_')) return 85;
  return 90;
}

module.exports = function createRouter(deps) {
  const { pool, io, requireRole, cascadeSchedule, logHistory } = deps;
  const router = Router();

  // ── SSE clients for projects_changed notifications ────────────────────────
  const _sseClients = new Set();

  router.get('/api/events', (req, res) => {
    res.set({
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const heartbeat = setInterval(() => res.write(':ping\n\n'), 25000);
    _sseClients.add(res);
    req.on('close', () => {
      clearInterval(heartbeat);
      _sseClients.delete(res);
    });
  });

  function notifyClients(type, extra = {}) {
    if (_sseClients.size === 0) return;
    const data = JSON.stringify({ type, ...extra });
    for (const client of _sseClients) {
      client.write(`data: ${data}\n\n`);
    }
  }

  // ── addBusinessDaysISO (local copy for estimate/create) ───────────────────
  function addBusinessDaysISO(dateStr, n) {
    if (!dateStr) return null;
    if (n === 0) return dateStr;
    const d = new Date(dateStr + 'T00:00:00Z');
    let remaining = Math.abs(n);
    const dir = n >= 0 ? 1 : -1;
    while (remaining > 0) {
      d.setUTCDate(d.getUTCDate() + dir);
      const day = d.getUTCDay();
      if (day !== 0 && day !== 6) remaining--;
    }
    return d.toISOString().slice(0, 10);
  }

  function businessDaysSpanInclusive(start, end) {
    if (!start || !end) return 0;
    const s = new Date(start + 'T00:00:00Z');
    const e = new Date(end + 'T00:00:00Z');
    if (e < s) return 0;
    let count = 0;
    const cur = new Date(s);
    while (cur <= e) {
      const day = cur.getUTCDay();
      if (day !== 0 && day !== 6) count++;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return count;
  }

  // ── GET /api/projects ─────────────────────────────────────────────────────
  router.get('/api/projects', async (_req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM projects ORDER BY name ASC');
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.post('/api/projects', requireRole('editor'), async (req, res) => {
    try {
      const name = (req.body.name || '').toString().trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      const [[existing]] = await pool.query('SELECT * FROM projects WHERE name = ?', [name]);
      if (existing) return res.json(existing);
      await pool.query(
        'INSERT INTO projects (name, status, is_template, job_number, workspace) VALUES (?, ?, ?, ?, ?)',
        [name, req.body.status || 'active', req.body.is_template ? 1 : 0, req.body.job_number || null, req.body.workspace || 'default']
      );
      const [[row]] = await pool.query('SELECT * FROM projects WHERE name = ?', [name]);
      res.status(201).json(row);
      notifyClients('projects_changed');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/api/projects/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT * FROM projects WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'not found' });

      const allowed = ['name', 'status', 'is_template', 'job_number', 'workspace'];
      const updates = {};
      for (const k of allowed) {
        if (req.body[k] !== undefined) {
          updates[k] = k === 'is_template' ? (req.body[k] ? 1 : 0) : req.body[k];
        }
      }
      if (Object.keys(updates).length === 0) return res.json(existing);

      if (updates.name && updates.name !== existing.name) {
        await pool.query('UPDATE tasks SET project = ? WHERE project = ?', [updates.name, existing.name]);
        await pool.query('UPDATE project_financials SET project = ? WHERE project = ?', [updates.name, existing.name]);
        await pool.query('UPDATE task_history SET project = ? WHERE project = ?', [updates.name, existing.name]);
        await pool.query('UPDATE task_comments SET project = ? WHERE project = ?', [updates.name, existing.name]);
      }

      const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      await pool.query(`UPDATE projects SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
      const [[row]] = await pool.query('SELECT * FROM projects WHERE id = ?', [id]);
      res.json(row);
      notifyClients('projects_changed');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/projects/:id', requireRole('admin'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT * FROM projects WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'not found' });
      await pool.query('DELETE FROM tasks WHERE project = ?', [existing.name]);
      await pool.query('DELETE FROM project_financials WHERE project = ?', [existing.name]);
      await pool.query('DELETE FROM projects WHERE id = ?', [id]);
      res.json({ ok: true });
      notifyClients('projects_changed');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/projects/ensure', requireRole('editor'), async (req, res) => {
    try {
      const name = (req.body.name || '').toString().trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      await pool.query('INSERT IGNORE INTO projects (name) VALUES (?)', [name]);
      const [[row]] = await pool.query('SELECT * FROM projects WHERE name = ?', [name]);
      res.json(row);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Project quote / estimate-file / notes ─────────────────────────────────
  router.get('/api/project/:project/quote', async (req, res) => {
    try {
      const key = `project_quote:${req.params.project}`;
      const [[row]] = await pool.query('SELECT value FROM settings WHERE `key` = ?', [key]);
      if (!row) return res.json(null);
      try { res.json(JSON.parse(row.value)); } catch { res.json(null); }
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.post('/api/project/:project/quote', requireRole('editor'), async (req, res) => {
    try {
      const key = `project_quote:${req.params.project}`;
      const value = JSON.stringify(req.body || {});
      await pool.query(
        'INSERT INTO settings (`key`, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
        [key, value]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/project/:project/quote', requireRole('editor'), async (req, res) => {
    try {
      await pool.query('DELETE FROM settings WHERE `key` = ?', [`project_quote:${req.params.project}`]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/project/:project/estimate-file', async (req, res) => {
    try {
      const key = `project_estimate:${req.params.project}`;
      const [[row]] = await pool.query('SELECT value FROM settings WHERE `key` = ?', [key]);
      if (!row) return res.json(null);
      try { res.json(JSON.parse(row.value)); } catch { res.json(null); }
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.post('/api/project/:project/estimate-file', requireRole('editor'), async (req, res) => {
    try {
      const key = `project_estimate:${req.params.project}`;
      const value = JSON.stringify({
        name: (req.body && req.body.name) || 'estimate.xlsx',
        data: (req.body && req.body.data) || '',
        uploaded_at: new Date().toISOString(),
      });
      await pool.query(
        'INSERT INTO settings (`key`, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
        [key, value]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/project/:project/notes', async (req, res) => {
    try {
      const key = `project_notes:${req.params.project}`;
      const [[row]] = await pool.query('SELECT value FROM settings WHERE `key` = ?', [key]);
      if (!row) return res.json(null);
      try { res.json(JSON.parse(row.value)); } catch { res.json(null); }
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.post('/api/project/:project/notes', requireRole('editor'), async (req, res) => {
    try {
      const key = `project_notes:${req.params.project}`;
      const value = JSON.stringify(req.body || { sessions: [] });
      await pool.query(
        'INSERT INTO settings (`key`, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
        [key, value]
      );
      res.json({ ok: true });
      io.emit('notes:updated', { project: req.params.project });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/import/smartsheet ───────────────────────────────────────────
  router.post('/api/import/smartsheet', requireRole('admin'), async (req, res) => {
    try {
      const projectName = (req.body.project || '').toString().trim();
      const file = req.body.file;
      if (!projectName) return res.status(400).json({ error: 'project name required' });
      if (!file)        return res.status(400).json({ error: 'file (base64) required' });

      const [[existingRow]] = await pool.query("SELECT COUNT(*) AS n FROM tasks WHERE project = ?", [projectName]);
      if (existingRow.n > 0) {
        return res.status(400).json({ error: `Project "${projectName}" already exists. Pick a different name or merge in.` });
      }

      const buf = Buffer.from(file, 'base64');
      const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
      if (!wb.SheetNames.length) return res.status(400).json({ error: 'workbook has no sheets' });

      let rows = null;
      for (const sheetName of wb.SheetNames) {
        const candidate = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: false });
        if (candidate.some(r => Array.isArray(r) && r.some(c => /^task name$/i.test(String(c || '').trim())))) {
          rows = candidate;
          break;
        }
      }
      if (!rows) return res.status(400).json({ error: 'no sheet with a "Task Name" header column found' });

      const headerRowIdx = rows.findIndex(r => Array.isArray(r) && r.some(c => /^task name$/i.test(String(c || '').trim())));
      const headers = rows[headerRowIdx].map(h => String(h || '').trim().toLowerCase());
      const colOf = (label) => headers.indexOf(label);
      const COL = {
        name:          colOf('task name'),
        preds:         colOf('predecessors'),
        duration:      colOf('duration'),
        allocation:    colOf('% allocation'),
        start:         colOf('start date'),
        end:           colOf('finish date'),
        progress:      colOf('% complete'),
        assignee:      colOf('assigned to'),
        comments:      colOf('comments'),
        baselineStart: colOf('baseline start'),
        baselineEnd:   colOf('baseline finish'),
      };

      const items = [];
      let ctx = null;
      let currentPhaseRow = null;
      const phaseTaskRows = {};
      for (let i = headerRowIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r) continue;
        const rawName = r[COL.name];
        if (!rawName) continue;
        const name = String(rawName).trim();
        if (!name) continue;
        const lower = name.toLowerCase();

        if (SMARTSHEET_SKIP_PATTERNS.some(re => re.test(lower))) continue;
        if (lower === projectName.toLowerCase()) continue;
        if (/^\d+_/.test(name) && !ctx) continue;
        const hasStart = r[COL.start] != null && r[COL.start] !== '';
        const hasEnd   = r[COL.end]   != null && r[COL.end]   !== '';
        const hasDur   = r[COL.duration] != null && r[COL.duration] !== '';
        if (!hasStart && !hasEnd && !hasDur) continue;

        const phaseMatch = SMARTSHEET_PHASES[lower];
        if (phaseMatch) {
          ctx = phaseMatch;
          currentPhaseRow = i + 1;
          phaseTaskRows[currentPhaseRow] = [];
          continue;
        }

        const anchorKey = SMARTSHEET_ANCHORS[lower] || null;
        let phase_group = null, department = null, sub_department = null;
        const hint = !anchorKey ? SMARTSHEET_TASK_HINTS.find(h => h.re.test(name)) : null;
        if (anchorKey === 'mech_release_1') {
          phase_group = 'design_build'; department = 'engineering'; sub_department = 'mech';
        } else if (anchorKey === 'machine_power_up') {
          phase_group = 'design_build'; department = 'shop'; sub_department = 'wire';
        } else if (hint) {
          phase_group = hint.phase_group; department = hint.department; sub_department = hint.sub_department;
        } else if (!anchorKey && ctx) {
          phase_group = ctx.phase_group; department = ctx.department; sub_department = ctx.sub_department;
        }

        const duration_days = parseSmartsheetDuration(r[COL.duration]);
        const is_milestone = duration_days === 0 ? 1 : 0;
        const pctToInt = (v) => {
          if (v == null || v === '') return null;
          const cleaned = typeof v === 'string' ? v.replace(/%/g, '').trim() : v;
          if (cleaned === '' || cleaned === null) return null;
          const n = Number(cleaned);
          if (isNaN(n)) return null;
          const pct = n > 1 ? n : n * 100;
          return Math.round(Math.max(0, Math.min(100, pct)));
        };

        const taskRow = i + 1;
        items.push({
          row: taskRow,
          name,
          anchor_key: anchorKey,
          phase_group, department, sub_department,
          start_date:    parseSmartsheetDate(r[COL.start]),
          end_date:      parseSmartsheetDate(r[COL.end]),
          duration_days,
          is_milestone,
          progress:   pctToInt(r[COL.progress]) ?? 0,
          allocation: pctToInt(r[COL.allocation]) ?? 90,
          assignee:   r[COL.assignee] ? String(r[COL.assignee]).trim() : null,
          notes:      r[COL.comments] ? String(r[COL.comments]).trim() : null,
          baseline_start_date: parseSmartsheetDate(r[COL.baselineStart]),
          baseline_end_date:   parseSmartsheetDate(r[COL.baselineEnd]),
          predecessors_raw:    r[COL.preds] ? String(r[COL.preds]).trim() : '',
          _discipline_hint:    ctx?.discipline || null,
        });
        if (currentPhaseRow && !hint && !anchorKey) {
          phaseTaskRows[currentPhaseRow].push(taskRow);
        }
      }

      if (items.length === 0) return res.status(400).json({ error: 'no task rows found in sheet' });

      const sourceRowToId = {};
      const teamToAdd = new Map();
      let order = 0;
      for (const t of items) {
        const [result] = await pool.query(
          `INSERT INTO tasks (name, project, phase_group, department, sub_department, assignee,
                              start_date, end_date, duration_days, is_milestone, progress, allocation,
                              priority, notes, sort_order, anchor_key,
                              baseline_start_date, baseline_end_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          [t.name, projectName,
           t.phase_group, t.department, t.sub_department, t.assignee,
           t.start_date, t.end_date, t.duration_days, t.is_milestone,
           t.progress, t.allocation,
           t.notes, order++, t.anchor_key,
           t.baseline_start_date, t.baseline_end_date]
        );
        sourceRowToId[t.row] = result.insertId;
        if (t.assignee && t._discipline_hint) {
          if (!teamToAdd.has(t.assignee)) teamToAdd.set(t.assignee, t._discipline_hint);
        }
      }

      const phaseFirstId = {};
      const phaseLastId  = {};
      const idToSrcRow   = {};
      for (const [phaseRow, taskRows] of Object.entries(phaseTaskRows)) {
        const ids = taskRows.map(r => sourceRowToId[r]).filter(Boolean);
        if (ids.length === 0) continue;
        phaseFirstId[phaseRow] = ids[0];
        phaseLastId[phaseRow]  = ids[ids.length - 1];
      }
      for (const [row, id] of Object.entries(sourceRowToId)) idToSrcRow[id] = Number(row);

      const resolveSrcRow = (srcRow, relType, ownRow, ownId) => {
        let candidate = sourceRowToId[srcRow] || null;
        if (!candidate) {
          const isFinishEnd = relType === 'FF' || relType === 'SF';
          candidate = (isFinishEnd ? phaseLastId : phaseFirstId)[srcRow] || null;
        }
        if (!candidate) return null;
        if (candidate === ownId) return null;
        const candidateSrcRow = idToSrcRow[candidate];
        if (candidateSrcRow && candidateSrcRow >= ownRow) return null;
        return candidate;
      };
      const remap = (raw, ownRow, ownId) => {
        if (!raw) return null;
        const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
        const out = [];
        for (const part of parts) {
          const m = part.match(/^(\d+)\s*(FS|SS|FF|SF)?\s*([+-]\s*[\d.]+\s*[wd]?)?$/i);
          if (!m) continue;
          const type = (m[2] || '').toUpperCase();
          const newId = resolveSrcRow(Number(m[1]), type, ownRow, ownId);
          if (!newId) continue;
          let lag = '';
          if (m[3]) {
            const lm = m[3].match(/([+-])\s*([\d.]+)\s*([wd]?)/i);
            if (lm) {
              const sign = lm[1];
              const n = parseFloat(lm[2]);
              const unit = (lm[3] || 'd').toLowerCase();
              const rounded = Math.round(n);
              if (rounded > 0) lag = ` ${sign}${rounded}${unit}`;
            }
          }
          out.push(`${newId}${type}${lag}`);
        }
        return out.length ? out.join(', ') : null;
      };
      for (const t of items) {
        const id = sourceRowToId[t.row];
        const remapped = remap(t.predecessors_raw, t.row, id);
        if (remapped) await pool.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [remapped, id]);
      }

      const [haveMemberRows] = await pool.query('SELECT name FROM team_members');
      const haveNames = new Set(haveMemberRows.map(r => r.name.toLowerCase()));
      const addedMembers = [];
      for (const [name, discipline] of teamToAdd) {
        if (haveNames.has(name.toLowerCase())) continue;
        try {
          await pool.query('INSERT INTO team_members (name, discipline) VALUES (?, ?)', [name, discipline]);
          addedMembers.push({ name, discipline });
        } catch (err) { /* ignore */ }
      }

      res.json({
        ok: true,
        project: projectName,
        tasksCreated: items.length,
        addedMembers,
      });
    } catch (err) {
      console.error('Smartsheet import failed:', err);
      res.status(500).json({ error: err.message || 'Import failed' });
    }
  });

  // ── POST /api/import/schedule ─────────────────────────────────────────────
  router.post('/api/import/schedule', requireRole('admin'), async (req, res) => {
    try {
      const projectName = (req.body.project || '').toString().trim();
      const file        = req.body.file;
      const mode        = req.body.mode || 'replace';
      if (!projectName) return res.status(400).json({ error: 'project name required' });
      if (!file)        return res.status(400).json({ error: 'file (base64) required' });

      const buf = Buffer.from(file, 'base64');
      const wb  = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: false });
      if (!wb.SheetNames.length) return res.status(400).json({ error: 'workbook has no sheets' });

      const ws   = wb.Sheets[wb.SheetNames[0]];
      const raw  = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });

      const headerIdx = raw.findIndex(r =>
        Array.isArray(r) && r.some(c => /^task$/i.test(String(c || '').trim()))
      );
      if (headerIdx < 0) return res.status(400).json({ error: 'no header row with a "Task" column found' });

      const headers = raw[headerIdx].map(h => String(h || '').trim().toLowerCase());
      const col = (label) => {
        const patterns = {
          'task':         [/^task$/i],
          'project':      [/^project$/i],
          'phase':        [/^phase$/i],
          'department':   [/^department$/i, /^dept$/i],
          'sub_department':[/^sub.?dept$/i, /^sub.?department$/i],
          'assignee':     [/^assignee$/i, /^assigned to$/i],
          'start_date':   [/^start$/i, /^start date$/i],
          'end_date':     [/^finish$/i, /^end$/i, /^finish date$/i, /^end date$/i],
          'duration_days':[/^duration/i],
          'progress':     [/^%\s*complete$/i, /^progress$/i],
          'predecessors': [/^predecessors$/i, /^pred$/i],
          'notes':        [/^notes$/i, /^comments$/i],
        };
        const pats = patterns[label] || [new RegExp(`^${label}$`, 'i')];
        for (let i = 0; i < headers.length; i++) {
          if (pats.some(p => p.test(headers[i]))) return i;
        }
        return -1;
      };

      const COLS = {
        task:        col('task'),
        project:     col('project'),
        phase:       col('phase'),
        department:  col('department'),
        sub_dept:    col('sub_department'),
        assignee:    col('assignee'),
        start:       col('start_date'),
        end:         col('end_date'),
        duration:    col('duration_days'),
        progress:    col('progress'),
        preds:       col('predecessors'),
        notes:       col('notes'),
      };

      if (COLS.task < 0) return res.status(400).json({ error: '"Task" column not found in header row' });

      const dataRows = [];
      for (let i = headerIdx + 1; i < raw.length; i++) {
        const r = raw[i];
        if (!r) continue;
        const name = COLS.task >= 0 ? String(r[COLS.task] || '').trim() : '';
        if (!name) continue;
        dataRows.push({
          _line:        i - headerIdx,
          name,
          project:      projectName,
          phase:        COLS.phase       >= 0 ? (String(r[COLS.phase]       || '').trim() || null) : null,
          department:   COLS.department  >= 0 ? (String(r[COLS.department]  || '').trim() || null) : null,
          sub_department: COLS.sub_dept  >= 0 ? (String(r[COLS.sub_dept]    || '').trim() || null) : null,
          assignee:     COLS.assignee    >= 0 ? (String(r[COLS.assignee]    || '').trim() || null) : null,
          start_date:   COLS.start       >= 0 ? parseSmartsheetDate(r[COLS.start])  : null,
          end_date:     COLS.end         >= 0 ? parseSmartsheetDate(r[COLS.end])    : null,
          duration_days:COLS.duration    >= 0 ? (parseInt(r[COLS.duration], 10) || null) : null,
          progress:     COLS.progress    >= 0 ? (parseInt(r[COLS.progress], 10) || 0) : 0,
          _rawPreds:    COLS.preds       >= 0 ? (String(r[COLS.preds] || '').trim()) : '',
          notes:        COLS.notes       >= 0 ? (String(r[COLS.notes] || '').trim() || null) : null,
          is_milestone: 0,
          allocation:   100,
          priority:     1,
          sort_order:   0,
        });
      }

      if (dataRows.length === 0) return res.status(400).json({ error: 'no data rows found in file' });

      if (mode === 'replace') {
        await pool.query('DELETE FROM tasks WHERE project = ?', [projectName]);
        await pool.query('DELETE FROM project_financials WHERE project = ?', [projectName]);
      }

      const lineToId = {};
      for (const row of dataRows) {
        const [result] = await pool.query(
          `INSERT INTO tasks
             (name, project, phase, department, sub_department, assignee,
              start_date, end_date, duration_days, progress, notes,
              is_milestone, allocation, priority, sort_order)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [row.name, row.project, row.phase, row.department, row.sub_department,
           row.assignee, row.start_date, row.end_date, row.duration_days,
           row.progress, row.notes, row.is_milestone, row.allocation,
           row.priority, row.sort_order]
        );
        lineToId[row._line] = result.insertId;
      }

      for (const row of dataRows) {
        if (!row._rawPreds) continue;
        const remapped = row._rawPreds.split(',').map(s => {
          const m = s.trim().match(/^(\d+)(.*)$/);
          if (!m) return null;
          const fileLine = parseInt(m[1], 10);
          const targetId = lineToId[fileLine];
          if (!targetId) return null;
          return targetId + (m[2] || '');
        }).filter(Boolean).join(', ');
        if (remapped) await pool.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [remapped, lineToId[row._line]]);
      }

      await pool.query('INSERT IGNORE INTO projects (name) VALUES (?)', [projectName]);

      const inserted = dataRows.length;
      res.json({ ok: true, project: projectName, inserted, mode });
    } catch (err) {
      console.error('[import/schedule]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/estimate/parse ───────────────────────────────────────────────
  router.post('/api/estimate/parse', requireRole('editor'), async (req, res) => {
    try {
      const file = req.body.file;
      if (!file) return res.status(400).json({ error: 'file (base64) required' });
      const parsed = parseEstimateWorkbook(Buffer.from(file, 'base64'));
      res.json({ ok: true, ...parsed });
    } catch (err) {
      console.error('Estimate parse failed:', err);
      res.status(500).json({ error: err.message || 'Parse failed' });
    }
  });

  // ── POST /api/estimate/create ──────────────────────────────────────────────
  router.post('/api/estimate/create', requireRole('admin'), async (req, res) => {
    try {
      const projectName = (req.body.project || '').toString().trim();
      const poDate      = (req.body.po_date || '').toString().trim();
      const fatDate     = (req.body.fat_date || '').toString().trim();
      const efficiency  = Math.max(0.1, Math.min(1, Number(req.body.efficiency) || 0.9));
      const headcount   = req.body.headcount || {};
      const hps         = req.body.hours_per_section || null;
      const backlogRaw = Number(req.body.backlog_weeks);
      const backlogWeeks = Number.isFinite(backlogRaw) ? Math.max(0, Math.min(20, backlogRaw)) : 2;
      const backlogDays  = Math.round(backlogWeeks * 5);
      const hbd         = req.body.hours_breakdown || null;
      if (!projectName) return res.status(400).json({ error: 'project name required' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(poDate))  return res.status(400).json({ error: 'po_date must be YYYY-MM-DD' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fatDate)) return res.status(400).json({ error: 'fat_date must be YYYY-MM-DD' });

      const [[existingCount]] = await pool.query("SELECT COUNT(*) AS n FROM tasks WHERE project = ?", [projectName]);
      if (existingCount.n > 0) {
        return res.status(400).json({ error: `Project "${projectName}" already exists. Pick a different name.` });
      }

      const TEMPLATE = 'SDC_Template';
      const [tplTasksRaw] = await pool.query('SELECT * FROM tasks WHERE project = ? ORDER BY sort_order, id', [TEMPLATE]);
      if (tplTasksRaw.length === 0) {
        return res.status(400).json({ error: `Template "${TEMPLATE}" has no tasks. Open Setup → seed it first.` });
      }
      const tplPo  = tplTasksRaw.find(t => t.anchor_key === 'receipt_of_po');
      const tplFat = tplTasksRaw.find(t => t.anchor_key === 'fat');
      if (!tplPo || !tplFat) {
        return res.status(400).json({ error: `Template "${TEMPLATE}" is missing Receipt of PO and/or FAT anchors.` });
      }

      const skipIds = new Set();
      if ((headcount.mech_eng || 1) < 2) {
        const me2 = tplTasksRaw.find(t => /^ME 2$/i.test(t.name) && t.phase_group === 'design_build');
        if (me2) skipIds.add(me2.id);
      }
      if ((headcount.build || 1) < 2) {
        const builder2 = tplTasksRaw.find(t => /^Builder 2$/i.test(t.name));
        if (builder2) skipIds.add(builder2.id);
      }
      const tplTasks = tplTasksRaw.filter(t => !skipIds.has(t.id));

      const bucketTasks = {};
      const isWorkTask = (t) => !t.is_milestone && !t.anchor_key;
      for (const t of tplTasks) {
        if (!isWorkTask(t)) continue;
        const [sec, disc] = classifyTask(t);
        if (!sec || !disc) continue;
        const key = `${sec}.${disc}`;
        (bucketTasks[key] ||= []).push(t);
      }

      const safe = (n) => Number(n) || 0;
      const bucketHours = {};
      if (hps) {
        const s10 = hps.section_10 || {};
        const s40 = hps.section_40 || {};
        const s50 = hps.section_50 || {};
        bucketHours['section_10.mech_eng']          = safe(s10.mech_eng);
        bucketHours['section_10.controls_design']   = safe(s10.ce_design) + safe(s10.ce_database);
        bucketHours['section_10.controls_software'] = safe(s10.ce_software);
        bucketHours['section_10.gen_hmi']           = safe(s10.gen_hmi)    + safe(s40.gen_hmi);
        bucketHours['section_10.gen_robot']         = safe(s10.gen_robot)  + safe(s40.gen_robot);
        bucketHours['section_10.gen_vision']        = safe(s10.gen_vision) + safe(s40.gen_vision);
        bucketHours['section_10.gen_device']        = safe(s10.gen_device) + safe(s40.gen_device);
        bucketHours['section_10.build']             = safe(s10.mech_build);
        bucketHours['section_10.wire']              = safe(s10.elec_build);
        bucketHours['section_40.testing']           = safe(s40.mech_eng) + safe(s40.ce_design) + safe(s40.ce_software) + safe(s40.ce_database);
        bucketHours['section_40.shop_debug']        = safe(s40.mech_build) + safe(s40.elec_build);
        bucketHours['section_50.teardown']          = safe(s50.mech_build) + safe(s50.elec_build);
        bucketHours['section_50.install']           = safe(s50.ce_design) + safe(s50.ce_software) + safe(s50.ce_database)
                                                    + safe(s50.gen_hmi)  + safe(s50.gen_robot)  + safe(s50.gen_vision) + safe(s50.gen_device)
                                                    + safe(s50.mech_eng) + safe(s50.mech_build) + safe(s50.elec_build);
      }

      const SECTION_50_DAYS = 5;
      const ENG_ALLOC_PCT = 85;
      const SHOP_ALLOC_PCT = 90;
      const allocForBucket = (bucketKey) =>
        /\.(build|wire|shop_debug|teardown|install)$/.test(bucketKey) ? SHOP_ALLOC_PCT : ENG_ALLOC_PCT;

      const snapAllocToDiscrete = (rawPct) => {
        if (rawPct <= 37)  return 25;
        if (rawPct <= 70)  return 50;
        return 90;
      };
      const ceilWeekDays = (hrs, alloc) => {
        if (!hrs || hrs <= 0) return 3;
        const rawDays = hrs / (alloc / 100 * 8);
        for (let n = 1; n <= 400; n++) {
          const bucketDays = Math.ceil(n * 2.5);
          if (rawDays <= bucketDays) return bucketDays;
        }
        return 1000;
      };

      const controlsTotal = (bucketHours['section_10.controls_design'] || 0) + (bucketHours['section_10.controls_software'] || 0);
      const generalTotal  = (bucketHours['section_10.gen_hmi']     || 0) + (bucketHours['section_10.gen_robot']     || 0)
                          + (bucketHours['section_10.gen_vision']  || 0) + (bucketHours['section_10.gen_device']    || 0);
      const minWeeks = {
        mech_eng:     bucketHours['section_10.mech_eng']     / ((headcount.mech_eng     || 1) * 40 * efficiency),
        controls_eng: controlsTotal                          / ((headcount.controls_eng || 1) * 40 * efficiency),
        general_eng:  generalTotal                           / ((headcount.general_eng  || 1) * 40 * efficiency),
        build:        bucketHours['section_10.build']        / ((headcount.build        || 1) * 40 * efficiency),
        wire:         bucketHours['section_10.wire']         / ((headcount.wire         || 1) * 40 * efficiency),
      };
      const engDebugHrs = bucketHours['section_40.testing'] || 0;
      const configureHrs = engDebugHrs * 0.05;
      const debugPerTesterHrs = (engDebugHrs * 0.95) / 2;
      const configureWeeks = configureHrs / (40 * efficiency);
      const debugWeeks     = debugPerTesterHrs / (40 * efficiency);
      const testingWeeks   = configureWeeks + debugWeeks;
      const shopDebugHrs = bucketHours['section_40.shop_debug'] || 0;

      const minBuildWireWeeks = Math.max(minWeeks.build, minWeeks.wire) + 1;
      const totalMinWeeks    = minWeeks.mech_eng + 6 + minBuildWireWeeks + testingWeeks;
      const deliveryWeeks = (new Date(fatDate).getTime() - new Date(poDate).getTime()) / (7 * 86400000);
      const slackWeeks = Math.max(0, deliveryWeeks - totalMinWeeks);

      const taskDurations = {};
      const taskAllocations = {};

      const setStandardBucket = (bucketKey, totalHrs) => {
        const tasks = bucketTasks[bucketKey] || [];
        if (tasks.length === 0) return;
        const alloc = allocForBucket(bucketKey);
        const perTaskHrs = totalHrs / tasks.length;
        const days = ceilWeekDays(perTaskHrs, alloc);
        for (const t of tasks) {
          taskDurations[t.id]   = days;
          taskAllocations[t.id] = alloc;
        }
      };

      setStandardBucket('section_10.mech_eng', bucketHours['section_10.mech_eng']);
      setStandardBucket('section_10.controls_design',   bucketHours['section_10.controls_design']);
      setStandardBucket('section_10.controls_software', bucketHours['section_10.controls_software']);
      setStandardBucket('section_10.gen_hmi',           bucketHours['section_10.gen_hmi']);
      setStandardBucket('section_10.gen_robot',         bucketHours['section_10.gen_robot']);
      setStandardBucket('section_10.gen_vision',        bucketHours['section_10.gen_vision']);
      setStandardBucket('section_10.gen_device',        bucketHours['section_10.gen_device']);
      setStandardBucket('section_10.build',             bucketHours['section_10.build']);
      {
        const wireTasks = bucketTasks['section_10.wire'] || [];
        const panel   = wireTasks.find(t => /panel/i.test(t.name));
        const machine = wireTasks.find(t => /(wire machine|machine wir)/i.test(t.name));
        const totalHrs = bucketHours['section_10.wire'] || 0;
        if (panel && machine && wireTasks.length === 2 && totalHrs > 0) {
          const panelHrs   = hbd?.section_10?.wire_panel   ?? totalHrs * 0.25;
          const machineHrs = hbd?.section_10?.wire_machine ?? totalHrs * 0.75;
          for (const [task, hrs] of [[panel, panelHrs], [machine, machineHrs]]) {
            taskDurations[task.id]   = ceilWeekDays(hrs, SHOP_ALLOC_PCT);
            taskAllocations[task.id] = SHOP_ALLOC_PCT;
          }
        } else {
          setStandardBucket('section_10.wire', totalHrs);
        }
      }
      {
        const ctrlTasks = bucketTasks['section_10.controls_design'] || [];
        const designTask   = ctrlTasks.find(t => /^controls\s*design$/i.test(t.name));
        const drawingsTask = ctrlTasks.find(t => /^controls\s*drawings$/i.test(t.name));
        const totalHrs = bucketHours['section_10.controls_design'] || 0;
        if (designTask && drawingsTask && totalHrs > 0) {
          const designHrs   = hbd?.section_10?.ce_des ?? totalHrs * 0.5;
          const drawingsHrs = hbd?.section_10?.ce_drw ?? totalHrs * 0.5;
          for (const [task, hrs] of [[designTask, designHrs], [drawingsTask, drawingsHrs]]) {
            taskDurations[task.id]   = ceilWeekDays(hrs, ENG_ALLOC_PCT);
            taskAllocations[task.id] = ENG_ALLOC_PCT;
          }
        }
      }

      const testingTasks = bucketTasks['section_40.testing'] || [];
      const configureTask = testingTasks.find(t => /configure/i.test(t.name));
      const debugTasks    = testingTasks.filter(t => t !== configureTask);
      const td1Task = debugTasks.find(t => /test\/?debug.*engineer.*1/i.test(t.name)) || debugTasks[0];
      const td2Tasks = debugTasks.filter(t => t !== td1Task);
      if (configureTask) {
        taskDurations[configureTask.id]   = ceilWeekDays(configureHrs, ENG_ALLOC_PCT);
        taskAllocations[configureTask.id] = ENG_ALLOC_PCT;
      }
      if (td1Task) {
        taskDurations[td1Task.id]   = ceilWeekDays(debugPerTesterHrs, ENG_ALLOC_PCT);
        taskAllocations[td1Task.id] = ENG_ALLOC_PCT;
      }
      for (const t of td2Tasks) {
        taskDurations[t.id]   = td1Task ? taskDurations[td1Task.id] : ceilWeekDays(debugPerTesterHrs, ENG_ALLOC_PCT);
        taskAllocations[t.id] = ENG_ALLOC_PCT;
      }
      const shopDebugTasks = bucketTasks['section_40.shop_debug'] || [];
      const debugDurationDays = td1Task ? taskDurations[td1Task.id] : ceilWeekDays(debugPerTesterHrs, ENG_ALLOC_PCT);
      for (const t of shopDebugTasks) {
        taskDurations[t.id]   = debugDurationDays;
        taskAllocations[t.id] = SHOP_ALLOC_PCT;
      }
      const recomputeSupportAllocs = (durationDays) => {
        const td1HrsCovered = durationDays * 8 * (ENG_ALLOC_PCT / 100);
        for (const t of td2Tasks) {
          const remainingHrs = Math.max(0, engDebugHrs - configureHrs - td1HrsCovered);
          const rawPct = (remainingHrs / (durationDays * 8)) * 100;
          taskAllocations[t.id] = snapAllocToDiscrete(Math.max(0, rawPct));
        }
        for (const t of shopDebugTasks) {
          const rawPct = (shopDebugHrs / (durationDays * 8)) * 100;
          taskAllocations[t.id] = snapAllocToDiscrete(Math.max(0, rawPct));
        }
      };
      recomputeSupportAllocs(debugDurationDays);

      for (const t of bucketTasks['section_50.teardown'] || []) {
        taskDurations[t.id]   = SECTION_50_DAYS;
        taskAllocations[t.id] = SHOP_ALLOC_PCT;
      }
      for (const t of bucketTasks['section_50.install'] || []) {
        taskDurations[t.id]   = SECTION_50_DAYS;
        taskAllocations[t.id] = SHOP_ALLOC_PCT;
      }

      for (const t of tplTasks) {
        if (taskDurations[t.id] != null) continue;
        if (t.is_milestone || t.anchor_key) continue;
        taskDurations[t.id]   = t.duration_days || 1;
        taskAllocations[t.id] = ENG_ALLOC_PCT;
      }

      const oldToNewId = {};
      let sortOrder = 0;
      for (const t of tplTasks) {
        const newDur = taskDurations[t.id] != null ? taskDurations[t.id] : (t.duration_days || 5);
        const newAlloc = taskAllocations[t.id] != null ? taskAllocations[t.id] : ENG_ALLOC_PCT;
        const [r] = await pool.query(
          `INSERT INTO tasks (name, project, phase_group, department, sub_department, assignee,
                              start_date, end_date, duration_days, is_milestone, progress, allocation,
                              priority, notes, sort_order, anchor_key, predecessors)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          [t.name, projectName,
           t.phase_group, t.department, t.sub_department,
           (t.assignee && /placeholder/i.test(t.assignee)) ? t.assignee : null,
           t.start_date || poDate, t.end_date || poDate,
           t.is_milestone ? 0 : newDur, t.is_milestone,
           0,
           t.is_milestone ? (t.allocation == null ? 100 : t.allocation) : newAlloc,
           1, t.notes, sortOrder++, t.anchor_key]
        );
        oldToNewId[t.id] = r.insertId;
      }

      let backlogId = null;
      if (backlogDays > 0) {
        const [r] = await pool.query(
          `INSERT INTO tasks (name, project, phase_group, department, sub_department, assignee,
                              start_date, end_date, duration_days, is_milestone, progress, allocation,
                              priority, notes, sort_order, anchor_key, predecessors)
           VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, 0, 0, 0, 1, NULL, ?, NULL, ?)`,
          ['Backlog', projectName, poDate, poDate, backlogDays, sortOrder++, `${oldToNewId[tplPo.id]}FS`]
        );
        backlogId = r.insertId;
      }

      const mechEngNewIds = new Set((bucketTasks['section_10.mech_eng'] || []).map(t => oldToNewId[t.id]).filter(Boolean));
      const mechEngTplTasks = (bucketTasks['section_10.mech_eng'] || []).slice().sort((a, b) => (b.sort_order || 0) - (a.sort_order || 0));
      const lastMechEngTpl = mechEngTplTasks[0];
      const testDebugMain = (bucketTasks['section_40.testing'] || []).find(t => /test\/?debug.*engineer.*1/i.test(t.name))
                         || (bucketTasks['section_40.testing'] || []).find(t => /test\/?debug/i.test(t.name) && !/configure/i.test(t.name));
      for (const t of tplTasks) {
        const newId = oldToNewId[t.id];
        if (t.anchor_key === 'receipt_of_po') {
          await pool.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [null, newId]);
          continue;
        }
        if (t.anchor_key === 'fat' && testDebugMain) {
          await pool.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [`${oldToNewId[testDebugMain.id]}FF -1w`, newId]);
          continue;
        }
        if (t.anchor_key === 'mech_release_1' && lastMechEngTpl) {
          await pool.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [`${oldToNewId[lastMechEngTpl.id]}FF`, newId]);
          continue;
        }
        if (backlogId && mechEngNewIds.has(newId)) {
          await pool.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [`${backlogId}FS`, newId]);
          continue;
        }
        if (!t.predecessors) continue;
        const remapped = String(t.predecessors).split(',').map(s => {
          const ref = s.trim();
          const m = ref.match(/^(\d+)(.*)$/);
          if (!m) return ref;
          const mappedId = oldToNewId[Number(m[1])];
          return mappedId != null ? `${mappedId}${m[2]}` : ref;
        }).join(', ');
        if (remapped) await pool.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [remapped, newId]);
      }
      await pool.query('UPDATE tasks SET start_date = ?, end_date = ? WHERE id = ?', [poDate, poDate, oldToNewId[tplPo.id]]);

      cascadeSchedule();

      if (testDebugMain) {
        const td1Id = oldToNewId[testDebugMain.id];
        const [[td1Row]] = await pool.query('SELECT start_date, end_date, duration_days FROM tasks WHERE id = ?', [td1Id]);
        if (td1Row && td1Row.start_date && td1Row.end_date) {
          const requiredEndIso = addBusinessDaysISO(fatDate, 5);
          const currentEndMs   = new Date(td1Row.end_date    + 'T00:00:00Z').getTime();
          const requiredEndMs  = new Date(requiredEndIso     + 'T00:00:00Z').getTime();
          if (requiredEndMs > currentEndMs) {
            const gapDays  = businessDaysSpanInclusive(td1Row.end_date, requiredEndIso) - 1;
            let extraDays = 0;
            for (let n = 1; n <= 400; n++) {
              const bucketDays = Math.ceil(n * 2.5);
              if (gapDays <= bucketDays) { extraDays = bucketDays; break; }
            }
            const newDur = td1Row.duration_days + extraDays;
            const testingExtendIds = [
              oldToNewId[testDebugMain.id],
              ...debugTasks.map(t => oldToNewId[t.id]),
              ...shopDebugTasks.map(t => oldToNewId[t.id]),
            ].filter(Boolean);
            for (const id of testingExtendIds) {
              await pool.query('UPDATE tasks SET duration_days = ? WHERE id = ?', [newDur, id]);
            }
            const td1HrsCovered = newDur * 8 * (ENG_ALLOC_PCT / 100);
            for (const t of td2Tasks) {
              const remainingHrs = Math.max(0, engDebugHrs - configureHrs - td1HrsCovered);
              const rawPct = (remainingHrs / (newDur * 8)) * 100;
              const alloc = snapAllocToDiscrete(Math.max(0, rawPct));
              await pool.query('UPDATE tasks SET allocation = ? WHERE id = ?', [alloc, oldToNewId[t.id]]);
            }
            for (const t of shopDebugTasks) {
              const rawPct = (shopDebugHrs / (newDur * 8)) * 100;
              const alloc = snapAllocToDiscrete(Math.max(0, rawPct));
              await pool.query('UPDATE tasks SET allocation = ? WHERE id = ?', [alloc, oldToNewId[t.id]]);
            }
            await cascadeSchedule();
          }
        }
      }

      const [[fatRow]] = await pool.query('SELECT start_date FROM tasks WHERE project = ? AND anchor_key = ?', [projectName, 'fat']);
      let scheduleVariance = null;
      if (fatRow && fatRow.start_date) {
        scheduleVariance = Math.round((new Date(fatRow.start_date).getTime() - new Date(fatDate).getTime()) / 86400000);
      }

      try {
        const [[existingQRow]] = await pool.query('SELECT value FROM settings WHERE `key` = ?', [`project_quote:${projectName}`]);
        let existingQ = {};
        if (existingQRow) { try { existingQ = JSON.parse(existingQRow.value) || {}; } catch (_) { existingQ = {}; } }
        const quote = { ...existingQ, hours_per_section: hps, hours_breakdown: hbd, headcount, efficiency, po_date: poDate, fat_date: fatDate };
        await pool.query(
          'INSERT INTO settings (`key`, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
          [`project_quote:${projectName}`, JSON.stringify(quote)]
        );
      } catch (e) { console.error('Failed to persist quoted hours:', e); }

      res.json({
        ok: true,
        project: projectName,
        tasksCreated: tplTasks.length,
        template: TEMPLATE,
        schedule_variance_days: scheduleVariance,
        computed_fat: fatRow ? fatRow.start_date : null,
        message: scheduleVariance == null
          ? 'Schedule created.'
          : scheduleVariance > 3
            ? `Computed FAT lands ${scheduleVariance} days after the quoted date — schedule doesn't quite fit. Bump headcount on the bottleneck discipline.`
            : scheduleVariance < -3
              ? `Computed FAT is ${Math.abs(scheduleVariance)} days BEFORE the quoted date — testing was extended to absorb slack but couldn't fill the full window. Check schedule.`
              : 'Schedule fits the delivery window.',
      });
    } catch (err) {
      console.error('Estimate create failed:', err);
      res.status(500).json({ error: err.message || 'Create failed' });
    }
  });

  // ── POST /api/projects/:project/duplicate-machine ─────────────────────────
  router.post('/api/projects/:project/duplicate-machine', requireRole('editor'), async (req, res) => {
    try {
      const project = req.params.project;
      const {
        sourceMachine,
        targetMachine,
        chainPredecessors,
        includeTaskIds,
        chainTaskIds,
        customPredecessors,
      } = req.body || {};
      if (!project || !sourceMachine || !targetMachine) {
        return res.status(400).json({ error: 'project, sourceMachine, targetMachine required' });
      }
      if (sourceMachine === targetMachine) {
        return res.status(400).json({ error: 'sourceMachine and targetMachine must differ' });
      }
      const [[existingMachine]] = await pool.query('SELECT COUNT(*) AS c FROM tasks WHERE project = ? AND machine = ?', [project, targetMachine]);
      if (existingMachine.c > 0) {
        return res.status(409).json({ error: `Machine "${targetMachine}" already has ${existingMachine.c} tasks in this project.` });
      }
      let sourceTasks;
      const includeSet = Array.isArray(includeTaskIds) && includeTaskIds.length
        ? new Set(includeTaskIds.map(Number))
        : null;
      if (includeSet) {
        const [allRows] = await pool.query('SELECT * FROM tasks WHERE project = ? ORDER BY sort_order, id', [project]);
        sourceTasks = allRows.filter(t => includeSet.has(t.id));
        if (sourceTasks.length === 0) {
          return res.status(400).json({ error: 'includeTaskIds did not match any tasks in this project.' });
        }
      } else {
        const [rows] = await pool.query('SELECT * FROM tasks WHERE project = ? AND machine = ? ORDER BY sort_order, id', [project, sourceMachine]);
        sourceTasks = rows;
        if (sourceTasks.length === 0) {
          return res.status(404).json({ error: `No tasks found for machine "${sourceMachine}" in project "${project}".` });
        }
      }
      const chainSet = Array.isArray(chainTaskIds) && chainTaskIds.length
        ? new Set(chainTaskIds.map(Number))
        : null;
      const customPredMap = (customPredecessors && typeof customPredecessors === 'object')
        ? Object.fromEntries(Object.entries(customPredecessors).map(([k, v]) => [Number(k), v]))
        : null;
      const cloneCols = ['name', 'project', 'phase', 'phase_group', 'department', 'sub_department', 'assignee', 'start_date', 'end_date', 'duration_days', 'predecessors', 'is_milestone', 'progress', 'allocation', 'priority', 'notes', 'sort_order', 'anchor_key', 'is_action', 'completed_on', 'machine'];
      const [[maxSortRow]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks WHERE project = ?', [project]);
      const maxSort = maxSortRow.m;

      const conn = await pool.getConnection();
      await conn.beginTransaction();
      try {
        const idMap = {};
        const newTasks = [];
        let sortCursor = maxSort + 10;
        for (const t of sourceTasks) {
          const [r] = await conn.query(
            `INSERT INTO tasks (${cloneCols.join(', ')}) VALUES (${cloneCols.map(() => '?').join(', ')})`,
            [t.name, t.project, t.phase, t.phase_group, t.department, t.sub_department,
             t.assignee, t.start_date, t.end_date, t.duration_days,
             null, t.is_milestone, 0, t.allocation, t.priority, t.notes,
             sortCursor, t.anchor_key, t.is_action, null, targetMachine]
          );
          idMap[t.id] = r.insertId;
          newTasks.push({ oldTask: t, newId: r.insertId });
          sortCursor += 10;
        }
        for (const { oldTask, newId } of newTasks) {
          if (!oldTask.predecessors) continue;
          const rewritten = String(oldTask.predecessors)
            .split(',').map(s => s.trim()).filter(Boolean)
            .map(ref => {
              const m = ref.match(/^(\d+)(.*)$/);
              if (!m) return ref;
              const oldId = Number(m[1]);
              const suffix = m[2] || '';
              return idMap[oldId] ? idMap[oldId] + suffix : ref;
            }).join(', ');
          if (rewritten !== oldTask.predecessors) {
            await conn.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [rewritten || null, newId]);
          } else {
            await conn.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [oldTask.predecessors, newId]);
          }
        }
        const shouldChain = (oldId) => {
          if (chainPredecessors) return true;
          if (chainSet) return chainSet.has(Number(oldId));
          return false;
        };
        for (const { oldTask, newId } of newTasks) {
          if (!shouldChain(oldTask.id)) continue;
          const [[row]] = await conn.query('SELECT predecessors FROM tasks WHERE id = ?', [newId]);
          const existing = row.predecessors ? row.predecessors + ', ' : '';
          await conn.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [`${existing}${oldTask.id}FS`, newId]);
        }
        if (customPredMap) {
          console.log(`[duplicate-machine] ${project} → ${targetMachine}: customPredMap keys=${Object.keys(customPredMap).join(',')}`);
          for (const { oldTask, newId } of newTasks) {
            if (!(oldTask.id in customPredMap)) continue;
            const raw = customPredMap[oldTask.id];
            const v = (raw == null) ? '' : String(raw).trim();
            console.log(`[duplicate-machine]   override: srcId=${oldTask.id} (${oldTask.name}) newId=${newId} pred="${v}"`);
            await conn.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [v ? v : null, newId]);
          }
        }
        console.log(`[duplicate-machine] ${project} → ${targetMachine}: ${newTasks.length} cloned`);
        for (const { oldTask, newId } of newTasks) {
          const [[row]] = await conn.query('SELECT predecessors, name FROM tasks WHERE id = ?', [newId]);
          console.log(`[duplicate-machine]   ${newId} ${row.name}: pred="${row.predecessors || ''}" (from srcId=${oldTask.id}, srcPred="${oldTask.predecessors || ''}")`);
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        conn.release();
        return res.status(500).json({ error: String(err.message || err) });
      }
      conn.release();
      await cascadeSchedule();
      const [final] = await pool.query('SELECT * FROM tasks WHERE project = ? AND machine = ? ORDER BY sort_order, id', [project, targetMachine]);
      console.log(`[duplicate-machine] ${project} → ${targetMachine}: post-cascade dates:`);
      for (const r of final) {
        console.log(`[duplicate-machine]   ${r.id} ${r.name}: ${r.start_date} → ${r.end_date}  pred="${r.predecessors || ''}"`);
        await logHistory(r.id, r.project, 'create', null, null, r, ['cloned_from:' + sourceMachine]);
      }
      res.json({ ok: true, cloned: sourceTasks.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/projects/:project/machines/:machine ───────────────────────
  router.delete('/api/projects/:project/machines/:machine', requireRole('editor'), async (req, res) => {
    const project = req.params.project;
    const machine = req.params.machine;
    if (!project || !machine) {
      return res.status(400).json({ error: 'project and machine are required' });
    }
    try {
      const [rows] = await pool.query('SELECT * FROM tasks WHERE project = ? AND machine = ?', [project, machine]);
      if (rows.length === 0) {
        return res.json({ ok: true, deleted: 0 });
      }
      const conn = await pool.getConnection();
      await conn.beginTransaction();
      try {
        for (const r of rows) {
          await conn.query('UPDATE tasks SET anchor_key = NULL WHERE id = ?', [r.id]);
          await conn.query('DELETE FROM tasks WHERE id = ?', [r.id]);
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        conn.release();
        throw err;
      }
      conn.release();
      for (const r of rows) {
        await logHistory(r.id, r.project, 'delete', null, r, null, ['machine_deleted:' + machine]);
      }
      return res.json({ ok: true, deleted: rows.length });
    } catch (err) {
      return res.status(500).json({ error: String(err.message || err) });
    }
  });

  // ── POST /api/project/:source/promote ─────────────────────────────────────
  router.post('/api/project/:source/promote', requireRole('editor'), async (req, res) => {
    try {
      const source  = (req.params.source || '').toString().trim();
      const newName = (req.body.newName || '').toString().trim();
      if (!source || !newName) return res.status(400).json({ error: 'source + newName required' });
      if (source === newName) return res.status(400).json({ error: 'newName must differ from source' });

      const [[srcProj]] = await pool.query('SELECT 1 AS x FROM projects WHERE name = ?', [source]);
      const [[srcTask]] = await pool.query('SELECT 1 AS x FROM tasks WHERE project = ? LIMIT 1', [source]);
      if (!srcProj && !srcTask) return res.status(404).json({ error: `source project '${source}' not found` });
      const [[colProj]] = await pool.query('SELECT 1 AS x FROM projects WHERE name = ?', [newName]);
      const [[colTask]] = await pool.query('SELECT 1 AS x FROM tasks WHERE project = ? LIMIT 1', [newName]);
      if (colProj || colTask) return res.status(409).json({ error: `project '${newName}' already exists` });

      const TEMPLATE = 'SDC_StandardProject_Template';
      const [templateTasks] = await pool.query('SELECT * FROM tasks WHERE project = ? ORDER BY sort_order, id', [TEMPLATE]);
      if (!templateTasks.length) return res.status(500).json({ error: `${TEMPLATE} has no tasks — can't promote` });

      const [[quoteRow]] = await pool.query('SELECT value FROM settings WHERE `key` = ?', [`project_quote:${source}`]);
      let quote = null;
      if (quoteRow) { try { quote = JSON.parse(quoteRow.value); } catch (_) { quote = null; } }
      const peopleBreakdown = (quote && quote.people_breakdown) || {};
      const overrides       = (quote && quote.quoted_overrides) || {};

      const safe = (v) => Math.round(v || 0);
      const hb   = (quote && quote.hours_breakdown) || {};
      const s10 = hb.section_10 || {}, s40 = hb.section_40 || {}, s50 = hb.section_50 || {};
      const bucketHours = {
        mech_eng:     safe(s10.mech) + safe(s50.mech),
        ce_design:    safe(s10.ce_des),
        ce_drawings:  safe(s10.ce_drw),
        ce_software:  safe(s10.ce_sw),
        gen_hmi:      safe(s10.hmi)    + safe(s40.hmi),
        gen_robot:    safe(s10.robot)  + safe(s40.robot),
        gen_vision:   safe(s10.vision) + safe(s40.vision),
        build:        safe(s10.build),
        wire_panel:   safe(s10.wire_panel),
        wire_machine: safe(s10.wire_machine),
        test_debug:   safe(s40.mech) + safe(s40.ce_des) + safe(s40.ce_drw) + safe(s40.ce_sw)
                      + safe(s40.hmi) + safe(s40.robot) + safe(s40.vision),
        configure:    0,
        shop_debug:   safe(s40.build) + safe(s40.wire_panel) + safe(s40.wire_machine),
        teardown:     safe(s50.build) + safe(s50.wire_panel) + safe(s50.wire_machine),
        install:      safe(s50.ce_des) + safe(s50.ce_drw) + safe(s50.ce_sw)
                      + safe(s50.hmi) + safe(s50.robot) + safe(s50.vision),
      };
      bucketHours.configure  = Math.round(bucketHours.test_debug * 0.05);
      bucketHours.test_debug = bucketHours.test_debug - bucketHours.configure;
      for (const k of Object.keys(overrides)) {
        const v = Number(overrides[k]);
        if (Number.isFinite(v) && v >= 0) bucketHours[k] = Math.round(v);
      }

      const effectivePeople = (bucket) => {
        if (!bucket) return 1;
        const direct = Number(peopleBreakdown[bucket]);
        if (Number.isFinite(direct) && direct > 0) return direct;
        for (const [salesKey, fanout] of Object.entries(_PROMOTE_PEOPLE_FANOUT)) {
          if (fanout.includes(bucket)) {
            const v = Number(peopleBreakdown[salesKey]);
            if (Number.isFinite(v) && v > 0) return v;
          }
        }
        return 1;
      };

      await pool.query('INSERT INTO projects (name, workspace) VALUES (?, ?) ON DUPLICATE KEY UPDATE workspace = workspace', [newName, 'Active']);

      const idMap = new Map();
      const insertCols = ['name','project','phase','phase_group','department','sub_department','assignee','start_date','end_date','duration_days','predecessors','is_milestone','progress','allocation','priority','notes','sort_order','anchor_key','baseline_start_date','baseline_end_date','duration_link_task_id','is_action','completed_on','machine'];

      for (const t of templateTasks) {
        const [r] = await pool.query(
          `INSERT INTO tasks (${insertCols.join(',')}) VALUES (${insertCols.map(() => '?').join(',')})`,
          [t.name, newName, t.phase, t.phase_group, t.department, t.sub_department,
           t.assignee, t.start_date, t.end_date, t.duration_days, null,
           t.is_milestone ? 1 : 0, 0, t.allocation, t.priority, t.notes, t.sort_order,
           t.anchor_key, null, null, null, t.is_action ? 1 : 0, null, 'M1']
        );
        idMap.set(t.id, r.insertId);
      }

      for (const t of templateTasks) {
        const newId = idMap.get(t.id);
        if (!newId || !t.predecessors) continue;
        const remapped = String(t.predecessors).split(',').map(s => s.trim()).filter(Boolean).map(tok => {
          const m = tok.match(/^(\d+)(.*)$/);
          if (!m) return tok;
          const oldRef = Number(m[1]);
          const newRef = idMap.get(oldRef);
          return newRef ? `${newRef}${m[2]}` : null;
        }).filter(Boolean).join(',');
        if (remapped) await pool.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [remapped, newId]);
      }

      const [newTasks] = await pool.query(
        'SELECT * FROM tasks WHERE project = ? AND (is_milestone IS NULL OR is_milestone = 0) AND anchor_key IS NULL ORDER BY sort_order, id',
        [newName]
      );
      const tasksByBucket = {};
      for (const t of newTasks) {
        const b = _serverTaskBucket(t);
        if (!b) continue;
        (tasksByBucket[b] ||= []).push(t);
      }
      const snapHalfWeek = (days) => Math.max(0, Math.round(Number(days) / 2.5) * 2.5);
      for (const [bucket, tasks] of Object.entries(tasksByBucket)) {
        const hours  = bucketHours[bucket] || 0;
        const people = effectivePeople(bucket);
        const baseAlloc = _promoteDefaultAlloc(bucket);
        const fullSlots = Math.floor(people);
        const fracSlot  = Math.round((people - fullSlots) * 100);
        let dailyHourCapacity = 0;
        const slotAllocs = tasks.map((_, idx) => {
          if (idx < fullSlots)            return baseAlloc;
          if (idx === fullSlots && fracSlot > 0) return fracSlot;
          return baseAlloc;
        });
        for (const a of slotAllocs) dailyHourCapacity += 8 * (a / 100);
        const newDays = (hours > 0 && dailyHourCapacity > 0)
          ? snapHalfWeek(hours / dailyHourCapacity)
          : null;
        for (let idx = 0; idx < tasks.length; idx++) {
          const alloc = slotAllocs[idx];
          const dur   = newDays != null ? newDays : tasks[idx].duration_days;
          await pool.query('UPDATE tasks SET duration_days = ?, allocation = ? WHERE id = ?', [dur, alloc, tasks[idx].id]);
        }
      }

      if (quote) {
        const newQuoteKey = `project_quote:${newName}`;
        await pool.query(
          'INSERT INTO settings (`key`, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
          [newQuoteKey, JSON.stringify(quote)]
        );
      }

      await cascadeSchedule();

      res.json({ project: newName });
      io.emit('tasks:updated', { project: newName });
      notifyClients('tasks');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
