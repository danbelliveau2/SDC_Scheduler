const express = require('express');
const path = require('path');
const XLSX = require('xlsx');
const compression = require('compression');
const db = require('./db');
const azureSync = require('./azureSync');

// Fire-and-forget Azure sync after writes — never blocks the HTTP response.
function sync(...tables) {
  for (const t of tables) azureSync.syncTable(t);
}

const app = express();
const PORT = process.env.PORT || 3000;

// ── Gzip all responses (cuts JSON payload ~70%) ────────────────────────────
app.use(compression());

app.use(express.json({ limit: '10mb' }));

// Static assets: versioned files get long cache; HTML stays no-store so reloads
// always pick up the latest app.js / styles.css without a hard-refresh.
app.use((req, res, next) => {
  if (req.path.match(/\.(js|css|svg|png|jpg|ico|woff2?)(\?|$)/)) {
    res.set('Cache-Control', 'public, max-age=3600'); // 1 hour for assets
  } else {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true }));

const FIELDS = ['name', 'project', 'phase', 'phase_group', 'department', 'sub_department', 'assignee', 'start_date', 'end_date', 'duration_days', 'predecessors', 'is_milestone', 'progress', 'allocation', 'priority', 'notes', 'sort_order', 'anchor_key', 'baseline_start_date', 'baseline_end_date', 'duration_link_task_id', 'is_action', 'completed_on', 'machine'];

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

// v4.37: duration linking. When a task carries duration_link_task_id, its
// duration_days mirrors the source task's. v4.38 fix: also recompute the
// dependent's END_DATE from its current start_date + new duration_days,
// otherwise the dependent's bar on the Gantt stayed at the old length even
// though duration_days had updated. Chained links (A → B → C) resolve over
// multiple iterations until stable.
function cascadeDurationLinks() {
  for (let iter = 0; iter < 20; iter++) {
    const linked = db.prepare(
      'SELECT id, duration_days, duration_link_task_id, start_date, end_date FROM tasks WHERE duration_link_task_id IS NOT NULL'
    ).all();
    let changed = false;
    const upd = db.prepare(
      'UPDATE tasks SET duration_days = ?, end_date = ?, is_milestone = ? WHERE id = ?'
    );
    for (const dep of linked) {
      const src = db.prepare('SELECT duration_days FROM tasks WHERE id = ?').get(dep.duration_link_task_id);
      // If the source row was deleted, drop the link silently and leave
      // duration_days alone. Self-link is also a no-op.
      if (!src || dep.duration_link_task_id === dep.id) continue;
      const newDur = Number(src.duration_days) || 0;
      if (newDur === dep.duration_days) continue;
      const newMilestone = newDur === 0 ? 1 : 0;
      let newEnd = dep.end_date;
      if (newDur === 0) {
        newEnd = dep.start_date;
      } else if (dep.start_date) {
        // N business days INCLUSIVE → end = start + (N - 1) business days.
        newEnd = addBusinessDaysISO(dep.start_date, newDur - 1);
      }
      upd.run(newDur, newEnd, newMilestone, dep.id);
      changed = true;
    }
    if (!changed) break;
  }
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

// Rewrite priorities for one assignee so they form a dense 1, 2, 3 ... sequence
// in their current sort order. Each person owns their own per-list — no overlap
// across people, no gaps from deleted/reassigned tasks. Called from every route
// that can mutate a task's assignee or remove a task. Skips empty assignees.
function compactPrioritiesForAssignee(assignee) {
  if (!assignee) return;
  const rows = db.prepare(
    'SELECT id, priority FROM tasks WHERE assignee = ? ORDER BY priority IS NULL, priority ASC, id ASC'
  ).all(assignee);
  const upd = db.prepare('UPDATE tasks SET priority = ? WHERE id = ?');
  rows.forEach((r, i) => {
    const target = i + 1;
    if (r.priority !== target) upd.run(target, r.id);
  });
}

app.get('/api/tasks', (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY sort_order, id').all();
  res.json(tasks);
});

app.post('/api/tasks', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks').get().m;
  // If the client passed a specific sort_order, use it verbatim (no rounding).
  // The sort_order column is declared INTEGER but SQLite's type affinity is
  // flexible — REAL values are stored as-is, so callers like "Add additional
  // resource" can pass fractional values (e.g. 18.5) to slot the new row
  // BETWEEN two existing integer-sort_order tasks without having to shift
  // every downstream row. Sequential adds keep halving the gap (18.5, 18.25,
  // 18.125 …) — 52 bits of double-precision mantissa gives plenty of headroom
  // for realistic per-task insertion counts.
  // Append-style callers (no sort_order) still default to MAX + 1.
  let insertSortOrder;
  if (req.body.sort_order != null) {
    insertSortOrder = Number(req.body.sort_order);
  } else {
    insertSortOrder = maxOrder + 1;
  }
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
  // v4.46: include is_action in the INSERT columns so + Add action can
  // flag a row as an action item at creation time. Defaults to 0 (regular
  // scheduled task) for everything else.
  const cols = ['name', 'project', 'phase', 'phase_group', 'department', 'sub_department', 'assignee', 'start_date', 'end_date', 'duration_days', 'predecessors', 'is_milestone', 'progress', 'allocation', 'priority', 'notes', 'sort_order', 'anchor_key', 'is_action', 'machine'];
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
    insertSortOrder,
    req.body.anchor_key || null,
    req.body.is_action ? 1 : 0,
    req.body.machine || null,
  ];
  const placeholders = cols.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders})`);
  const result = stmt.run(...values);
  // Compact the new assignee's priority list so the new task lands at the next
  // dense slot — eliminates the "+1 of MAX" gap problem where a person with two
  // tasks could end up with priorities like (1, 13) because of historical deletes.
  if (req.body.assignee) compactPrioritiesForAssignee(req.body.assignee);
  cascadeSchedule();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.json(task);
  sync('tasks');
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
  // v4.62: auto-stamp completed_on when progress transitions to 100, and
  // clear it when progress drops back below 100. Skipped when the caller
  // explicitly sends completed_on in the same request (manual edit wins).
  if ('progress' in updates && !('completed_on' in updates)) {
    const newProgress = Number(updates.progress) || 0;
    const oldProgress = Number(existing.progress) || 0;
    if (newProgress >= 100 && oldProgress < 100) {
      // Just completed → stamp today's date in YYYY-MM-DD.
      updates.completed_on = new Date().toISOString().slice(0, 10);
    } else if (newProgress < 100 && oldProgress >= 100) {
      // Re-opened → clear the completed date.
      updates.completed_on = null;
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

  // Compact priority lists for everyone affected by this update — both the new
  // assignee (in case insertion left gaps) and, when the assignee changed, the
  // OLD assignee (so removing a slot from their list collapses the rest down).
  if (finalAssignee) compactPrioritiesForAssignee(finalAssignee);
  if (assigneeChanged && existing.assignee && existing.assignee !== finalAssignee) {
    compactPrioritiesForAssignee(existing.assignee);
  }

  // v4.37: propagate duration changes to linked dependents BEFORE the
  // schedule cascade runs. cascadeSchedule recomputes start/end based on
  // the (now-updated) duration_days, so the dependent's end_date shifts
  // automatically without a separate code path.
  if ('duration_days' in updates) cascadeDurationLinks();

  cascadeSchedule();

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.json(updated);
  sync('tasks');
});

app.delete('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  // Real anchor milestones (Receipt of PO, Machine Power-Up, FAT, Mech 1
  // Release, Ship Machine) are project-spine markers and can't be removed
  // — only edited. Backlog (anchor_key='backlog') is allowed to delete
  // since it's a regular duration row, not a spine milestone.
  const t = db.prepare('SELECT anchor_key, assignee FROM tasks WHERE id = ?').get(id);
  if (t && t.anchor_key && t.anchor_key !== 'backlog') {
    return res.status(400).json({ error: 'Anchor milestones cannot be deleted.' });
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  // Collapse the freed slot in the previous owner's per-person priority list so
  // the next task they get doesn't jump over it.
  if (t && t.assignee) compactPrioritiesForAssignee(t.assignee);
  cascadeSchedule();
  res.json({ ok: true });
  sync('tasks');
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
  sync('settings');
});

// ---------- Team members ----------
const TEAM_DISCIPLINES = new Set(['mech', 'controls', 'pm', 'build', 'wire']);

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
  sync('team_members');
});

app.put('/api/team/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM team_members WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const allowed = ['name', 'discipline', 'active', 'sort_order', 'is_lead', 'specialty'];
  const updates = {};
  for (const f of allowed) {
    if (f in req.body) {
      if (f === 'discipline' && !TEAM_DISCIPLINES.has(req.body[f])) return res.status(400).json({ error: 'invalid discipline' });
      if (f === 'active' || f === 'is_lead') updates[f] = req.body[f] ? 1 : 0;
      else if (f === 'name') updates[f] = (req.body[f] || '').trim();
      else if (f === 'specialty') updates[f] = (req.body[f] || '').trim() || null;
      else updates[f] = req.body[f];
    }
  }
  if (Object.keys(updates).length === 0) return res.json(existing);
  // If name changed, propagate to existing tasks so the existing assignee strings stay consistent.
  if (updates.name && updates.name !== existing.name) {
    db.prepare('UPDATE tasks SET assignee = ? WHERE assignee = ?').run(updates.name, existing.name);
    sync('tasks');
  }
  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE team_members SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
  const updated = db.prepare('SELECT * FROM team_members WHERE id = ?').get(id);
  res.json(updated);
  sync('team_members');
});

app.delete('/api/team/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM team_members WHERE id = ?').run(id);
  res.json({ ok: true });
  sync('team_members');
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

// ---------- Smartsheet (Excel) import ----------
// Takes a base64-encoded .xlsx exported from Smartsheet, parses it, and creates
// a new project with all the tasks mapped to our hierarchy. Phase header rows
// in Smartsheet (e.g. "ME Development Phase") set the section context for the
// tasks that follow. Anchor names (Receipt of PO, FAT, etc.) trigger the
// anchor_key flag. Predecessors are remapped from Smartsheet row numbers to
// the newly inserted task IDs. New assignees not on the team list are auto-
// added under the discipline inferred from their parent phase.

// Smartsheet phase header → SDC hierarchy mapping. The `discipline` field is
// used to auto-assign disciplines for new team members imported from that
// section.
const SMARTSHEET_PHASES = {
  'me development phase':   { phase_group: 'design_build',    department: 'engineering', sub_department: 'mech',     discipline: 'mech' },
  'machine control phase':  { phase_group: 'design_build',    department: 'engineering', sub_department: 'controls', discipline: 'controls' },
  'procurement phase':      { phase_group: 'design_build',    department: 'procurement', sub_department: null,       discipline: null },
  'mechanical build phase': { phase_group: 'design_build',    department: 'shop',        sub_department: 'build',    discipline: 'build' },
  'electrical build phase': { phase_group: 'design_build',    department: 'shop',        sub_department: 'wire',     discipline: 'wire' },
  'testing at sdc phase':   { phase_group: 'machine_testing', department: 'engineering', sub_department: null,       discipline: 'controls' },
};
// Anchor name → key. Anchor tasks are placed at their canonical spine
// positions on creation (not at the parent phase's location).
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
// Rows we skip outright — Smartsheet rollup groupings, dashboard / metadata
// rows, and the "Flagged Tasks" / "Internal Deadlines" section which carries
// early-warning reminders pointing at the actual release anchors.
const SMARTSHEET_SKIP_PATTERNS = [
  /to completion$/i,
  /design to fat$/i,
  /^kick-?off phase$/i,
  /^project start date$/i,
  // Smartsheet template metadata rows (live above the real tasks).
  /^flagged tasks?$/i,
  /^internal deadlines$/i,
  /^machine concepting$/i,
  /^project (links|planner|information log|management|name)$/i,
  /^communication plan$/i,
  /^dashboard$/i,
  /^bom$/i,
  /^task health$/i,
  /^variance\d*$/i,
  // Flagged-tasks early-ready reminders. These point at the actual Mech/Controls
  // release anchors via predecessors; the anchors themselves come in via the
  // SMARTSHEET_ANCHORS map, so these duplicates would just clutter the schedule.
  /^mech [12]$/i,
  /^controls [12]$/i,
  /^ready for /i,
  /^controls release \([0-9]+ weeks? out\)$/i,
];
// Name-based phase overrides. Smartsheet's template puts teardown / install /
// wrap-up tasks AFTER "Testing At SDC Phase" without their own header, so the
// phase-context inheritance would dump them into machine_testing. Catch them by
// name and route to the teardown_install section instead.
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
  // Smartsheet allows fractional weeks (e.g. 1.5w → 7.5 → round to 8 business days).
  return unit === 'w' ? Math.round(n * 5) : Math.round(n);
}

function parseSmartsheetDate(val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const str = String(val).trim();
  // MM/DD/YY or MM/DD/YYYY
  const slash = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slash) {
    const mo = parseInt(slash[1], 10);
    const da = parseInt(slash[2], 10);
    let yr = parseInt(slash[3], 10);
    if (yr < 100) yr += 2000;
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    return `${yr}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  }
  // ISO already
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  return null;
}

