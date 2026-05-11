const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Disable caching for static assets so dev edits show up on plain refresh
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));

const FIELDS = ['name', 'project', 'phase', 'phase_group', 'department', 'sub_department', 'assignee', 'start_date', 'end_date', 'duration_days', 'predecessors', 'is_milestone', 'progress', 'allocation', 'priority', 'notes', 'sort_order', 'anchor_key', 'baseline_start_date', 'baseline_end_date'];

// ---------- Schedule auto-computation (FS/SS/FF/SF + lag) ----------
// All scheduling is done in BUSINESS DAYS (Mon–Fri). Weekends are skipped: a task
// scheduled to start "the day after" a Friday-ending pred lands on Monday. Lag is
// expressed in business days too — "+3d" = 3 working days, "+1w" = 5 working days.
function parsePredecessorRef(s) {
  // Accepts "5", "5FS", "5FS +1w", "5FF -2w", "5SS +3d", etc.
  const m = String(s || '').trim().match(/^(\d+)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+)?\s*([wd])?$/i);
  if (!m) return null;
  const id = Number(m[1]);
  const type = (m[2] || 'FS').toUpperCase();
  let lagDays = 0;
  if (m[3]) {
    const n = Number(m[3].replace(/\s+/g, ''));
    // 'w' = work-week (5 business days). 'd' = single business day.
    lagDays = (m[4] || 'd').toLowerCase() === 'w' ? n * 5 : n;
  }
  return { id, type, lagDays };
}

function isWeekend(d) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

// Add n business days to a date string. Skips Sat/Sun. n=0 returns the same date
// untouched (caller is responsible for ensuring inputs are business days when needed).
function addBusinessDaysISO(dateStr, n) {
  if (!dateStr) return null;
  if (n === 0) return dateStr;
  const d = new Date(dateStr + 'T00:00:00Z');
  let remaining = Math.abs(n);
  const dir = n >= 0 ? 1 : -1;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + dir);
    if (!isWeekend(d)) remaining--;
  }
  return d.toISOString().slice(0, 10);
}