app.post('/api/import/smartsheet', (req, res) => {
  try {
    const projectName = (req.body.project || '').toString().trim();
    const file = req.body.file;
    if (!projectName) return res.status(400).json({ error: 'project name required' });
    if (!file)        return res.status(400).json({ error: 'file (base64) required' });

    const existing = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project = ?").get(projectName);
    if (existing.n > 0) {
      return res.status(400).json({ error: `Project "${projectName}" already exists. Pick a different name or merge in.` });
    }

    const buf = Buffer.from(file, 'base64');
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    if (!wb.SheetNames.length) return res.status(400).json({ error: 'workbook has no sheets' });

    // Walk sheets in order; pick the first one whose header row contains "Task Name".
    let rows = null;
    for (const sheetName of wb.SheetNames) {
      const candidate = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: false });
      if (candidate.some(r => Array.isArray(r) && r.some(c => /^task name$/i.test(String(c || '').trim())))) {
        rows = candidate;
        break;
      }
    }
    if (!rows) return res.status(400).json({ error: 'no sheet with a "Task Name" header column found' });

    // Locate the header row + column indices.
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

    // First pass — classify rows as PHASE headers (set context) or TASKS.
    // Also track which phase header each task lives under so we can remap any
    // predecessor that points at a phase header row (which we don't create a task
    // for) to a representative task inside that phase.
    const items = [];
    let ctx = null;             // current phase context (for routing tasks to sections)
    let currentPhaseRow = null; // src row # of the most recent phase header we hit
    const phaseTaskRows = {};   // phaseHeaderRow → [task row #s in order]
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;
      const rawName = r[COL.name];
      if (!rawName) continue;
      const name = String(rawName).trim();
      if (!name) continue;
      const lower = name.toLowerCase();

      // Skip Smartsheet's grouping rows (rollups).
      if (SMARTSHEET_SKIP_PATTERNS.some(re => re.test(lower))) continue;
      if (lower === projectName.toLowerCase()) continue;
      // Skip the source's own project rollup row (its name probably differs from
      // the destination project name the user picked).
      if (/^\d+_/.test(name) && !ctx) continue;
      // Skip rows that carry no schedule data — they're spreadsheet metadata
      // (Dashboard, BOM, Project Planner, etc.) not real tasks.
      const hasStart = r[COL.start] != null && r[COL.start] !== '';
      const hasEnd   = r[COL.end]   != null && r[COL.end]   !== '';
      const hasDur   = r[COL.duration] != null && r[COL.duration] !== '';
      if (!hasStart && !hasEnd && !hasDur) continue;

      // Phase header → switch context, don't create a task. Remember its row #
      // so subsequent tasks can register themselves under it for predecessor
      // remapping (Smartsheet's "27FF" / "27SS +11.8w" references point at the
      // phase header rollup, which we want to redirect to the right task).
      const phaseMatch = SMARTSHEET_PHASES[lower];
      if (phaseMatch) {
        ctx = phaseMatch;
        currentPhaseRow = i + 1;
        phaseTaskRows[currentPhaseRow] = [];
        continue;
      }

      // Anchor placement is dictated by anchor_key — overrides any phase context.
      const anchorKey = SMARTSHEET_ANCHORS[lower] || null;
      let phase_group = null, department = null, sub_department = null;
      // Name-based hints win over phase-context inheritance — Smartsheet's
      // teardown/install rows live under "Testing At SDC Phase" without their
      // own header and would otherwise inherit the wrong section.
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
      // % values come through as either "95%" strings (raw:false, the importer's
      // setting) or 0–1 floats (raw:true). Strip the percent sign before parsing
      // — Number("95%") returns NaN — and only multiply by 100 if the value is in
      // the 0–1 float range AFTER stripping (so "0%" stays 0, "100%" stays 100).
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
        row: taskRow, // Excel row (1-indexed)
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
      // Register this task under its phase header — but ONLY if it actually
      // belongs to that phase (no hint override, not an anchor). Otherwise
      // Smartsheet's "Testing At SDC Phase" would absorb the teardown / install /
      // wrap rows that live below it (no phase header of their own), and any
      // "61FF" predecessor would resolve to Conduct Project Wrap Meeting instead
      // of the end of testing.
      if (currentPhaseRow && !hint && !anchorKey) {
        phaseTaskRows[currentPhaseRow].push(taskRow);
      }
    }

    if (items.length === 0) return res.status(400).json({ error: 'no task rows found in sheet' });

    // Second pass — insert tasks (no predecessors yet; need IDs first).
    const insertStmt = db.prepare(`
      INSERT INTO tasks (name, project, phase_group, department, sub_department, assignee,
                         start_date, end_date, duration_days, is_milestone, progress, allocation,
                         priority, notes, sort_order, anchor_key,
                         baseline_start_date, baseline_end_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `);
    const sourceRowToId = {};
    const teamToAdd = new Map(); // name → discipline
    let order = 0;
    for (const t of items) {
      const result = insertStmt.run(
        t.name, projectName,
        t.phase_group, t.department, t.sub_department, t.assignee,
        t.start_date, t.end_date, t.duration_days, t.is_milestone,
        t.progress, t.allocation,
        t.notes, order++, t.anchor_key,
        t.baseline_start_date, t.baseline_end_date,
      );
      sourceRowToId[t.row] = result.lastInsertRowid;
      if (t.assignee && t._discipline_hint) {
        if (!teamToAdd.has(t.assignee)) teamToAdd.set(t.assignee, t._discipline_hint);
      }
    }

    // Third pass — remap predecessors from Excel row numbers to new task IDs.
    // Fractional lag (1.5w / 11.8w) is rounded to the nearest whole unit since
    // SDC scheduler works in whole business days.
    //
    // Phase-header fallback: Smartsheet's templates frequently point predecessors
    // at PHASE HEADER rollups ("27FF" → finish of ME Development Phase) rather
    // than specific tasks. We don't import phase headers as tasks, so without
    // this fallback every such predecessor gets silently dropped — leaving big
    // chunks of the schedule with no dependency wiring. Resolve it to a
    // representative task inside that phase:
    //   FS / SS predecessors → FIRST task in the phase (after-start semantics)
    //   FF / SF predecessors → LAST  task in the phase (after-finish semantics)
    const updPred = db.prepare('UPDATE tasks SET predecessors = ? WHERE id = ?');
    const phaseFirstId = {};  // phaseHeaderRow → first task ID
    const phaseLastId  = {};  // phaseHeaderRow → last  task ID
    const idToSrcRow   = {};  // taskId → original Excel row number
    for (const [phaseRow, taskRows] of Object.entries(phaseTaskRows)) {
      const ids = taskRows.map(r => sourceRowToId[r]).filter(Boolean);
      if (ids.length === 0) continue;
      phaseFirstId[phaseRow] = ids[0];
      phaseLastId[phaseRow]  = ids[ids.length - 1];
    }
    for (const [row, id] of Object.entries(sourceRowToId)) idToSrcRow[id] = Number(row);

    // resolveSrcRow turns a source Excel row reference into the actual new task
    // ID, with a phase-header fallback. ownRow + ownId are needed to drop two
    // classes of bogus output:
    //   1. Self-references (a task depending on itself).
    //   2. Forward references — phase fallback can land on a task that comes
    //      AFTER the current task (e.g. ME 2 ref'ing "ME Development Phase FF"
    //      which gets remapped to Mech 2 Release further down). Predecessors
    //      should always point BACKWARDS in the schedule.
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
        if (!m) continue; // skip malformed refs like "#REF"
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
      if (remapped) updPred.run(remapped, id);
    }

    // Auto-add new team members.
    const haveNames = new Set(
      db.prepare('SELECT name FROM team_members').all().map(r => r.name.toLowerCase())
    );
    const addMemberStmt = db.prepare(
      'INSERT INTO team_members (name, discipline) VALUES (?, ?)'
    );
    const addedMembers = [];
    for (const [name, discipline] of teamToAdd) {
      if (haveNames.has(name.toLowerCase())) continue;
      try { addMemberStmt.run(name, discipline); addedMembers.push({ name, discipline }); }
      catch (err) { /* ignore — name collision etc. */ }
    }

    // NB: deliberately do NOT call cascadeSchedule() here. The Smartsheet has its
    // dates already computed (and often manually nudged — Machine Power-Up's date
    // doesn't actually follow its declared predecessor, for example). Cascading
    // would overwrite those hand-tuned dates with FS-anchored math and ignore the
    // user's overrides. Trust the imported dates as-is; the user can run cascade
    // later by editing any predecessor field.

    res.json({
      ok: true,
      project: projectName,
      tasksCreated: items.length,
      addedMembers,
    });
    sync('tasks', 'team_members');
  } catch (err) {
    console.error('Smartsheet import failed:', err);
    res.status(500).json({ error: err.message || 'Import failed' });
  }
});

// ---------- Estimate-sheet → New project ----------
// SDC quotes each machine via an internal estimate xlsx. The "SUMMARY FOR RELEASE"
// tab carries the rolled-up engineering / build / wire hours per section
// (10 Design+Build / 40 Testing / 50 Teardown+Install). This endpoint parses
// those hours plus the customer/quote metadata from the "ESTIMATE SHEET" tab so
// the client can compute feasibility (headcount needed at the quoted lead time)
// before kicking off a new schedule. /api/estimate/create then clones
// SDC_Template tasks into the new project with PO + FAT anchors shifted to the
// quoted dates.

// Column letter → 0-based index for the SUMMARY FOR RELEASE grid. Section rows
// share this column layout — only the row varies (10/40/50).
const SUMMARY_COLS = {
  parts:       1,  // B — Parts Subtotal $
  mech_eng:    4,  // E — Mechanical Engineering (General)
  ce_design:   5,  // F — Controls Engineering Design + Drawings
  ce_software: 6,  // G — Software
  ce_database: 7,  // H — Database
  gen_hmi:     8,  // I — General Engineering HMI
  gen_robot:   9,  // J — Robot
  gen_vision:  10, // K — Vision
  gen_device:  11, // L — Device
  mech_build:  12, // M — Mechanical Build (Build)
  elec_build:  13, // N — Electrical Build (Wire)
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
  const section10 = extractHours(findSection('10-'));
  const section40 = extractHours(findSection('40-'));
  const section50 = extractHours(findSection('50-'));

  // Roll up to the five scheduling disciplines the team page tracks.
  const totals = {
    mech_eng:    section10.mech_eng + section40.mech_eng + section50.mech_eng,
    controls_eng: ['ce_design','ce_software','ce_database'].reduce((s, k) => s + section10[k] + section40[k] + section50[k], 0),
    general_eng: ['gen_hmi','gen_robot','gen_vision','gen_device'].reduce((s, k) => s + section10[k] + section40[k] + section50[k], 0),
    build:       section10.mech_build + section40.mech_build + section50.mech_build,
    wire:        section10.elec_build + section40.elec_build + section50.elec_build,
  };

  // Metadata from the ESTIMATE SHEET tab (top-left cells).
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

app.post('/api/estimate/parse', (req, res) => {
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

// Create a new project from SDC_Template + the parsed estimate hours.
// Task durations are computed from the estimate's hours-per-bucket so the
// generated schedule actually reflects the quoted work — not the template's
// arbitrary defaults. Allocation is set to the user's efficiency (default 90%)
// across every task so a person's effective output matches reality.
//
// Bucket classification (phase_group / department / sub_department → estimate row):
//   design_build / engineering / mech     → section_10 mech_eng
//   design_build / engineering / controls → section_10 controls_eng
//   design_build / engineering / general  → section_10 general_eng
//   design_build / shop        / build    → section_10 build
//   design_build / shop        / wire     → section_10 wire
//   machine_testing / *                   → section_40 (lead+secondary debug)
//   teardown_install / teardown / *       → section_50 teardown
//   teardown_install / install  / *       → section_50 install
function classifyTask(t) {
  const pg = t.phase_group, d = t.department, sd = t.sub_department;
  const name = (t.name || '').trim();
  // Fine-grained, name-based classification. Splits controls engineering and
  // general engineering into discrete sub-buckets so each template task
  // (Controls Design vs Controls Software vs HMI vs Robot vs Vision) gets the
  // estimate hours for that specific column, not an averaged lump.
  if (pg === 'design_build' && d === 'engineering' && sd === 'controls') {
    if (/^controls\s*software$/i.test(name)) return ['section_10', 'controls_software'];
    // Controls Design, Controls Drawings, and any orderable-parts companion
    // tasks share the "controls design + drawings" hour bucket.
    return ['section_10', 'controls_design'];
  }
  if (pg === 'design_build' && d === 'engineering' && sd === 'general') {
    if (/hmi/i.test(name))    return ['section_10', 'gen_hmi'];
    if (/robot/i.test(name))  return ['section_10', 'gen_robot'];
    if (/vision/i.test(name)) return ['section_10', 'gen_vision'];
    if (/device/i.test(name)) return ['section_10', 'gen_device'];
    return ['section_10', 'gen_hmi']; // fallback
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

// Fetch the persisted quote (estimate hours + headcount) for a project, set at
// /api/estimate/create time. Returns null when the project wasn't created from
// an estimate.
app.get('/api/project/:project/quote', (req, res) => {
  const key = `project_quote:${req.params.project}`;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return res.json(null);
  try { res.json(JSON.parse(row.value)); }
  catch { res.json(null); }
});

// Attach (or replace) the saved quote on an existing project. Lets a user pick
// the estimate xlsx in the Quote vs Schedule modal and persist it without
// re-creating the project.
app.post('/api/project/:project/quote', (req, res) => {
  const key = `project_quote:${req.params.project}`;
  const value = JSON.stringify(req.body || {});
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
  res.json({ ok: true });
});
app.delete('/api/project/:project/quote', (req, res) => {
  db.prepare('DELETE FROM settings WHERE key = ?').run(`project_quote:${req.params.project}`);
  res.json({ ok: true });
});

app.post('/api/estimate/create', (req, res) => {
  try {
    const projectName = (req.body.project || '').toString().trim();
    const poDate      = (req.body.po_date || '').toString().trim();
    const fatDate     = (req.body.fat_date || '').toString().trim();
    const efficiency  = Math.max(0.1, Math.min(1, Number(req.body.efficiency) || 0.9));
    const headcount   = req.body.headcount || {};
    const hps         = req.body.hours_per_section || null;
    // Backlog = waiting period between Receipt of PO and the start of
    // engineering (kickoff paperwork, ramp-up). Default 2 business weeks.
    const backlogRaw = Number(req.body.backlog_weeks);
    const backlogWeeks = Number.isFinite(backlogRaw) ? Math.max(0, Math.min(20, backlogRaw)) : 2;
    const backlogDays  = Math.round(backlogWeeks * 5);
    // Optional per-task hour breakdown (Controls Design vs Drawings split,
    // Wire Panel vs Machine split). If present, individual tasks get their
    // user-edited hours; otherwise we use defaults (50/50 design+drawings,
    // 25/75 panel+machine).
    const hbd         = req.body.hours_breakdown || null;
    if (!projectName) return res.status(400).json({ error: 'project name required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(poDate))  return res.status(400).json({ error: 'po_date must be YYYY-MM-DD' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fatDate)) return res.status(400).json({ error: 'fat_date must be YYYY-MM-DD' });

    const existing = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project = ?").get(projectName);
    if (existing.n > 0) {
      return res.status(400).json({ error: `Project "${projectName}" already exists. Pick a different name.` });
    }

    const TEMPLATE = 'SDC_Template';
    const tplTasksRaw = db.prepare('SELECT * FROM tasks WHERE project = ? ORDER BY sort_order, id').all(TEMPLATE);
    if (tplTasksRaw.length === 0) {
      return res.status(400).json({ error: `Template "${TEMPLATE}" has no tasks. Open Setup → seed it first.` });
    }
    const tplPo  = tplTasksRaw.find(t => t.anchor_key === 'receipt_of_po');
    const tplFat = tplTasksRaw.find(t => t.anchor_key === 'fat');
    if (!tplPo || !tplFat) {
      return res.status(400).json({ error: `Template "${TEMPLATE}" is missing Receipt of PO and/or FAT anchors.` });
    }

    // Collapse duplicate template tasks when headcount = 1. The template has
    // Mechanical Design + ME 2 (same role) and Builder 1 + Builder 2 (same
    // role). For a 1-person headcount, drop the second task entirely — one
    // person can't do two parallel jobs.
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

    // ---- Bucket the template's tasks so we know how to distribute hours ----
    // For each (section, discipline) bucket, count the non-milestone non-anchor
    // template tasks. Each task in a bucket gets an equal share of that
    // bucket's estimate hours.
    const bucketTasks = {};
    const isWorkTask = (t) => !t.is_milestone && !t.anchor_key;
    for (const t of tplTasks) {
      if (!isWorkTask(t)) continue;
      const [sec, disc] = classifyTask(t);
      if (!sec || !disc) continue;
      const key = `${sec}.${disc}`;
      (bucketTasks[key] ||= []).push(t);
    }

    // ---- Hours per bucket from the estimate ----
    // Per user direction, break out controls + general engineering into the
    // discrete sub-buckets that match individual template tasks (instead of
    // averaging across one big bucket). Each template task gets the estimate
    // hours for ITS specific column.
    //   controls_design  = ce_design + ce_database (Controls Design + Drawings tasks)
    //   controls_software = ce_software (Controls Software task)
    //   gen_hmi          = gen_hmi sec 10 + sec 40 (HMI Programming runs into testing)
    //   gen_robot        = gen_robot sec 10 + sec 40
    //   gen_vision       = gen_vision sec 10 + sec 40
    //   gen_device       = gen_device sec 10 + sec 40
    // Section 40 testing engineering = mech_eng + controls_eng debug ONLY
    // (general engineering debug hours already absorbed by HMI/Robot/Vision
    // tasks above).
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

    // ---- Compute durations + allocations ----
    // SDC scheduling rules (from user feedback):
    //   1. ONE person, FULL TIME at 90% — that's the goal. Only add a second
    //      when one person at 90% can't finish in the available window.
    //   2. Allocations snap to a discrete tier: 25, 50, or 90. No 87%, no 81%.
    //      Always err toward more time (lower allocation when fits).
    //   3. When headcount = 1, COLLAPSE template duplicate tasks (ME 2,
    //      Builder 2) — same role, one task is enough.
    //   4. Configure Machine = ~5% of section 40 engineering debug hours.
    //   5. Test/Debug 1 + 2 share the remaining 95% (parallel, 2 testers fixed).
    //   6. Shop Debug duration = engineering debug duration (parallel).
    //   7. Mech 1 Release at END of mech eng. Mech eng stretches to absorb
    //      slack so the rest packs right up to FAT.
    //   8. Section 50 teardown + install fixed at 1 week each.
    const SECTION_50_DAYS = 5;
    const fullAllocPct = Math.round(efficiency * 100); // = 90 by default
    // v4.55: discipline-aware allocation. Engineering tasks at 85%, shop
    // tasks at 90% — matches the SDC standard baked into the template
    // (v4.20 release notes). Shop = build, wire, shop_debug, teardown,
    // install (physical labor). Engineering = everything else (mech eng,
    // controls design/software/drawings, gen hmi/robot/vision/device,
    // configure machine, test/debug engineer 1+2).
    const ENG_ALLOC_PCT = 85;
    const SHOP_ALLOC_PCT = 90;
    const allocForBucket = (bucketKey) =>
      /\.(build|wire|shop_debug|teardown|install)$/.test(bucketKey) ? SHOP_ALLOC_PCT : ENG_ALLOC_PCT;

    // Allocation snap — used for ancillary tasks. Tasks should never run at
    // anything other than 25/50/90 per user direction.
    const snapAllocToDiscrete = (rawPct) => {
      if (rawPct <= 37)  return 25;
      if (rawPct <= 70)  return 50;
      return 90;
    };
    // Duration rounded up to nearest HALF-WEEK bucket (0.5w = 3d, 1w = 5d,
    // 1.5w = 8d, 2w = 10d, 2.5w = 13d, 3w = 15d, ...). Half-week granularity
    // matches how SDC PMs think — full weeks or half weeks, nothing finer.
    // Always round UP to give the engineer a slight buffer.
    const ceilWeekDays = (hrs, alloc) => {
      if (!hrs || hrs <= 0) return 3; // minimum 0.5 week
      const rawDays = hrs / (alloc / 100 * 8);
      // Bucket pattern: for n half-weeks (n ≥ 1), days = ceil(n × 2.5).
      // → 1=3, 2=5, 3=8, 4=10, 5=13, 6=15, 7=18, 8=20, ...
      for (let n = 1; n <= 400; n++) {
        const bucketDays = Math.ceil(n * 2.5);
        if (rawDays <= bucketDays) return bucketDays;
      }
      return 1000;
    };

    // Section 10 — minimum work-weeks per discipline at default headcount.
    // Controls + general roll their sub-buckets together for the critical-path
    // math (they run sequentially within their discipline per the template).
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
    // Section 40 — Configure Machine = 5% of eng debug hours. Test/Debug 1 + 2
    // share the remaining 95% (running in parallel, so each = 47.5%).
    const engDebugHrs = bucketHours['section_40.testing'] || 0;
    const configureHrs = engDebugHrs * 0.05;
    const debugPerTesterHrs = (engDebugHrs * 0.95) / 2;
    const configureWeeks = configureHrs / (40 * efficiency);
    const debugWeeks     = debugPerTesterHrs / (40 * efficiency);
    const testingWeeks   = configureWeeks + debugWeeks; // Configure FS Test/Debug
    // Shop debug runs in parallel to Test/Debug (per user — same time frame).
    // Headcount auto-scales: hours / debug_weeks / 40 / eff.
    const shopDebugHrs = bucketHours['section_40.shop_debug'] || 0;
    const shopDebugHeadcount = debugWeeks > 0 ? Math.max(1, Math.ceil(shopDebugHrs / (debugWeeks * 40 * efficiency))) : 1;

    // Total min critical path (in weeks):
    //   mech_eng → 6 wk procurement → max(build, wire) + 1 wk wire-trail → testing → FAT
    const minBuildWireWeeks = Math.max(minWeeks.build, minWeeks.wire) + 1; // Wire FF Build + 1 wk
    const totalMinWeeks    = minWeeks.mech_eng + 6 + minBuildWireWeeks + testingWeeks;

    const deliveryWeeks = (new Date(fatDate).getTime() - new Date(poDate).getTime()) / (7 * 86400000);

    // Slack distribution: if min schedule < delivery, stretch Mech Eng to push
    // M1R as late as possible (user prefers Mech 1 Release at end of mech eng).
    const slackWeeks = Math.max(0, deliveryWeeks - totalMinWeeks);
    const mechEngStretchedWeeks = minWeeks.mech_eng + slackWeeks;

    const taskDurations = {};
    const taskAllocations = {};

    // ---- Apply durations + allocations ----
    // RULE: ALL tasks at 90% allocation, FULL TIME. Mech Eng main is never
    // stretched — the goal is to get the machine to testing ASAP. Slack
    // absorbs into the TESTING phase (after this initial pass) instead of
    // engineering. All durations are rounded UP to whole weeks.
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

    // Mech Eng — always 90% allocation, whole-week duration. NOT stretched.
    setStandardBucket('section_10.mech_eng', bucketHours['section_10.mech_eng']);
    // Each broken-out controls / general bucket gets its own duration based on
    // the estimate hours for ITS column — no more averaging across disciplines.
    setStandardBucket('section_10.controls_design',   bucketHours['section_10.controls_design']);
    setStandardBucket('section_10.controls_software', bucketHours['section_10.controls_software']);
    setStandardBucket('section_10.gen_hmi',           bucketHours['section_10.gen_hmi']);
    setStandardBucket('section_10.gen_robot',         bucketHours['section_10.gen_robot']);
    setStandardBucket('section_10.gen_vision',        bucketHours['section_10.gen_vision']);
    setStandardBucket('section_10.gen_device',        bucketHours['section_10.gen_device']);
    setStandardBucket('section_10.build',             bucketHours['section_10.build']);
    // Wire bucket split: prefer hours_breakdown (user-edited panel/machine
    // values), fall back to 1:3 default (Panel = 25%, Machine = 75%).
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
    // Controls Design vs Drawings split — prefer hours_breakdown (user-edited
    // ce_des / ce_drw values), fall back to 50/50 of bucketHours.controls_design.
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

    // Section 40 — Configure (5%) + Test/Debug 1+2 (parallel) + Shop Debug.
    // T/D 1 (lead CE) is ALWAYS 90% — full time, present the whole testing
    // phase per user direction. T/D 2 (secondary, ME) drops to whatever
    // discrete allocation (25/50/90) matches the REMAINING quoted hours after
    // T/D 1's full-time coverage. Same idea for Shop Debug — alloc snaps to
    // 25/50/90 based on shop hours over the testing duration.
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
      // T/D 1 lead — engineering at 85%, hour-based duration.
      const td1Hrs = debugPerTesterHrs;
      taskDurations[td1Task.id]   = ceilWeekDays(td1Hrs, ENG_ALLOC_PCT);
      taskAllocations[td1Task.id] = ENG_ALLOC_PCT;
    }
    for (const t of td2Tasks) {
      // T/D 2 secondary engineering. Duration MATCHES T/D 1's. Allocation
      // recomputed below from remaining quoted hours.
      taskDurations[t.id]   = td1Task ? taskDurations[td1Task.id] : ceilWeekDays(debugPerTesterHrs, ENG_ALLOC_PCT);
      taskAllocations[t.id] = ENG_ALLOC_PCT; // placeholder — recomputed below
    }
    // Shop Debug — duration matches debug duration; allocation set below.
    const shopDebugTasks = bucketTasks['section_40.shop_debug'] || [];
    const debugDurationDays = td1Task ? taskDurations[td1Task.id] : ceilWeekDays(debugPerTesterHrs, ENG_ALLOC_PCT);
    for (const t of shopDebugTasks) {
      taskDurations[t.id]   = debugDurationDays;
      taskAllocations[t.id] = SHOP_ALLOC_PCT; // placeholder — recomputed below
    }
    // Compute T/D 2 + Shop Debug allocations from QUOTED hours so the schedule
    // doesn't over-allocate during the stretched testing phase. T/D 1 lead
    // sets the baseline coverage at the engineering allocation (85%); the
    // remainder is split across T/D 2 and Shop Debug.
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

    // Section 50 — shop work (teardown + install), 1 week fixed each, 90%.
    for (const t of bucketTasks['section_50.teardown'] || []) {
      taskDurations[t.id]   = SECTION_50_DAYS;
      taskAllocations[t.id] = SHOP_ALLOC_PCT;
    }
    for (const t of bucketTasks['section_50.install'] || []) {
      taskDurations[t.id]   = SECTION_50_DAYS;
      taskAllocations[t.id] = SHOP_ALLOC_PCT;
    }

    // Fallback — anything we didn't classify (procurement milestones, etc.)
    // keeps template duration and uses the engineering default (85%).
    for (const t of tplTasks) {
      if (taskDurations[t.id] != null) continue;
      if (t.is_milestone || t.anchor_key) continue;
      taskDurations[t.id]   = t.duration_days || 1;
      taskAllocations[t.id] = ENG_ALLOC_PCT;
    }

    // ---- Insert tasks ----
    // Anchors keep their pinned dates (PO + FAT) and predecessors are cleared so
    // cascadeSchedule() leaves them alone. All other tasks get their start/end
    // recomputed from their predecessors + the new durations.
    const insertStmt = db.prepare(`
      INSERT INTO tasks (name, project, phase_group, department, sub_department, assignee,
                         start_date, end_date, duration_days, is_milestone, progress, allocation,
                         priority, notes, sort_order, anchor_key, predecessors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `);
    const oldToNewId = {};
    let sortOrder = 0;
    for (const t of tplTasks) {
      const newDur = taskDurations[t.id] != null ? taskDurations[t.id] : (t.duration_days || 5);
      const newAlloc = taskAllocations[t.id] != null ? taskAllocations[t.id] : ENG_ALLOC_PCT;
      const r = insertStmt.run(
        t.name, projectName,
        t.phase_group, t.department, t.sub_department,
        (t.assignee && /placeholder/i.test(t.assignee)) ? t.assignee : null,
        t.start_date || poDate, t.end_date || poDate,
        t.is_milestone ? 0 : newDur, t.is_milestone,
        0,
        // Per-task allocation — driven by hours/duration math so Mech Eng tasks
        // that got stretched to absorb slack run at a lower allocation than full
        // efficiency. Milestones keep template's value (irrelevant at 0-duration).
        t.is_milestone ? (t.allocation == null ? 100 : t.allocation) : newAlloc,
        1, t.notes, sortOrder++, t.anchor_key,
      );
      oldToNewId[t.id] = r.lastInsertRowid;
    }

    // BACKLOG TASK — kickoff/ramp-up period between Receipt of PO and the start
    // of engineering. Default 2 weeks. Allocation 0 (no real work, just calendar
    // time). phase_group is NULL so it renders ABOVE section 10 (right under
    // Receipt of PO) instead of inside it. anchor_key 'backlog' so the renderer
    // can pick it up and treat it as a duration-only spine task — no progress
    // pill, no drift chip (it's a backlog, not behind-schedule work).
    let backlogId = null;
    if (backlogDays > 0) {
      const insertBacklog = db.prepare(`
        INSERT INTO tasks (name, project, phase_group, department, sub_department, assignee,
                           start_date, end_date, duration_days, is_milestone, progress, allocation,
                           priority, notes, sort_order, anchor_key, predecessors)
        VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, 0, 0, 0, 1, NULL, ?, NULL, ?)
      `);
      const r = insertBacklog.run(
        'Backlog', projectName,
        poDate, poDate,
        backlogDays,
        sortOrder++,
        `${oldToNewId[tplPo.id]}FS`,
      );
      backlogId = r.lastInsertRowid;
    }

    // Remap predecessors with overrides:
    //   - Receipt of PO has predecessors CLEARED (pinned to user date)
    //   - Mech 1 Release: FF the last mech eng task (no lag) → lands at end of mech eng
    //   - FAT: FF the main Test/Debug Engineer task minus 1 week (per user) → FAT
    //     happens 1 week before main testing ends, work continues that final week
    //   - Mech eng tasks: FS Backlog (so engineering starts after the kickoff
    //     period, not the instant the PO is signed)
    const updPred = db.prepare('UPDATE tasks SET predecessors = ? WHERE id = ?');
    const mechEngNewIds = new Set((bucketTasks['section_10.mech_eng'] || []).map(t => oldToNewId[t.id]).filter(Boolean));
    const mechEngTplTasks = (bucketTasks['section_10.mech_eng'] || []).slice().sort((a, b) => (b.sort_order || 0) - (a.sort_order || 0));
    const lastMechEngTpl = mechEngTplTasks[0];
    const testDebugMain = (bucketTasks['section_40.testing'] || []).find(t => /test\/?debug.*engineer.*1/i.test(t.name))
                       || (bucketTasks['section_40.testing'] || []).find(t => /test\/?debug/i.test(t.name) && !/configure/i.test(t.name));
    for (const t of tplTasks) {
      const newId = oldToNewId[t.id];
      if (t.anchor_key === 'receipt_of_po') {
        updPred.run(null, newId);
        continue;
      }
      if (t.anchor_key === 'fat' && testDebugMain) {
        updPred.run(`${oldToNewId[testDebugMain.id]}FF -1w`, newId);
        continue;
      }
      if (t.anchor_key === 'mech_release_1' && lastMechEngTpl) {
        updPred.run(`${oldToNewId[lastMechEngTpl.id]}FF`, newId);
        continue;
      }
      // Re-point mech eng tasks to start after Backlog (instead of at PO).
      if (backlogId && mechEngNewIds.has(newId)) {
        updPred.run(`${backlogId}FS`, newId);
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
      if (remapped) updPred.run(remapped, newId);
    }
    // Pin PO to user date. FAT is left to cascade from its predecessor (Test/Debug 1
    // FF -1w) — its actual position depends on how the rest of the chain lands.
    const updAnchorDates = db.prepare('UPDATE tasks SET start_date = ?, end_date = ? WHERE id = ?');
    updAnchorDates.run(poDate,  poDate,  oldToNewId[tplPo.id]);

    // Run cascade — non-anchor tasks recompute their dates from predecessors +
    // their (now hours-based) durations. PO and FAT stay where pinned because
    // they have no predecessors.
    cascadeSchedule();

    // Testing-phase slack absorption. Per user direction, if the schedule has
    // slack, the TESTING phase stretches to fill it — never the engineering.
    // Testing always takes longer than estimated, so extra time goes there.
    //
    // Target: T/D 1 must end at FAT + 1 business week (so FAT = T/D 1 FF -1w
    // lands exactly at the user's quoted FAT date). If T/D 1's current end is
    // earlier, extend T/D 1 + T/D 2 + Shop Debug by the difference in
    // whole-week steps. If later, leave alone (the variance message will
    // flag the overrun).
    if (testDebugMain) {
      const td1Id = oldToNewId[testDebugMain.id];
      const td1Row = db.prepare('SELECT start_date, end_date, duration_days FROM tasks WHERE id = ?').get(td1Id);
      if (td1Row && td1Row.start_date && td1Row.end_date) {
        const requiredEndIso = addBusinessDaysISO(fatDate, 5); // FAT + 1 wk
        const currentEndMs   = new Date(td1Row.end_date    + 'T00:00:00Z').getTime();
        const requiredEndMs  = new Date(requiredEndIso     + 'T00:00:00Z').getTime();
        if (requiredEndMs > currentEndMs) {
          // Extend testing duration by N business days where N is the gap
          // rounded up to a half-week increment (2.5 days → 3 days, 5 → 5,
          // 7.5 → 8, etc.) so durations stay on the half-week grid.
          const gapDays  = businessDaysSpanInclusive(td1Row.end_date, requiredEndIso) - 1;
          let extraDays = 0;
          for (let n = 1; n <= 400; n++) {
            const bucketDays = Math.ceil(n * 2.5);
            if (gapDays <= bucketDays) { extraDays = bucketDays; break; }
          }
          const newDur = td1Row.duration_days + extraDays;
          // Extend all parallel testing tasks together.
          const testingExtendIds = [
            oldToNewId[testDebugMain.id],
            ...debugTasks.map(t => oldToNewId[t.id]),
            ...shopDebugTasks.map(t => oldToNewId[t.id]),
          ].filter(Boolean);
          for (const id of testingExtendIds) {
            db.prepare('UPDATE tasks SET duration_days = ? WHERE id = ?').run(newDur, id);
          }
          // RECOMPUTE allocations now that we know the final stretched
          // duration. T/D 1 stays at ENG_ALLOC_PCT (lead, full time). T/D 2
          // drops to match remaining quoted hours. Shop Debug drops to match
          // its quoted shop hours. Both snap to {25, 50, 90}.
          const td1HrsCovered = newDur * 8 * (ENG_ALLOC_PCT / 100);
          for (const t of td2Tasks) {
            const remainingHrs = Math.max(0, engDebugHrs - configureHrs - td1HrsCovered);
            const rawPct = (remainingHrs / (newDur * 8)) * 100;
            const alloc = snapAllocToDiscrete(Math.max(0, rawPct));
            db.prepare('UPDATE tasks SET allocation = ? WHERE id = ?').run(alloc, oldToNewId[t.id]);
          }
          for (const t of shopDebugTasks) {
            const rawPct = (shopDebugHrs / (newDur * 8)) * 100;
            const alloc = snapAllocToDiscrete(Math.max(0, rawPct));
            db.prepare('UPDATE tasks SET allocation = ? WHERE id = ?').run(alloc, oldToNewId[t.id]);
          }
          // Re-cascade so the new durations propagate.
          cascadeSchedule();
        }
      }
    }

    // Variance check: compare the computed FAT date to the user's quoted FAT.
    // Testing extension above should land them within a few days. If FAT is
    // significantly late, headcount needs a bump.
    const fatRow = db.prepare('SELECT start_date FROM tasks WHERE project = ? AND anchor_key = ?').get(projectName, 'fat');
    let scheduleVariance = null;
    if (fatRow && fatRow.start_date) {
      scheduleVariance = Math.round((new Date(fatRow.start_date).getTime() - new Date(fatDate).getTime()) / 86400000);
    }

    // Persist the quoted hours per task bucket so the Schedule view can pop up
    // a Quote-vs-Schedule comparison later. Uses the settings table with a
    // project-scoped key.
    try {
      const quote = {
        hours_per_section: hps,
        hours_breakdown: hbd,
        headcount,
        efficiency,
        po_date: poDate,
        fat_date: fatDate,
      };
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(`project_quote:${projectName}`, JSON.stringify(quote));
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
    sync('tasks', 'settings');
  } catch (err) {
    console.error('Estimate create failed:', err);
    res.status(500).json({ error: err.message || 'Create failed' });
  }
});

// ---------- Schedule import (round-trip of our own Export format) ----------
// Accepts the .xlsx or .csv produced by the frontend Export button.
// Columns (case-insensitive, order-independent):
//   Line | Task | Project | Phase | Department | Sub-Dept | Assignee |
//   Start | Finish | Duration (d) | % Complete | Predecessors | Notes
//
// Behaviour:
//   • project name comes from the request body (user confirms before upload)
//   • if the project already has tasks, we UPSERT by row order (existing tasks
//     updated, extras appended, rows removed if the file has fewer rows)
//   • line numbers in the Predecessors column are REMAPPED to the real task IDs
//     of the rows created/updated in this import so cross-row refs stay valid
//   • all other fields default gracefully when missing

app.post('/api/import/schedule', (req, res) => {
  try {
    const projectName = (req.body.project || '').toString().trim();
    const file        = req.body.file;   // base64 string
    const mode        = req.body.mode || 'replace'; // 'replace' | 'merge'
    if (!projectName) return res.status(400).json({ error: 'project name required' });
    if (!file)        return res.status(400).json({ error: 'file (base64) required' });

    const buf = Buffer.from(file, 'base64');
    const wb  = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: false });
    if (!wb.SheetNames.length) return res.status(400).json({ error: 'workbook has no sheets' });

    // Use the first sheet
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const raw  = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });

    // Find header row (contains "Task" or "task")
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

    // Parse data rows
    const dataRows = [];
    for (let i = headerIdx + 1; i < raw.length; i++) {
      const r = raw[i];
      if (!r) continue;
      const name = COLS.task >= 0 ? String(r[COLS.task] || '').trim() : '';
      if (!name) continue;
      dataRows.push({
        _line:        i - headerIdx,   // 1-based line in the file (used for pred remapping)
        name,
        project:      projectName,     // always override with the confirmed project name
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

    // If replacing: delete existing tasks for this project first
    if (mode === 'replace') {
      db.prepare('DELETE FROM tasks WHERE project = ?').run(projectName);
      db.prepare('DELETE FROM project_financials WHERE project = ?').run(projectName);
    }

    // Insert rows and build line→id map for predecessor remapping
    const lineToId = {};  // file line number → new task id
    const insertStmt = db.prepare(`
      INSERT INTO tasks
        (name, project, phase, department, sub_department, assignee,
         start_date, end_date, duration_days, progress, notes,
         is_milestone, allocation, priority, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    for (const row of dataRows) {
      const result = insertStmt.run(
        row.name, row.project, row.phase, row.department, row.sub_department,
        row.assignee, row.start_date, row.end_date, row.duration_days,
        row.progress, row.notes, row.is_milestone, row.allocation,
        row.priority, row.sort_order
      );
      lineToId[row._line] = result.lastInsertRowid;
    }

    // Remap predecessors: file uses line numbers → translate to real task IDs
    const updatePred = db.prepare('UPDATE tasks SET predecessors = ? WHERE id = ?');
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
      if (remapped) updatePred.run(remapped, lineToId[row._line]);
    }

    // Ensure project record exists
    db.prepare('INSERT OR IGNORE INTO projects (name) VALUES (?)').run(projectName);

    const inserted = dataRows.length;
    res.json({ ok: true, project: projectName, inserted, mode });
    sync('tasks', 'projects');
  } catch (err) {
    console.error('[import/schedule]', err);
    res.status(500).json({ error: err.message });
  }
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
  sync('tasks');
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
  sync('tasks');
});

// ---------- Multi-machine: duplicate one machine's tasks into another ----------
// POST /api/projects/:project/duplicate-machine
// Body: {
//   sourceMachine, targetMachine,
//   includeTaskIds?:        number[],            // optional subset of source IDs
//   customPredecessors?:    { [sourceId]: string } // per-task override; bypasses idMap
// }
//
// Clones every task tagged with `machine = sourceMachine` in the given project
// to new rows tagged `machine = targetMachine`. Predecessors that point WITHIN
// the source machine's task set are rewritten to point at the corresponding
// new clone (e.g. M2's Build → M2's Wire). Predecessors that point at shared
// or other-machine tasks are preserved as-is so cross-machine + shared
// relationships still work.
//
// `customPredecessors` lets the user override individual cloned tasks'
// predecessor strings — typically used to add a cross-machine link
// ("M2.Wire waits for M1.Wire"). The override is treated as-is (already
// expressed as task IDs), so it points at exactly what the user typed.
app.post('/api/projects/:project/duplicate-machine', (req, res) => {
  const project = req.params.project;
  const {
    sourceMachine,
    targetMachine,
    chainPredecessors,        // legacy: chain ALL cloned tasks to their source
    includeTaskIds,           // optional array of source task IDs to clone. If absent/empty → all.
    chainTaskIds,             // legacy: tasks whose clones should FS-depend on the source task.
    customPredecessors,       // map: sourceId → pred string (overrides auto-rewrite)
  } = req.body || {};
  if (!project || !sourceMachine || !targetMachine) {
    return res.status(400).json({ error: 'project, sourceMachine, targetMachine required' });
  }
  if (sourceMachine === targetMachine) {
    return res.status(400).json({ error: 'sourceMachine and targetMachine must differ' });
  }
  // Reject if target already has tasks in this project (avoid accidental merging).
  const existing = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE project = ? AND machine = ?').get(project, targetMachine).c;
  if (existing > 0) {
    return res.status(409).json({ error: `Machine "${targetMachine}" already has ${existing} tasks in this project.` });
  }
  // Pick the rows to clone. When the client sends includeTaskIds, those
  // IDs win and may include rows outside the source machine (shared
  // anchors, design rows above the Build line — the user explicitly
  // clicked them in the schedule). Without includeTaskIds, fall back
  // to "every row tagged with sourceMachine" (legacy behavior).
  let sourceTasks;
  const includeSet = Array.isArray(includeTaskIds) && includeTaskIds.length
    ? new Set(includeTaskIds.map(Number))
    : null;
  if (includeSet) {
    sourceTasks = db.prepare('SELECT * FROM tasks WHERE project = ? ORDER BY sort_order, id').all(project)
      .filter(t => includeSet.has(t.id));
    if (sourceTasks.length === 0) {
      return res.status(400).json({ error: 'includeTaskIds did not match any tasks in this project.' });
    }
  } else {
    sourceTasks = db.prepare('SELECT * FROM tasks WHERE project = ? AND machine = ? ORDER BY sort_order, id').all(project, sourceMachine);
    if (sourceTasks.length === 0) {
      return res.status(404).json({ error: `No tasks found for machine "${sourceMachine}" in project "${project}".` });
    }
  }
  const chainSet = Array.isArray(chainTaskIds) && chainTaskIds.length
    ? new Set(chainTaskIds.map(Number))
    : null;
  // customPredecessors: per-source-id override map. After the auto-rewrite
  // pass, if a cloned row's source ID has an override, we replace the
  // pred string with the user-typed value verbatim — the user has direct
  // control. The keys may arrive as numbers OR strings depending on JSON.
  const customPredMap = (customPredecessors && typeof customPredecessors === 'object')
    ? Object.fromEntries(Object.entries(customPredecessors).map(([k, v]) => [Number(k), v]))
    : null;
  const cloneCols = ['name', 'project', 'phase', 'phase_group', 'department', 'sub_department', 'assignee', 'start_date', 'end_date', 'duration_days', 'predecessors', 'is_milestone', 'progress', 'allocation', 'priority', 'notes', 'sort_order', 'anchor_key', 'is_action', 'completed_on', 'machine'];
  const insert = db.prepare(`INSERT INTO tasks (${cloneCols.join(', ')}) VALUES (${cloneCols.map(() => '?').join(', ')})`);
  // sort_order for new tasks: push to end of project so they don't tangle.
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks WHERE project = ?').get(project).m;

  db.exec('BEGIN');
  try {
    const idMap = {};                  // oldId → newId
    const newTasks = [];               // pairs of (oldTask, newId) for predecessor rewrite
    let sortCursor = maxSort + 10;
    for (const t of sourceTasks) {
      const values = [
        t.name,
        t.project,
        t.phase,
        t.phase_group,
        t.department,
        t.sub_department,
        t.assignee,
        t.start_date,
        t.end_date,
        t.duration_days,
        null, // predecessors: rewritten in the second pass
        t.is_milestone,
        0,    // progress resets — duplicates haven't been done yet
        t.allocation,
        t.priority,
        t.notes,
        sortCursor,
        t.anchor_key,
        t.is_action,
        null, // completed_on resets
        targetMachine,
      ];
      const r = insert.run(...values);
      idMap[t.id] = r.lastInsertRowid;
      newTasks.push({ oldTask: t, newId: r.lastInsertRowid });
      sortCursor += 10;
    }
    // Second pass: rewrite predecessors using idMap. References to source-
    // machine tasks become references to the new tasks. Other references
    // (shared anchors, other machines) pass through unchanged.
    const updatePred = db.prepare('UPDATE tasks SET predecessors = ? WHERE id = ?');
    for (const { oldTask, newId } of newTasks) {
      if (!oldTask.predecessors) continue;
      const rewritten = String(oldTask.predecessors)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(ref => {
          const m = ref.match(/^(\d+)(.*)$/);
          if (!m) return ref;
          const oldId = Number(m[1]);
          const suffix = m[2] || '';
          if (idMap[oldId]) {
            return idMap[oldId] + suffix;
          }
          // Optionally chain to source machine — only relevant when the
          // predecessor in the source pointed to a non-source-machine task
          // (e.g. a shared anchor). For the chain case we'd add an
          // explicit reference to the corresponding source task instead.
          return ref;
        })
        .join(', ');
      if (rewritten !== oldTask.predecessors) {
        updatePred.run(rewritten || null, newId);
      } else {
        updatePred.run(oldTask.predecessors, newId);
      }
    }
    // Chain: add a FS link from the new task to its source-machine
    // counterpart. Two modes:
    //   • chainPredecessors=true (legacy / all-or-nothing) — every cloned
    //     task chains to source.
    //   • chainTaskIds (per-task) — only tasks whose source ID is in the
    //     list chain to source. This is what the per-task dialog sends.
    const shouldChain = (oldId) => {
      if (chainPredecessors) return true;
      if (chainSet) return chainSet.has(Number(oldId));
      return false;
    };
    for (const { oldTask, newId } of newTasks) {
      if (!shouldChain(oldTask.id)) continue;
      const row = db.prepare('SELECT predecessors FROM tasks WHERE id = ?').get(newId);
      const existing = row.predecessors ? row.predecessors + ', ' : '';
      updatePred.run(`${existing}${oldTask.id}FS`, newId);
    }
    // Per-task custom predecessor overrides. The user typed these directly
    // referencing source-machine line numbers (already parsed to task IDs
    // on the client). We honor them verbatim — no idMap rewriting — so
    // the user can intentionally point at the source machine ("M2.Build
    // waits for M1.Build to finish"). Empty string clears the pred.
    if (customPredMap) {
      console.log(`[duplicate-machine] ${project} → ${targetMachine}: customPredMap keys=${Object.keys(customPredMap).join(',')}`);
      for (const { oldTask, newId } of newTasks) {
        if (!(oldTask.id in customPredMap)) continue;
        const raw = customPredMap[oldTask.id];
        const v = (raw == null) ? '' : String(raw).trim();
        console.log(`[duplicate-machine]   override: srcId=${oldTask.id} (${oldTask.name}) newId=${newId} pred="${v}"`);
        updatePred.run(v ? v : null, newId);
      }
    }
    // Final-state dump: what every cloned row ends up with after rewrite + override.
    console.log(`[duplicate-machine] ${project} → ${targetMachine}: ${newTasks.length} cloned`);
    for (const { oldTask, newId } of newTasks) {
      const row = db.prepare('SELECT predecessors, name FROM tasks WHERE id = ?').get(newId);
      console.log(`[duplicate-machine]   ${newId} ${row.name}: pred="${row.predecessors || ''}" (from srcId=${oldTask.id}, srcPred="${oldTask.predecessors || ''}")`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: String(err.message || err) });
  }
  // After commit, recompute start/end dates from every task's predecessors.
  // Without this the new cloned rows keep the source machine's dates even
  // though their predecessors now point at different tasks (or have new
  // lags). Cascade iterates to convergence so chained dependencies all
  // settle together (M2.Wire shifts because M2.Build shifted).
  cascadeSchedule();
  // Log post-cascade dates so we can verify the schedule moved as expected.
  const final = db.prepare('SELECT id, name, predecessors, start_date, end_date FROM tasks WHERE project = ? AND machine = ? ORDER BY sort_order, id').all(project, targetMachine);
  console.log(`[duplicate-machine] ${project} → ${targetMachine}: post-cascade dates:`);
  for (const r of final) {
    console.log(`[duplicate-machine]   ${r.id} ${r.name}: ${r.start_date} → ${r.end_date}  pred="${r.predecessors || ''}"`);
  }
  res.json({ ok: true, cloned: sourceTasks.length });
});

// DELETE /api/projects/:project/machines/:machine
//
// Removes every task tagged with `machine = :machine` in the given project.
// Used by the sub-tab bar's right-click "Delete machine X" option so the
// user can clean up bad clones and retry. Returns the count deleted.
//
// We also clear `anchor_key` first so the regular DELETE guard (which
// protects anchor rows) doesn't block us — deleting a whole machine
// should remove ALL of its rows, including its FAT / Ship / PowerUp.
app.delete('/api/projects/:project/machines/:machine', (req, res) => {
  const project = req.params.project;
  const machine = req.params.machine;
  if (!project || !machine) {
    return res.status(400).json({ error: 'project and machine are required' });
  }
  try {
    const rows = db.prepare('SELECT id FROM tasks WHERE project = ? AND machine = ?').all(project, machine);
    if (rows.length === 0) {
      return res.json({ ok: true, deleted: 0 });
    }
    db.exec('BEGIN');
    const clearAnchor = db.prepare('UPDATE tasks SET anchor_key = NULL WHERE id = ?');
    const del = db.prepare('DELETE FROM tasks WHERE id = ?');
    for (const r of rows) {
      clearAnchor.run(r.id);
      del.run(r.id);
    }
    db.exec('COMMIT');
    return res.json({ ok: true, deleted: rows.length });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: String(err.message || err) });
  }
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
  sync('project_financials');
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
  sync('project_financials');
});

app.delete('/api/financials/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM project_financials WHERE id = ?').run(id);
  res.json({ ok: true });
  sync('project_financials');
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

// ── Server-Sent Events — real-time push to all open browser tabs ──────────────
const _sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  // Heartbeat every 25 s keeps the connection alive through proxies/load-balancers.
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

// ── Projects API ───────────────────────────────────────────────────────────────
app.get('/api/projects', (_req, res) => {
  const rows = db.prepare('SELECT * FROM projects ORDER BY name ASC').all();
  res.json(rows);
});

app.post('/api/projects', (req, res) => {
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const existing = db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
  if (existing) return res.json(existing);
  db.prepare(`
    INSERT INTO projects (name, status, is_template, job_number, workspace)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    name,
    req.body.status     || 'active',
    req.body.is_template ? 1 : 0,
    req.body.job_number || null,
    req.body.workspace  || 'default',
  );
  const row = db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
  res.status(201).json(row);
  sync('projects');
  notifyClients('projects_changed');
});

app.put('/api/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const allowed = ['name', 'status', 'is_template', 'job_number', 'workspace'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      updates[k] = k === 'is_template' ? (req.body[k] ? 1 : 0) : req.body[k];
    }
  }
  if (Object.keys(updates).length === 0) return res.json(existing);

  // If renaming, propagate the new name to all tasks
  if (updates.name && updates.name !== existing.name) {
    db.prepare('UPDATE tasks SET project = ? WHERE project = ?').run(updates.name, existing.name);
    db.prepare('UPDATE project_financials SET project = ? WHERE project = ?').run(updates.name, existing.name);
    sync('tasks', 'project_financials');
  }

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE projects SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  res.json(row);
  sync('projects');
  notifyClients('projects_changed');
});

app.delete('/api/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM tasks WHERE project = ?').run(existing.name);
  db.prepare('DELETE FROM project_financials WHERE project = ?').run(existing.name);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  res.json({ ok: true });
  sync('tasks', 'project_financials', 'projects');
  notifyClients('projects_changed');
});

// Ensure a project record exists for a given name (idempotent). Used by the
// frontend after loading tasks to register any project name not yet in the table.
app.post('/api/projects/ensure', (req, res) => {
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  db.prepare('INSERT OR IGNORE INTO projects (name) VALUES (?)').run(name);
  const row = db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
  res.json(row);
});

// Health check — used by Electron shell to detect server readiness
app.get('/health', (_req, res) => res.json({ ok: true, service: 'scheduler' }));

// ── Exportable entry point (used by Electron in-process execution) ────────────
function startServer({ port } = {}) {
  const p = port || PORT;
  const server = app.listen(p, '0.0.0.0', () => {
    console.log(`[scheduler] Running at http://localhost:${p}`);
  });
  server.on('error', err => console.error('[scheduler] Server error:', err.message));
  // Init Azure sync in background — does not block server startup or requests.
  azureSync.init(db).catch(err => console.warn('[AzureSync] Background init error:', err.message));
  return server;
}

if (require.main === module) {
  const server = startServer();
  process.on('SIGTERM', () => {
    console.log('[scheduler] SIGTERM — shutting down gracefully');
    server.close(() => process.exit(0));
  });
}
module.exports = { startServer };