// Inclusive business-day count between two ISO dates. Returns 0 if either is missing
// or end is before start.
function businessDaysSpanInclusive(start, end) {
  if (!start || !end) return 0;
  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  if (e < s) return 0;
  let count = 0;
  const cur = new Date(s);
  while (cur <= e) {
    if (!isWeekend(cur)) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

function computeDatesFromPreds(task, tasksById) {
  if (!task.predecessors) return null;
  const preds = String(task.predecessors).split(',').map(s => parsePredecessorRef(s.trim())).filter(Boolean);
  if (preds.length === 0) return null;

  let start = null, end = null;
  for (const p of preds) {
    const pred = tasksById[p.id];
    if (!pred || !pred.start_date || !pred.end_date) continue;
    let cStart = null, cEnd = null;
    switch (p.type) {
      // FS lag=0 → succ starts the next business day after pred ends.
      case 'FS': cStart = addBusinessDaysISO(pred.end_date,   1 + p.lagDays); break;
      case 'SS': cStart = addBusinessDaysISO(pred.start_date, p.lagDays);     break;
      case 'FF': cEnd   = addBusinessDaysISO(pred.end_date,   p.lagDays);     break;
      case 'SF': cEnd   = addBusinessDaysISO(pred.start_date, p.lagDays);     break;
    }
    // Each predecessor constrains; take the LATEST constraint (most-restrictive).
    if (cStart && (!start || cStart > start)) start = cStart;
    if (cEnd   && (!end   || cEnd   > end))   end   = cEnd;
  }

  // task.duration_days is the source of truth for working duration. Cascade NEVER
  // changes it — only start_date / end_date shift to honor predecessor constraints.
  // Falls back to a span-derived count for legacy rows that haven't been backfilled.
  const dur = task.is_milestone ? 1 : Math.max(1,
    task.duration_days != null
      ? Number(task.duration_days)
      : (businessDaysSpanInclusive(task.start_date, task.end_date) || 1)
  );
  if (start && !end) end   = task.is_milestone ? start : addBusinessDaysISO(start, dur - 1);
  if (end   && !start) start = task.is_milestone ? end   : addBusinessDaysISO(end,   -(dur - 1));
  if (start && end) return { start_date: start, end_date: end };
  return null;
}

function cascadeSchedule() {
  // Iteratively recompute every task's dates from its predecessors until stable
  // (or hit iteration cap to break any accidental cycles).
  for (let iter = 0; iter < 50; iter++) {
    const all = db.prepare('SELECT * FROM tasks').all();
    const byId = Object.fromEntries(all.map(t => [t.id, t]));
    let changed = false;
    for (const t of all) {
      if (!t.predecessors) continue;
      const next = computeDatesFromPreds(t, byId);
      if (next && (next.start_date !== t.start_date || next.end_date !== t.end_date)) {
        db.prepare('UPDATE tasks SET start_date = ?, end_date = ? WHERE id = ?')
          .run(next.start_date, next.end_date, t.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

app.get('/api/tasks', (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY sort_order, id').all();
  res.json(tasks);
});

app.post('/api/tasks', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks').get().m;
  // If a priority isn't supplied, auto-assign the next slot for this assignee so newly
  // created tasks fall to the bottom of that person's stack until reranked. Tasks with
  // no assignee just get priority 1 (it's irrelevant until they're assigned anyway).
  let nextPriority = 1;
  if (req.body.priority != null) {
    nextPriority = Math.max(1, Number(req.body.priority) || 1);
  } else if (req.body.assignee) {
    const peek = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM tasks WHERE assignee = ?').get(req.body.assignee);
    nextPriority = (peek?.m || 0) + 1;
  }
  const cols = ['name', 'project', 'phase', 'phase_group', 'department', 'sub_department', 'assignee', 'start_date', 'end_date', 'duration_days', 'predecessors', 'is_milestone', 'progress', 'allocation', 'priority', 'notes', 'sort_order', 'anchor_key'];
  const values = [
    name,
    req.body.project || null,
    req.body.phase || null,
    req.body.phase_group || null,
    req.body.department || null,
    req.body.sub_department || null,
    req.body.assignee || null,
    req.body.start_date || null,
    req.body.end_date || null,
    req.body.duration_days ?? null,
    req.body.predecessors || null,
    req.body.is_milestone ? 1 : 0,
    req.body.progress || 0,
    req.body.allocation == null ? 90 : Math.max(0, Math.min(100, Number(req.body.allocation) || 0)),
    nextPriority,
    req.body.notes || null,
    maxOrder + 1,
    req.body.anchor_key || null,
  ];
  const placeholders = cols.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders})`);
  const result = stmt.run(...values);
  cascadeSchedule();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const updates = {};
  for (const f of FIELDS) {
    if (f in req.body) {
      if (f === 'is_milestone') updates[f] = req.body[f] ? 1 : 0;
      else updates[f] = req.body[f] === '' ? null : req.body[f];
    }
  }
  if (Object.keys(updates).length === 0) return res.json(existing);

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  db.prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...values, id);

  // Priority is PER-ASSIGNEE (each person has their own 1, 2, 3 … list). Two cases
  // to keep that invariant:
  //
  //   (a) Reassigning a task to a new person without an explicit priority change —
  //       e.g. clicking "Assign to Ian Milne" in the placeholder reassign popup.
  //       The task's prior priority was meaningful for the PLACEHOLDER's list and
  //       has no meaning under Ian's. Pick the next unused slot for Ian instead of
  //       parking the new task at priority 1 and bumping Ian's existing top task.
  //
  //   (b) Setting an explicit priority that already exists on the same assignee —
  //       displaced task(s) get pushed to the smallest unused priority slot.
  const finalAssignee = ('assignee' in updates) ? updates.assignee : existing.assignee;
  const assigneeChanged = 'assignee' in updates && updates.assignee !== existing.assignee;
  const priorityExplicit = 'priority' in updates;

  let finalPriority = ('priority' in updates) ? updates.priority : existing.priority;
  if (assigneeChanged && !priorityExplicit && finalAssignee) {
    // (a) Auto-pick next available priority for the new assignee.
    const peek = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM tasks WHERE assignee = ?').get(finalAssignee);
    finalPriority = (peek?.m || 0) + 1;
    db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(finalPriority, id);
  }

  // (b) Conflict resolution — only meaningful when the user explicitly set the priority.
  if (priorityExplicit && finalAssignee && finalPriority != null) {
    const conflicts = db.prepare(
      'SELECT id FROM tasks WHERE assignee = ? AND priority = ? AND id != ?'
    ).all(finalAssignee, finalPriority, id);
    if (conflicts.length > 0) {
      const used = new Set(
        db.prepare('SELECT priority FROM tasks WHERE assignee = ? AND priority IS NOT NULL')
          .all(finalAssignee)
          .map(r => r.priority)
      );
      const bumpStmt = db.prepare('UPDATE tasks SET priority = ? WHERE id = ?');
      for (const c of conflicts) {
        let next = 1;
        while (used.has(next)) next++;
        used.add(next);
        bumpStmt.run(next, c.id);
      }
    }
  }

  cascadeSchedule();

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.json(updated);
});

app.delete('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  // Anchor milestones (Receipt of PO, Machine Power-Up, FAT, Ship Machine) are
  // project-spine markers and can't be removed — only edited. Reject with a clear
  // message so the client can show it.
  const t = db.prepare('SELECT anchor_key FROM tasks WHERE id = ?').get(id);
  if (t && t.anchor_key) {
    return res.status(400).json({ error: 'Anchor milestones cannot be deleted.' });
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  cascadeSchedule();
  res.json({ ok: true });
});

app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  res.json(out);
});

app.put('/api/settings/:key', (req, res) => {
  const key = req.params.key;
  const value = JSON.stringify(req.body);
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
  res.json({ ok: true });
});

// ---------- Team members ----------
const TEAM_DISCIPLINES = new Set(['mech', 'controls', 'build', 'wire']);

app.get('/api/team', (req, res) => {
  const rows = db.prepare('SELECT * FROM team_members ORDER BY discipline, sort_order, name').all();
  res.json(rows);
});

app.post('/api/team', (req, res) => {
  const name = (req.body.name || '').trim();
  const discipline = req.body.discipline;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!TEAM_DISCIPLINES.has(discipline)) return res.status(400).json({ error: 'invalid discipline' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM team_members WHERE discipline = ?').get(discipline).m;
  const result = db.prepare('INSERT INTO team_members (name, discipline, sort_order) VALUES (?, ?, ?)').run(name, discipline, maxOrder + 1);
  const row = db.prepare('SELECT * FROM team_members WHERE id = ?').get(result.lastInsertRowid);
  res.json(row);
});

app.put('/api/team/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM team_members WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const allowed = ['name', 'discipline', 'active', 'sort_order'];
  const updates = {};
  for (const f of allowed) {
    if (f in req.body) {
      if (f === 'discipline' && !TEAM_DISCIPLINES.has(req.body[f])) return res.status(400).json({ error: 'invalid discipline' });
      if (f === 'active') updates[f] = req.body[f] ? 1 : 0;
      else if (f === 'name') updates[f] = (req.body[f] || '').trim();
      else updates[f] = req.body[f];
    }
  }
  if (Object.keys(updates).length === 0) return res.json(existing);
  // If name changed, propagate to existing tasks so the existing assignee strings stay consistent.
  if (updates.name && updates.name !== existing.name) {
    db.prepare('UPDATE tasks SET assignee = ? WHERE assignee = ?').run(updates.name, existing.name);
  }
  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE team_members SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
  const updated = db.prepare('SELECT * FROM team_members WHERE id = ?').get(id);
  res.json(updated);
});

app.delete('/api/team/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM team_members WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/team/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array of ids' });
  const stmt = db.prepare('UPDATE team_members SET sort_order = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    order.forEach((id, idx) => stmt.run(idx, id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
});

app.post('/api/tasks/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array of ids' });

  const stmt = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    order.forEach((id, idx) => stmt.run(idx, id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
});

// ---------- Baseline snapshot ----------
// "Setting a baseline" copies every task's current start_date + end_date into
// baseline_start_date + baseline_end_date for that project. Clearing wipes them
// back to null. The client overlays a dashed ghost at the baseline position on
// the Gantt and shows a drift chip so the user can see how much each bar has
// moved relative to the snapshot.

app.post('/api/baseline/set', (req, res) => {
  const project = (req.body.project || '').toString().trim();
  if (!project) return res.status(400).json({ error: 'project required' });
  const result = db.prepare(`
    UPDATE tasks SET
      baseline_start_date = start_date,
      baseline_end_date   = end_date
    WHERE project = ?
  `).run(project);
  res.json({ ok: true, baselined: result.changes });
});

app.post('/api/baseline/clear', (req, res) => {
  const project = (req.body.project || '').toString().trim();
  if (!project) return res.status(400).json({ error: 'project required' });
  const result = db.prepare(`
    UPDATE tasks SET
      baseline_start_date = NULL,
      baseline_end_date   = NULL
    WHERE project = ?
  `).run(project);
  res.json({ ok: true, cleared: result.changes });
});

// ---------- Project financial milestones ----------
// Independent from tasks. Each row belongs to a single project and represents a
// payment event (Down Payment, FAT acceptance, etc.). The client overlays these on
// the Gantt when the $ Financial toggle is on; they don't live in the task grid.
const FIN_FIELDS = ['name', 'percent', 'amount', 'due_date', 'paid', 'predecessors', 'sync_to_anchor', 'sort_order'];

app.get('/api/financials', (req, res) => {
  const project = (req.query.project || '').toString();
  const rows = project
    ? db.prepare('SELECT * FROM project_financials WHERE project = ? ORDER BY sort_order, id').all(project)
    : db.prepare('SELECT * FROM project_financials ORDER BY project, sort_order, id').all();
  res.json(rows);
});

app.post('/api/financials', (req, res) => {
  const project = (req.body.project || '').toString().trim();
  if (!project) return res.status(400).json({ error: 'project required' });
  const name = (req.body.name || '').toString().trim();
  // Name can be empty — the modal creates blank rows for inline editing.
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_financials WHERE project = ?').get(project).m;
  const result = db.prepare(`
    INSERT INTO project_financials (project, name, percent, amount, due_date, paid, predecessors, sync_to_anchor, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project,
    name,
    req.body.percent != null ? Number(req.body.percent) : null,
    req.body.amount  != null ? Number(req.body.amount)  : null,
    req.body.due_date || null,
    req.body.paid ? 1 : 0,
    req.body.predecessors || null,
    req.body.sync_to_anchor || null,
    maxOrder + 1,
  );
  const row = db.prepare('SELECT * FROM project_financials WHERE id = ?').get(result.lastInsertRowid);
  res.json(row);
});

app.put('/api/financials/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM project_financials WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const updates = {};
  for (const f of FIN_FIELDS) {
    if (f in req.body) {
      if (f === 'paid') updates[f] = req.body[f] ? 1 : 0;
      else if (f === 'percent' || f === 'amount') updates[f] = req.body[f] == null ? null : Number(req.body[f]);
      else if (f === 'name') updates[f] = (req.body[f] || '').toString().trim();
      else updates[f] = req.body[f] || null;
    }
  }
  if (Object.keys(updates).length === 0) return res.json(existing);
  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE project_financials SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
  const row = db.prepare('SELECT * FROM project_financials WHERE id = ?').get(id);
  res.json(row);
});

app.delete('/api/financials/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM project_financials WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Seed the default financial milestones onto a project that has none yet. Idempotent:
// running this on a project that already has any financials is a no-op. Reads the
// defaults from the default_financial_milestones setting (editable on Setup).
app.post('/api/financials/seed', (req, res) => {
  const project = (req.body.project || '').toString().trim();
  if (!project) return res.status(400).json({ error: 'project required' });
  const existing = db.prepare('SELECT COUNT(*) AS n FROM project_financials WHERE project = ?').get(project).n;
  if (existing > 0) return res.json({ ok: true, seeded: 0 });
  const row = db.prepare("SELECT value FROM settings WHERE key = 'default_financial_milestones'").get();
  let defaults = [];
  try { defaults = JSON.parse(row?.value || '[]'); } catch { defaults = []; }
  const insert = db.prepare(`
    INSERT INTO project_financials (project, name, percent, amount, due_date, paid, predecessors, sync_to_anchor, sort_order)
    VALUES (?, ?, ?, NULL, NULL, 0, ?, ?, ?)
  `);
  defaults.forEach((d, i) => {
    insert.run(
      project,
      d.name,
      d.percent != null ? Number(d.percent) : null,
      d.predecessors || null,
      d.sync_to_anchor || null,
      i,
    );
  });
  res.json({ ok: true, seeded: defaults.length });
});

app.listen(PORT, () => {
  console.log(`SDC Scheduler running at http://localhost:${PORT}`);
});
