/**
 * server.js — SDC Scheduler Express + Socket.io app.
 *
 * Single-file backend. Sections in order of appearance:
 *
 *   1. Setup        — express, http.Server, socket.io, presence, middleware
 *   2. Auth routes  — /api/auth/login, /me, /register  (public — before guard)
 *   3. Scheduling   — parsePredecessorRef, addBusinessDays, cascadeSchedule
 *   4. CRUD         — /api/tasks/* (GET/POST/PUT/DELETE) + history + comments
 *   5. Settings     — /api/settings/*
 *   6. Team         — /api/team/*
 *   7. Projects     — /api/projects/*  (machines, duplicate, baseline, etc.)
 *   8. Estimates    — /api/estimate/*  (xlsx parsing + project auto-generation)
 *   9. Financials   — /api/financials/*
 *  10. Bootstrap    — startServer(), SIGTERM handler
 *
 * Conventions for new routes:
 *   - Guard writes with `requireRole('editor' | 'admin')`
 *   - End task mutations with `io.emit('tasks:updated', { project })`
 *   - Use `logHistory(taskId, project, action, …)` for audit trail
 */
const express = require('express');
const http    = require('http');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const { Server: SocketIO } = require('socket.io');
const { pool } = require('./db');
const { requireAuth, requireRole, signToken, AUTH_ENABLED } = require('./auth');
// emailService is optional — when nodemailer isn't installed or SMTP_HOST is
// empty, it returns a no-op stub so the comment POST handler doesn't crash.
let emailSvc;
try { emailSvc = require('./emailService'); }
catch (_) { emailSvc = { sendMentionEmail: () => {}, sendDigest: () => {} }; }

const app = express();
const PORT = process.env.PORT || 3000;

// Phase 4 (Socket.io): wrap the Express app in an HTTP server and attach
// Socket.io for real-time pushes ('tasks:updated', 'team:updated', etc.).
// Clients reconnect automatically; we only emit invalidate events, the
// client re-fetches over REST. Keeps the payload tiny + idempotent.
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: '*' } });

// Presence tracking: project → Map<socketId, { name, avatar_color, id }>.
// 'presence:join' adds, 'presence:leave' / 'disconnect' removes. Whenever
// the set changes, broadcast the new list. Used by the comment panel /
// future "who's editing" pills.
const _presence = new Map();
io.on('connection', (socket) => {
  socket.on('presence:join', ({ project, user }) => {
    if (!project || !user) return;
    if (!_presence.has(project)) _presence.set(project, new Map());
    _presence.get(project).set(socket.id, { name: user.name, avatar_color: user.avatar_color || '#1574c4', id: user.id });
    io.emit('presence:update', { project, users: [..._presence.get(project).values()] });
  });
  socket.on('presence:leave', ({ project }) => {
    if (!project || !_presence.has(project)) return;
    _presence.get(project).delete(socket.id);
    io.emit('presence:update', { project, users: [..._presence.get(project).values()] });
  });
  socket.on('disconnect', () => {
    for (const [project, users] of _presence.entries()) {
      if (users.has(socket.id)) {
        users.delete(socket.id);
        io.emit('presence:update', { project, users: [...users.values()] });
      }
    }
  });
});

// ── Gzip all responses (cuts JSON payload ~70%) ────────────────────────────
app.use(compression());

app.use(express.json({ limit: '10mb' }));

// Static assets: use `no-cache` (NOT no-store) so the browser revalidates
// every request via ETag / Last-Modified. Server returns 304 when nothing
// has changed (no bytes transferred), and full 200 when a file moves —
// so every push from origin/main shows up on next refresh without users
// having to hard-refresh past a 1-hour stale cache window. HTML stays
// no-store to guarantee the shell reloads cleanly.
app.use((req, res, next) => {
  if (req.path.match(/\.(js|css|svg|png|jpg|ico|woff2?)(\?|$)/)) {
    res.set('Cache-Control', 'no-cache');
  } else {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
// Serve auth-ui.js with minlength patched to 1. public/ is the canonical,
// auto-updated source, so prefer it; only fall back to custom-public/ if the
// file isn't in public/ (legacy/ACL-locked environments).
app.get('/auth-ui.js', (req, res) => {
  const src = fs.existsSync(path.join(__dirname, 'public', 'auth-ui.js'))
    ? path.join(__dirname, 'public', 'auth-ui.js')
    : path.join(__dirname, 'custom-public', 'auth-ui.js');
  const content = fs.readFileSync(src, 'utf8').replace(/minlength="6"/g, 'minlength="1"');
  res.type('application/javascript').send(content);
});
// public/ is CANONICAL (auto-updater writes the latest frontend here) and is
// served FIRST so it always wins. custom-public/ is served only as a fallback
// for files that have no public/ twin (e.g. app-local.js) — a stale copy in
// custom-public/ can no longer shadow the current public/ build.
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true }));
app.use(express.static(path.join(__dirname, 'custom-public'), { etag: true, lastModified: true }));

// ─── Phase 3 (Auth): public auth routes — defined BEFORE the global
// requireAuth middleware so they don't need a token. /api/auth/me is also
// gated by requireAuth itself so callers with expired/missing tokens get 401.
// ──────────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const email    = (req.body.email    || '').toString().trim().toLowerCase();
  const password = (req.body.password || '').toString();
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ? AND active = 1', [email]);
  const user = rows[0] || null;
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  await pool.query('UPDATE users SET last_login = ? WHERE id = ?', [new Date().toISOString().slice(0, 19).replace('T', ' '), user.id]);
  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar_color: user.avatar_color },
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  // requireAuth populates req.authUser. With AUTH_ENABLED=false it's the
  // synthetic admin; with auth on, it's the JWT payload.
  res.json({ user: req.authUser, auth_enabled: AUTH_ENABLED });
});

app.put('/api/auth/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'current_password and new_password are required' });
  if (String(new_password).length < 1)
    return res.status(400).json({ error: 'new password cannot be empty' });
  const [urows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.authUser.id]);
  const user = urows[0] || null;
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!bcrypt.compareSync(current_password, user.password_hash))
    return res.status(401).json({ error: 'Current password is incorrect' });
  const hash = bcrypt.hashSync(String(new_password), 12);
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
  sync('task_comments');
  res.json({ ok: true, message: 'Password updated successfully' });
});

app.post('/api/auth/register', async (req, res) => {
  const email    = (req.body.email    || '').toString().trim().toLowerCase();
  const name     = (req.body.name     || '').toString().trim();
  const password = (req.body.password || '').toString();
  if (!email || !name || !password) return res.status(400).json({ error: 'email, name, password required' });
  if (password.length < 1)           return res.status(400).json({ error: 'password is required' });
  try {
    const hash = bcrypt.hashSync(password, 12);
    const [r] = await pool.query(
      `INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'editor')`,
      [email, name, hash]
    );
    const [urows] = await pool.query('SELECT * FROM users WHERE id = ?', [r.insertId]);
    const user = urows[0];
    const token = signToken(user);
    io.emit('users:updated');
    const roleNote = req.body.role && req.body.role !== 'editor'
      ? 'Requested role ignored — all self-registered accounts start as editor. Contact an admin to change your role.'
      : undefined;
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar_color: user.avatar_color },
      ...(roleNote ? { note: roleNote } : {}),
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' || String(e.message).includes('Duplicate entry') || String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already registered. Try signing in.' });
    res.status(500).json({ error: 'Failed to register: ' + e.message });
  }
});

// Global auth guard — every /api/* request below this line goes through it.
// PUBLIC_PATHS in auth.js exempts /api/auth/login + /api/auth/register +
// /health. When AUTH_ENABLED=false the middleware is a no-op passthrough.
app.use(requireAuth);

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

async function cascadeDurationLinks() {
  for (let iter = 0; iter < 20; iter++) {
    const [linked] = await pool.query(
      'SELECT id, duration_days, duration_link_task_id, start_date, end_date FROM tasks WHERE duration_link_task_id IS NOT NULL'
    );
    let changed = false;
    for (const dep of linked) {
      const [srcRows] = await pool.query('SELECT duration_days FROM tasks WHERE id = ?', [dep.duration_link_task_id]);
      const src = srcRows[0] || null;
      if (!src || dep.duration_link_task_id === dep.id) continue;
      const newDur = Number(src.duration_days) || 0;
      if (newDur === dep.duration_days) continue;
      const newMilestone = newDur === 0 ? 1 : 0;
      let newEnd = dep.end_date;
      if (newDur === 0) {
        newEnd = dep.start_date;
      } else if (dep.start_date) {
        newEnd = addBusinessDaysISO(dep.start_date, newDur - 1);
      }
      await pool.query(
        'UPDATE tasks SET duration_days = ?, end_date = ?, is_milestone = ? WHERE id = ?',
        [newDur, newEnd, newMilestone, dep.id]
      );
      changed = true;
    }
    if (!changed) break;
  }
}

async function cascadeSchedule() {
  for (let iter = 0; iter < 50; iter++) {
    const [all] = await pool.query('SELECT * FROM tasks');
    const byId = Object.fromEntries(all.map(t => [t.id, t]));
    let changed = false;
    for (const t of all) {
      if (t.predecessors) {
        const next = computeDatesFromPreds(t, byId);
        if (next && (next.start_date !== t.start_date || next.end_date !== t.end_date)) {
          await pool.query('UPDATE tasks SET start_date = ?, end_date = ? WHERE id = ?',
            [next.start_date, next.end_date, t.id]);
          changed = true;
        }
      } else if (
        t.start_date && !t.is_milestone &&
        t.duration_days != null && Number(t.duration_days) > 0
      ) {
        const dur = Number(t.duration_days);
        const wantedEnd = addBusinessDaysISO(t.start_date, dur - 1);
        if (wantedEnd !== t.end_date) {
          await pool.query('UPDATE tasks SET end_date = ? WHERE id = ?', [wantedEnd, t.id]);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

async function compactPrioritiesForAssignee(assignee) {
  if (!assignee) return;
  const [rows] = await pool.query(
    'SELECT id, priority FROM tasks WHERE assignee = ? ORDER BY priority IS NULL, priority ASC, id ASC',
    [assignee]
  );
  for (let i = 0; i < rows.length; i++) {
    const target = i + 1;
    if (rows[i].priority !== target) {
      await pool.query('UPDATE tasks SET priority = ? WHERE id = ?', [target, rows[i].id]);
    }
  }
}

// ── Audit trail (task_history) ─────────────────────────────────────────────
// Every task create / update / delete writes a row capturing who, what, when,
// and full before / after snapshots. Used by GET /api/tasks/history below.
// Non-fatal: a logging failure is warned but never blocks the underlying
// mutation, so the schedule write always wins over the audit write.
//
// changedBy: identifier of the user who did the change (e.g. email). null when
//   auth is disabled — we'll populate this when Phase 3 (auth) lands.
// before/after: full row objects from db.prepare('SELECT * FROM tasks WHERE
//   id = ?').get(id); pass null for create (no "before") and null for delete
//   (no "after").
// changedFields: optional array of column names that differ between before
//   and after. For update events the route can compute this and pass it; we
//   auto-derive it below if both before + after are objects.
async function logHistory(taskId, project, action, changedBy, before, after, changedFields) {
  try {
    let fields = changedFields;
    if (!fields && before && after) {
      fields = [];
      const all = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const k of all) {
        if (before[k] !== after[k]) fields.push(k);
      }
    }
    await pool.query(
      `INSERT INTO task_history (task_id, project, action, changed_by, before_json, after_json, changed_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId, project, action, changedBy || null,
        before ? JSON.stringify(before) : null,
        after  ? JSON.stringify(after)  : null,
        Array.isArray(fields) && fields.length ? fields.join(',') : null,
      ]
    );
  } catch (e) {
    console.warn('[history] log failed (non-fatal):', e.message);
  }
}

app.get('/api/tasks', async (req, res) => {
  const [tasks] = await pool.query('SELECT * FROM tasks ORDER BY sort_order, id');
  res.json(tasks);
});

app.post('/api/tasks', requireRole('editor'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks');
  const maxOrder = maxRow.m;
  let insertSortOrder;
  if (req.body.sort_order != null) {
    insertSortOrder = Number(req.body.sort_order);
  } else {
    insertSortOrder = maxOrder + 1;
  }
  let nextPriority = 1;
  if (req.body.priority != null) {
    nextPriority = Math.max(1, Number(req.body.priority) || 1);
  } else if (req.body.assignee) {
    const [[peekRow]] = await pool.query('SELECT COALESCE(MAX(priority), 0) AS m FROM tasks WHERE assignee = ?', [req.body.assignee]);
    nextPriority = (peekRow?.m || 0) + 1;
  }
  const cols = ['name', 'project', 'phase', 'phase_group', 'department', 'sub_department', 'assignee', 'start_date', 'end_date', 'duration_days', 'predecessors', 'is_milestone', 'progress', 'allocation', 'priority', 'notes', 'sort_order', 'anchor_key', 'is_action', 'machine'];
  const values = [
    name,
    req.body.project || null,
    req.body.phase || null,
    req.body.phase_group || null,
    req.body.department || null,
    req.body.sub_department || null,
    req.body.assignee || null,
    req.body.start_date ? String(req.body.start_date).slice(0, 10) : null,
    req.body.end_date ? String(req.body.end_date).slice(0, 10) : null,
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
  const [result] = await pool.query(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders})`, values);
  if (req.body.assignee) await compactPrioritiesForAssignee(req.body.assignee);
  await cascadeSchedule();
  const [[task]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [result.insertId]);
  await logHistory(task.id, task.project, 'create', null, null, task, null);
  res.json(task);
  io.emit('tasks:updated', { project: task.project || null });
});

app.put('/api/tasks/:id', requireRole('editor'), async (req, res) => {
  const id = Number(req.params.id);
  const [[existing]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'not found' });

  if (req.body.version != null && existing.version != null
      && Number(req.body.version) !== Number(existing.version)) {
    return res.status(409).json({
      error: 'This task was modified by another user. Refresh to see the latest version.',
      code: 'STALE_VERSION',
      server_version: existing.version,
      server_row: existing,
    });
  }

  const INT_FIELDS = new Set(['duration_days','progress','allocation','priority','duration_link_task_id','is_action']);
  const DATE_FIELDS = new Set(['start_date','end_date','baseline_start_date','baseline_end_date','completed_on']);
  const updates = {};
  for (const f of FIELDS) {
    if (f in req.body) {
      if (f === 'is_milestone' || f === 'is_action') updates[f] = req.body[f] ? 1 : 0;
      else if (INT_FIELDS.has(f)) updates[f] = req.body[f] == null || req.body[f] === '' ? null : Number(req.body[f]) || 0;
      // ISO 8601 datetimes ('2026-06-20T00:00:00.000Z') overflow the date columns —
      // trim to YYYY-MM-DD so MySQL never throws ER_DATA_TOO_LONG mid-request.
      else if (DATE_FIELDS.has(f)) updates[f] = req.body[f] ? String(req.body[f]).slice(0, 10) : null;
      else updates[f] = req.body[f] === '' ? null : req.body[f];
    }
  }
  if ('progress' in updates && !('completed_on' in updates)) {
    const newProgress = Number(updates.progress) || 0;
    const oldProgress = Number(existing.progress) || 0;
    if (newProgress >= 100 && oldProgress < 100) {
      updates.completed_on = new Date().toISOString().slice(0, 10);
    } else if (newProgress < 100 && oldProgress >= 100) {
      updates.completed_on = null;
    }
  }
  if (Object.keys(updates).length === 0) return res.json(existing);

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await pool.query(`UPDATE tasks SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
  await pool.query('UPDATE tasks SET version = COALESCE(version,1) + 1 WHERE id = ?', [id]);

  const finalAssignee = ('assignee' in updates) ? updates.assignee : existing.assignee;
  const assigneeChanged = 'assignee' in updates && updates.assignee !== existing.assignee;
  const priorityExplicit = 'priority' in updates;

  let finalPriority = ('priority' in updates) ? updates.priority : existing.priority;
  if (assigneeChanged && !priorityExplicit && finalAssignee) {
    const [[peekRow]] = await pool.query('SELECT COALESCE(MAX(priority), 0) AS m FROM tasks WHERE assignee = ?', [finalAssignee]);
    finalPriority = (peekRow?.m || 0) + 1;
    await pool.query('UPDATE tasks SET priority = ? WHERE id = ?', [finalPriority, id]);
  }

  if (priorityExplicit && finalAssignee && finalPriority != null) {
    const [conflicts] = await pool.query(
      'SELECT id FROM tasks WHERE assignee = ? AND priority = ? AND id != ?',
      [finalAssignee, finalPriority, id]
    );
    if (conflicts.length > 0) {
      const [usedRows] = await pool.query(
        'SELECT priority FROM tasks WHERE assignee = ? AND priority IS NOT NULL', [finalAssignee]
      );
      const used = new Set(usedRows.map(r => r.priority));
      for (const c of conflicts) {
        let next = 1;
        while (used.has(next)) next++;
        used.add(next);
        await pool.query('UPDATE tasks SET priority = ? WHERE id = ?', [next, c.id]);
      }
    }
  }

  if (finalAssignee) await compactPrioritiesForAssignee(finalAssignee);
  if (assigneeChanged && existing.assignee && existing.assignee !== finalAssignee) {
    await compactPrioritiesForAssignee(existing.assignee);
  }

  if ('duration_days' in updates) await cascadeDurationLinks();
  await cascadeSchedule();

  const [[updated]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [id]);
  await logHistory(id, updated.project, 'update', null, existing, updated, null);
  res.json(updated);
  io.emit('tasks:updated', { project: updated.project || null });
});

app.delete('/api/tasks/:id', requireRole('editor'), async (req, res) => {
  const id = Number(req.params.id);
  const [[before]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [id]);
  const [[t]] = await pool.query('SELECT anchor_key, assignee FROM tasks WHERE id = ?', [id]);
  if (t && t.anchor_key && t.anchor_key !== 'backlog') {
    return res.status(400).json({ error: 'Anchor milestones cannot be deleted.' });
  }
  // Sever references to this task BEFORE deleting it, so nobody is left holding a
  // dangling link. Task predecessors store bare task-ids ("123FS"); financial
  // triggers store "#<taskId>". We drop only the segment that points at THIS id —
  // everything else is untouched, so other rows don't move or re-date.
  const stripRef = (predStr, marker) => {
    if (!predStr) return predStr;
    const kept = String(predStr).split(',').map(s => s.trim()).filter(Boolean).filter(seg => {
      const m = seg.match(marker ? /^#(\d+)/ : /^(\d+)/);
      return !(m && Number(m[1]) === id);
    });
    return kept.join(', ');
  };
  const [taskRefs] = await pool.query('SELECT id, predecessors FROM tasks WHERE predecessors LIKE ?', [`%${id}%`]);
  for (const r of taskRefs) {
    const np = stripRef(r.predecessors, false);
    if (np !== r.predecessors) await pool.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [np || null, r.id]);
  }
  const [finRefs] = await pool.query('SELECT id, predecessors FROM project_financials WHERE predecessors LIKE ?', [`%#${id}%`]);
  for (const r of finRefs) {
    const np = stripRef(r.predecessors, true);
    if (np !== r.predecessors) await pool.query('UPDATE project_financials SET predecessors = ? WHERE id = ?', [np || null, r.id]);
  }
  await pool.query('DELETE FROM tasks WHERE id = ?', [id]);
  if (before) await logHistory(id, before.project, 'delete', null, before, null, null);
  if (t && t.assignee) await compactPrioritiesForAssignee(t.assignee);
  await cascadeSchedule();
  res.json({ ok: true });
  io.emit('tasks:updated', { project: before?.project || null });
});

app.get('/api/settings', async (req, res) => {
  const [rows] = await pool.query('SELECT `key`, value FROM settings');
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  res.json(out);
});

app.put('/api/settings/:key', requireRole('admin'), async (req, res) => {
  const key = req.params.key;
  const value = JSON.stringify(req.body);
  await pool.query(
    'INSERT INTO settings (`key`, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
    [key, value]
  );
  res.json({ ok: true });
  io.emit('settings:updated', { key });
});

// ---------- Team members ----------
const TEAM_DISCIPLINES = new Set(['mech', 'controls', 'pm', 'build', 'wire']);

app.get('/api/team', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM team_members ORDER BY discipline, sort_order, name');
  res.json(rows);
});

app.post('/api/team', requireRole('editor'), async (req, res) => {
  const name = (req.body.name || '').trim();
  const discipline = req.body.discipline;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!TEAM_DISCIPLINES.has(discipline)) return res.status(400).json({ error: 'invalid discipline' });
  const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM team_members WHERE discipline = ?', [discipline]);
  const [result] = await pool.query('INSERT INTO team_members (name, discipline, sort_order) VALUES (?, ?, ?)', [name, discipline, maxRow.m + 1]);
  const [[row]] = await pool.query('SELECT * FROM team_members WHERE id = ?', [result.insertId]);
  res.json(row);
  io.emit('team:updated');
});

app.put('/api/team/:id', requireRole('editor'), async (req, res) => {
  const id = Number(req.params.id);
  const [[existing]] = await pool.query('SELECT * FROM team_members WHERE id = ?', [id]);
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
  if (updates.name && updates.name !== existing.name) {
    await pool.query('UPDATE tasks SET assignee = ? WHERE assignee = ?', [updates.name, existing.name]);
  }
  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await pool.query(`UPDATE team_members SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
  const [[updated]] = await pool.query('SELECT * FROM team_members WHERE id = ?', [id]);
  res.json(updated);
  io.emit('team:updated');
});

app.delete('/api/team/:id', requireRole('editor'), async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('DELETE FROM team_members WHERE id = ?', [id]);
  res.json({ ok: true });
  io.emit('team:updated');
});

app.post('/api/team/reorder', requireRole('editor'), async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array of ids' });
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    for (let idx = 0; idx < order.length; idx++) {
      await conn.query('UPDATE team_members SET sort_order = ? WHERE id = ?', [idx, order[idx]]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    conn.release();
    throw err;
  }
  conn.release();
  res.json({ ok: true });
});

app.post('/api/tasks/reorder', requireRole('editor'), async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array of ids' });
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    for (let idx = 0; idx < order.length; idx++) {
      await conn.query('UPDATE tasks SET sort_order = ? WHERE id = ?', [idx, order[idx]]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    conn.release();
    throw err;
  }
  conn.release();
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

app.post('/api/import/smartsheet', requireRole('admin'), async (req, res) => {
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
      } catch (err) { /* ignore — name collision etc. */ }
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
  let section10 = extractHours(findSection('10-'));
  let section40 = extractHours(findSection('40-'));
  let section50 = extractHours(findSection('50-'));

  // Fallback: the SDC pricing-sheet template (Active Proposals) uses a
  // horizontal grid instead of "10-/40-/50-" prefixed rows. Detect that
  // layout (header at rows 1-3, data at row 4, named columns: "PM", "ME
  // General", "Design and Drawings", "Software", "HMI", "Robot",
  // "Vision", "Database and Device", "Mechanical Build", "Electrical
  // Build", "MFG", then Testing/Teardown/Install pairs of "ME & CE" +
  // "MB & EB") and roll its hours into the same section_10/40/50 shape.
  const looksHorizontal = !findSection('10-') && rows.length >= 5 && rows[3] &&
    rows[3].some(c => /\bME General\b/i.test(String(c || ''))) &&
    rows[3].some(c => /\bMechanical Build\b/i.test(String(c || '')));
  if (looksHorizontal) {
    const header  = rows[3] || [];
    const dataRow = rows[4] || [];
    const colByLabel = (labelRe) => header.findIndex(c => labelRe.test(String(c || '').trim()));
    const val = (col) => col < 0 ? 0 : (Number(dataRow[col]) || 0);
    // Map each named header column. Multiple "ME & CE" / "MB & EB"
    // columns appear (Testing, Teardown, Install). Walk them in order.
    const allMeCe = header.map((c, i) => (/^ME & CE$/i.test(String(c || '').trim()) ? i : -1)).filter(i => i >= 0);
    const allMbEb = header.map((c, i) => (/^MB & EB$/i.test(String(c || '').trim()) ? i : -1)).filter(i => i >= 0);
    // Section 10 — design + build labor
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
    // Section 40 — Testing engineering (first ME & CE) + Testing shop
    // (first MB & EB). Dumps the lump into mech_eng / mech_build —
    // the variance modal sums those keys for the test_debug bucket so
    // the totals end up correct without needing per-discipline breakdown.
    section40 = {
      parts: 0, mech_eng: 0, ce_design: 0, ce_software: 0, ce_database: 0,
      gen_hmi: 0, gen_robot: 0, gen_vision: 0, gen_device: 0,
      mech_build: 0, elec_build: 0,
    };
    if (allMeCe[0] >= 0) section40.mech_eng   = val(allMeCe[0]);
    if (allMbEb[0] >= 0) section40.mech_build = val(allMbEb[0]);
    // Section 50 — Teardown engineering + shop (2nd ME&CE + MB&EB),
    // Install engineering + shop (3rd ME&CE + MB&EB). Sum eng-side
    // into mech_eng, shop-side into mech_build. Same lump approach.
    section50 = {
      parts: 0, mech_eng: 0, ce_design: 0, ce_software: 0, ce_database: 0,
      gen_hmi: 0, gen_robot: 0, gen_vision: 0, gen_device: 0,
      mech_build: 0, elec_build: 0,
    };
    if (allMeCe[1] >= 0) section50.mech_eng   += val(allMeCe[1]); // teardown eng
    if (allMbEb[1] >= 0) section50.mech_build += val(allMbEb[1]); // teardown shop
    if (allMeCe[2] >= 0) section50.mech_eng   += val(allMeCe[2]); // install eng
    if (allMbEb[2] >= 0) section50.mech_build += val(allMbEb[2]); // install shop
    // Parts cost — last numeric column with a big value (the "Parts Cost" header
    // sits to the right of the labor columns). Pick the FIRST data-row value
    // that's > 1000 past column 16.
    for (let i = 16; i < dataRow.length; i++) {
      const v = Number(dataRow[i]);
      if (Number.isFinite(v) && v > 1000) { section10.parts = v; break; }
    }
  }

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

app.post('/api/estimate/parse', requireRole('editor'), async (req, res) => {
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
app.get('/api/project/:project/quote', async (req, res) => {
  const key = `project_quote:${req.params.project}`;
  const [[row]] = await pool.query('SELECT value FROM settings WHERE `key` = ?', [key]);
  if (!row) return res.json(null);
  try { res.json(JSON.parse(row.value)); }
  catch { res.json(null); }
});

app.post('/api/project/:project/quote', requireRole('editor'), async (req, res) => {
  const key = `project_quote:${req.params.project}`;
  const value = JSON.stringify(req.body || {});
  await pool.query(
    'INSERT INTO settings (`key`, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
    [key, value]
  );
  res.json({ ok: true });
});
app.delete('/api/project/:project/quote', requireRole('editor'), async (req, res) => {
  await pool.query('DELETE FROM settings WHERE `key` = ?', [`project_quote:${req.params.project}`]);
  res.json({ ok: true });
});

app.post('/api/estimate/create', requireRole('admin'), async (req, res) => {
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

app.post('/api/import/schedule', requireRole('admin'), async (req, res) => {
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

// ---------- Baseline snapshot ----------
// "Setting a baseline" copies every task's current start_date + end_date into
// baseline_start_date + baseline_end_date for that project. Clearing wipes them
// back to null. The client overlays a dashed ghost at the baseline position on
// the Gantt and shows a drift chip so the user can see how much each bar has
// moved relative to the snapshot.

app.post('/api/baseline/set', requireRole('editor'), async (req, res) => {
  const project = (req.body.project || '').toString().trim();
  if (!project) return res.status(400).json({ error: 'project required' });
  const [result] = await pool.query(
    'UPDATE tasks SET baseline_start_date = start_date, baseline_end_date = end_date WHERE project = ?',
    [project]
  );
  res.json({ ok: true, baselined: result.affectedRows });
});

app.post('/api/baseline/clear', requireRole('editor'), async (req, res) => {
  const project = (req.body.project || '').toString().trim();
  if (!project) return res.status(400).json({ error: 'project required' });
  const [result] = await pool.query(
    'UPDATE tasks SET baseline_start_date = NULL, baseline_end_date = NULL WHERE project = ?',
    [project]
  );
  res.json({ ok: true, cleared: result.affectedRows });
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
app.post('/api/projects/:project/duplicate-machine', requireRole('editor'), async (req, res) => {
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
  // customPredecessors: per-source-id override map. After the auto-rewrite
  // pass, if a cloned row's source ID has an override, we replace the
  // pred string with the user-typed value verbatim — the user has direct
  // control. The keys may arrive as numbers OR strings depending on JSON.
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
app.delete('/api/projects/:project/machines/:machine', requireRole('editor'), async (req, res) => {
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

// ---------- Task comments + @mentions ----------
// Per-task threaded discussion. Comments are scoped to a task but also
// stamp the project for fast "all comments in this project" queries.
// @Name mentions in the body are extracted at POST time and stored as
// a JSON array — once Phase 3 (auth) + Phase 6 (email) land, each
// mention triggers a notification.
//
// Routes:
//   GET    /api/tasks/comment-counts?project=X — { taskId: count } map
//   GET    /api/tasks/:id/comments              — list comments for a task
//   POST   /api/tasks/:id/comments              — add a comment
//   DELETE /api/comments/:id                    — delete a comment

// Per-project comment counts in one query — fuels the small badge on
// each grid row without N+1 fetches.
app.get('/api/tasks/comment-counts', async (req, res) => {
  const project = (req.query.project || '').toString().trim();
  if (!project) return res.json({});
  const [rows] = await pool.query(
    'SELECT c.task_id, COUNT(*) AS cnt FROM task_comments c JOIN tasks t ON t.id = c.task_id WHERE t.project = ? GROUP BY c.task_id',
    [project]
  );
  const map = {};
  for (const r of rows) map[r.task_id] = r.cnt;
  res.json(map);
});

app.get('/api/tasks/:id/comments', async (req, res) => {
  const taskId = Number(req.params.id);
  const [rows] = await pool.query('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC', [taskId]);
  res.json(rows);
});

// Post a new comment. Auth (Phase 3) will set req.authUser; until then
// the author is anonymous. @Name mentions are detected against active
// team_members. Notifications are dropped to a notification_log row
// for future email delivery (Phase 6).
app.post('/api/tasks/:id/comments', requireRole('viewer'), async (req, res) => {
  const taskId = Number(req.params.id);
  const [[task]] = await pool.query('SELECT name, project FROM tasks WHERE id = ?', [taskId]);
  if (!task) return res.status(404).json({ error: 'task not found' });

  const body = (req.body.body || '').toString().trim();
  if (!body) return res.status(400).json({ error: 'body required' });

  // When AUTH_ENABLED=false, requireAuth fills req.authUser with the synthetic
  // dev user (id=0, name='anonymous'). Prefer the caller-supplied author_name
  // in that mode so client-side identity ("signed in" via /api/team) still
  // attributes correctly. Once auth lands, the real JWT name wins.
  const synthetic  = req.authUser && req.authUser.id === 0;
  const authorName = (!synthetic && req.authUser && req.authUser.name)
                     || (req.body.author_name || '').trim()
                     || (req.authUser && req.authUser.name)
                     || 'anonymous';
  const authorId   = (req.authUser && req.authUser.id) || null;

  const [knownNameRows] = await pool.query('SELECT name FROM team_members WHERE active = 1');
  const knownNames = knownNameRows.map(r => r.name).filter(Boolean);
  knownNames.sort((a, b) => b.length - a.length);
  const mentions = [];
  for (const name of knownNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('@' + escaped + '(?=[^a-zA-Z]|$)', 'i').test(body) && !mentions.includes(name)) {
      mentions.push(name);
    }
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const [r] = await pool.query(
    'INSERT INTO task_comments (task_id, project, author_id, author_name, body, mentions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [taskId, task.project, authorId, authorName, body, JSON.stringify(mentions), now, now]
  );

  const [[comment]] = await pool.query('SELECT * FROM task_comments WHERE id = ?', [r.insertId]);
  res.status(201).json(comment);

  // Phase 4: fan out a real-time event so other tabs refresh the badge count.
  io.emit('comments:updated', { taskId, project: task.project });

  // Phase 7: fire a mention email per @mentioned user. Looks up the user's
  // email from the users table by exact name match. Falls back to the
  // team_members row if no user account exists yet. Best-effort — failures
  // never block the comment POST.
  for (const name of mentions) {
    try {
      const [[userRow]] = await pool.query('SELECT email FROM users WHERE name = ? AND active = 1', [name]);
      const to = userRow ? userRow.email : null;
      if (to && emailSvc && emailSvc.sendMentionEmail) {
        emailSvc.sendMentionEmail({
          db, to, taskId, taskName: task.name, project: task.project,
          commentBody: body, authorName,
        }).catch(() => {});
      }
    } catch (_) {}
  }
});

// Delete a comment. Until auth lands anyone can delete (single-user
// trust model); Phase 3 adds an own-comment-or-admin gate.
app.delete('/api/comments/:id', requireRole('viewer'), async (req, res) => {
  const id = Number(req.params.id);
  const [[comment]] = await pool.query('SELECT * FROM task_comments WHERE id = ?', [id]);
  if (!comment) return res.status(404).json({ error: 'not found' });
  await pool.query('DELETE FROM task_comments WHERE id = ?', [id]);
  res.json({ ok: true });
});

// ---------- Audit trail (task_history) ----------
// Chronological log of every task create / update / delete. Each row
// has the full BEFORE and AFTER snapshot plus a comma-separated list
// of which columns changed. Use this to answer "who changed what when"
// or to roll a project back to a prior state.
//
// GET /api/tasks/history?project=<name>&limit=<n>
//   project — required; filter to one project.
//   limit   — optional; max rows to return (default 200, max 1000).
app.get('/api/tasks/history', async (req, res) => {
  const project = (req.query.project || '').toString().trim();
  if (!project) return res.status(400).json({ error: 'project required' });
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const [rows] = await pool.query(
    'SELECT * FROM task_history WHERE project = ? ORDER BY changed_at DESC LIMIT ?',
    [project, limit]
  );
  res.json(rows);
});

// ---------- Project financial milestones ----------
// Independent from tasks. Each row belongs to a single project and represents a
// payment event (Down Payment, FAT acceptance, etc.). The client overlays these on
// the Gantt when the $ Financial toggle is on; they don't live in the task grid.
const FIN_FIELDS = ['name', 'percent', 'amount', 'due_date', 'paid', 'predecessors', 'sync_to_anchor', 'sort_order'];

app.get('/api/financials', async (req, res) => {
  const project = (req.query.project || '').toString();
  const [rows] = project
    ? await pool.query('SELECT * FROM project_financials WHERE project = ? ORDER BY sort_order, id', [project])
    : await pool.query('SELECT * FROM project_financials ORDER BY project, sort_order, id');
  res.json(rows);
});

app.post('/api/financials', requireRole('editor'), async (req, res) => {
  const project = (req.body.project || '').toString().trim();
  if (!project) return res.status(400).json({ error: 'project required' });
  const name = (req.body.name || '').toString().trim();
  const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_financials WHERE project = ?', [project]);
  const [result] = await pool.query(
    'INSERT INTO project_financials (project, name, percent, amount, due_date, paid, predecessors, sync_to_anchor, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [project, name,
     req.body.percent != null ? Number(req.body.percent) : null,
     req.body.amount  != null ? Number(req.body.amount)  : null,
     req.body.due_date || null,
     req.body.paid ? 1 : 0,
     req.body.predecessors || null,
     req.body.sync_to_anchor || null,
     maxRow.m + 1]
  );
  const [[row]] = await pool.query('SELECT * FROM project_financials WHERE id = ?', [result.insertId]);
  res.json(row);
});

app.put('/api/financials/:id', requireRole('editor'), async (req, res) => {
  const id = Number(req.params.id);
  const [[existing]] = await pool.query('SELECT * FROM project_financials WHERE id = ?', [id]);
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
  await pool.query(`UPDATE project_financials SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
  const [[row]] = await pool.query('SELECT * FROM project_financials WHERE id = ?', [id]);
  res.json(row);
});

app.delete('/api/financials/:id', requireRole('editor'), async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('DELETE FROM project_financials WHERE id = ?', [id]);
  res.json({ ok: true });
});

app.post('/api/financials/seed', requireRole('editor'), async (req, res) => {
  const project = (req.body.project || '').toString().trim();
  if (!project) return res.status(400).json({ error: 'project required' });
  const [[existingFin]] = await pool.query('SELECT COUNT(*) AS n FROM project_financials WHERE project = ?', [project]);
  if (existingFin.n > 0) return res.json({ ok: true, seeded: 0 });
  const [[defRow]] = await pool.query("SELECT value FROM settings WHERE `key` = 'default_financial_milestones'");
  let defaults = [];
  try { defaults = JSON.parse(defRow?.value || '[]'); } catch { defaults = []; }
  for (let i = 0; i < defaults.length; i++) {
    const d = defaults[i];
    await pool.query(
      'INSERT INTO project_financials (project, name, percent, amount, due_date, paid, predecessors, sync_to_anchor, sort_order) VALUES (?, ?, ?, NULL, NULL, 0, ?, ?, ?)',
      [project, d.name, d.percent != null ? Number(d.percent) : null, d.predecessors || null, d.sync_to_anchor || null, i]
    );
  }
  res.json({ ok: true, seeded: defaults.length });
});

// ── Shop Parts (Parts in Shop) — PM-facing list of parts at the SDC shop ─────
const SHOP_PART_FIELDS = ['rank', 'job', 'qty', 'part_no', 'description', 'shop_release', 'new_mod', 'location', 'out_for_finishing', 'priority', 'comments', 'engineer', 'pm', 'added_to_bom', 'part_complete', 'sort_order'];
const _shopBool = (f) => f === 'added_to_bom' || f === 'part_complete';

app.get('/api/shop-parts', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM shop_parts ORDER BY sort_order, `rank`, id');
  res.json(rows);
});

app.post('/api/shop-parts', requireRole('editor'), async (req, res) => {
  const b = req.body || {};
  const cols = [], vals = [];
  for (const f of SHOP_PART_FIELDS) {
    if (f in b) { cols.push(f); vals.push(_shopBool(f) ? (b[f] ? 1 : 0) : (b[f] === undefined ? null : b[f])); }
  }
  if (!cols.includes('sort_order')) {
    const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM shop_parts');
    cols.push('sort_order'); vals.push(maxRow.m + 1);
  }
  const [result] = await pool.query(
    `INSERT INTO shop_parts (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    vals
  );
  const [[row]] = await pool.query('SELECT * FROM shop_parts WHERE id = ?', [result.insertId]);
  res.json(row);
  io.emit('shop_parts:updated');
});

app.put('/api/shop-parts/:id', requireRole('editor'), async (req, res) => {
  const id = Number(req.params.id);
  const [[existing]] = await pool.query('SELECT * FROM shop_parts WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const updates = {};
  for (const f of SHOP_PART_FIELDS) {
    if (f in req.body) updates[f] = _shopBool(f) ? (req.body[f] ? 1 : 0) : (req.body[f] === undefined ? null : req.body[f]);
  }
  if (Object.keys(updates).length === 0) return res.json(existing);
  // Stamp / clear the completion timestamp when part_complete flips.
  if ('part_complete' in updates) {
    if (updates.part_complete && !existing.part_complete) updates.completed_on = new Date().toISOString();
    else if (!updates.part_complete) updates.completed_on = null;
  }
  const setClause = Object.keys(updates).map(k => `\`${k}\` = ?`).join(', ');
  await pool.query(`UPDATE shop_parts SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
  const [[row]] = await pool.query('SELECT * FROM shop_parts WHERE id = ?', [id]);
  res.json(row);
  io.emit('shop_parts:updated');
});

app.delete('/api/shop-parts/:id', requireRole('editor'), async (req, res) => {
  await pool.query('DELETE FROM shop_parts WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
  io.emit('shop_parts:updated');
});

app.post('/api/shop-parts/reorder', requireRole('editor'), async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array of ids' });
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    for (let idx = 0; idx < order.length; idx++) {
      await conn.query('UPDATE shop_parts SET sort_order = ? WHERE id = ?', [idx, order[idx]]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    conn.release();
    throw err;
  }
  conn.release();
  res.json({ ok: true });
});

// ── Vendor POs (Vendor PO Track) — POs sent to outside vendors ──────────────
const VPO_FIELDS = ['priority', 'po', 'job', 'vendor', 'po_date', 'lead_time', 'eta', 'ship_date', 'delivery_date', 'tracking', 'po_price', 'pm', 'comments', 'partial', 'complete', 'sort_order'];
const _vpoBool = (f) => f === 'partial' || f === 'complete';

app.get('/api/vendor-pos', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM vendor_pos ORDER BY sort_order, priority, id');
  res.json(rows);
});

app.post('/api/vendor-pos', requireRole('editor'), async (req, res) => {
  const b = req.body || {};
  const cols = [], vals = [];
  for (const f of VPO_FIELDS) {
    if (f in b) { cols.push(f); vals.push(_vpoBool(f) ? (b[f] ? 1 : 0) : (b[f] === undefined ? null : b[f])); }
  }
  if (!cols.includes('sort_order')) {
    const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM vendor_pos');
    cols.push('sort_order'); vals.push(maxRow.m + 1);
  }
  const [result] = await pool.query(
    `INSERT INTO vendor_pos (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    vals
  );
  const [[row]] = await pool.query('SELECT * FROM vendor_pos WHERE id = ?', [result.insertId]);
  res.json(row);
  io.emit('vendor_pos:updated');
});

app.put('/api/vendor-pos/:id', requireRole('editor'), async (req, res) => {
  const id = Number(req.params.id);
  const [[existing]] = await pool.query('SELECT * FROM vendor_pos WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const updates = {};
  for (const f of VPO_FIELDS) {
    if (f in req.body) updates[f] = _vpoBool(f) ? (req.body[f] ? 1 : 0) : (req.body[f] === undefined ? null : req.body[f]);
  }
  if (Object.keys(updates).length === 0) return res.json(existing);
  if ('complete' in updates) {
    if (updates.complete && !existing.complete) updates.completed_on = new Date().toISOString();
    else if (!updates.complete) updates.completed_on = null;
  }
  const setClause = Object.keys(updates).map(k => `\`${k}\` = ?`).join(', ');
  await pool.query(`UPDATE vendor_pos SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
  const [[row]] = await pool.query('SELECT * FROM vendor_pos WHERE id = ?', [id]);
  res.json(row);
  io.emit('vendor_pos:updated');
});

app.delete('/api/vendor-pos/:id', requireRole('editor'), async (req, res) => {
  await pool.query('DELETE FROM vendor_pos WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
  io.emit('vendor_pos:updated');
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
app.get('/api/projects', async (_req, res) => {
  const [rows] = await pool.query('SELECT * FROM projects ORDER BY name ASC');
  res.json(rows);
});

app.post('/api/projects', requireRole('editor'), async (req, res) => {
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
});

app.put('/api/projects/:id', requireRole('editor'), async (req, res) => {
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
  }

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await pool.query(`UPDATE projects SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
  const [[row]] = await pool.query('SELECT * FROM projects WHERE id = ?', [id]);
  res.json(row);
  notifyClients('projects_changed');
});

app.delete('/api/projects/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const [[existing]] = await pool.query('SELECT * FROM projects WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'not found' });
  await pool.query('DELETE FROM tasks WHERE project = ?', [existing.name]);
  await pool.query('DELETE FROM project_financials WHERE project = ?', [existing.name]);
  await pool.query('DELETE FROM projects WHERE id = ?', [id]);
  res.json({ ok: true });
  notifyClients('projects_changed');
});

app.post('/api/projects/ensure', requireRole('editor'), async (req, res) => {
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  await pool.query('INSERT IGNORE INTO projects (name) VALUES (?)', [name]);
  const [[row]] = await pool.query('SELECT * FROM projects WHERE name = ?', [name]);
  res.json(row);
});

// ─── Sales → detailed project promotion ────────────────────────────────────
// Takes an existing sales schedule, stamps a fresh project from
// SDC_StandardProject_Template, carries the saved quote over, and applies
// people-math: sales `1.25 mech_eng` people becomes 1 ME row at standard
// allocation + 1 ME row at 25% allocation (Dan rule). Durations recompute
// so total hours per discipline match the sales quote, then cascadeSchedule
// fills in start/end dates.
//
// POST /api/project/:source/promote
// Body: { newName }
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

// Sales-mode bucket sums. A sales-mode "ce_engineering" people # rolls down
// to all detailed CE buckets (design / drawings / software); same for
// gen_engineering → hmi/robot/vision and elec_build → wire_panel/wire_machine.
const _PROMOTE_PEOPLE_FANOUT = {
  ce_engineering:  ['ce_engineering', 'ce_design', 'ce_drawings', 'ce_software'],
  gen_engineering: ['gen_engineering', 'gen_hmi', 'gen_robot', 'gen_vision'],
  elec_build:      ['elec_build', 'wire_panel', 'wire_machine', 'wire_other'],
};

// Discipline-default allocation per bucket (Dan rule). Engineering disciplines
// run at 85%; shop/build/wire run at 90%; testing engineering at 85%; shop
// testing at 90%. These match the standard template's defaults.
function _promoteDefaultAlloc(bucket) {
  if (!bucket) return 90;
  if (bucket === 'configure' || bucket === 'test_debug') return 85;
  if (bucket === 'shop_debug') return 90;
  if (bucket === 'mech_eng' || bucket.startsWith('ce_') || bucket.startsWith('gen_')) return 85;
  return 90;
}

app.post('/api/project/:source/promote', requireRole('editor'), async (req, res) => {
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

  // Hours per bucket from the parsed estimate sheet — same math as the
  // Quote vs Schedule modal does at render time.
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

  // Resolve effective people count per detailed bucket — fans out the
  // sales-mode aggregate disciplines (ce_engineering / gen_engineering /
  // elec_build) to their detailed sub-buckets when the user typed the
  // sales-level value but the template uses the detailed names.
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
    // People-allocation distribution. Each task in the bucket gets one
    // "slot." Slots 1..floor(people) get baseAlloc; slot floor+1 (if a
    // fractional remainder exists) gets fractional*100; remaining slots
    // get baseAlloc too (template might have more rows than we expected;
    // safer to keep them at default than to zero them out).
    const fullSlots = Math.floor(people);
    const fracSlot  = Math.round((people - fullSlots) * 100);
    let dailyHourCapacity = 0;
    const slotAllocs = tasks.map((_, idx) => {
      if (idx < fullSlots)            return baseAlloc;
      if (idx === fullSlots && fracSlot > 0) return fracSlot;
      return baseAlloc;
    });
    for (const a of slotAllocs) dailyHourCapacity += 8 * (a / 100);
    // Skip duration override when we have no quoted hours OR no capacity
    // (leave template defaults in place — the user can dial it in via the
    // Quote vs Schedule modal).
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
  sync('tasks');
});

// ─── Phase 3 (Auth) — user management (admin only) ────────────────────────
// Ported from Abhi's feature/smartsheet-architecture branch. Lets an admin
// list, create, edit, and soft-delete (active=0) users without touching the
// CLI. Authentication itself still flows through /api/auth/login.
app.get('/api/users', requireRole('admin'), async (_req, res) => {
  const [rows] = await pool.query('SELECT id,email,name,role,active,created_at,last_login,avatar_color FROM users ORDER BY name');
  res.json(rows);
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  const { email, name, password, role = 'editor', avatar_color = '#1574c4' } = req.body || {};
  if (!email || !name || !password) return res.status(400).json({ error: 'email, name, password required' });
  if (!['viewer', 'editor', 'admin'].includes(role)) return res.status(400).json({ error: 'invalid role' });
  if (String(password).length < 1) return res.status(400).json({ error: 'password is required' });
  try {
    const [r] = await pool.query(
      'INSERT INTO users (email,name,password_hash,role,active,avatar_color) VALUES (?,?,?,?,1,?)',
      [email.toLowerCase().trim(), name.trim(), bcrypt.hashSync(password, 12), role, avatar_color]
    );
    io.emit('users:updated');
    const [[newUser]] = await pool.query('SELECT id,email,name,role,active,avatar_color FROM users WHERE id=?', [r.insertId]);
    res.status(201).json(newUser);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' || String(e.message).includes('Duplicate entry') || String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered.' });
    res.status(500).json({ error: 'Failed to create user: ' + e.message });
  }
});

app.put('/api/users/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const [[u]] = await pool.query('SELECT * FROM users WHERE id=?', [id]);
  if (!u) return res.status(404).json({ error: 'not found' });
  const allowed = ['email', 'name', 'role', 'active', 'avatar_color'];
  const upd = {};
  for (const k of allowed) {
    if (req.body[k] === undefined) continue;
    upd[k] = (k === 'active') ? (req.body[k] ? 1 : 0) : req.body[k];
  }
  if (req.body.password) upd.password_hash = bcrypt.hashSync(req.body.password, 12);
  if (!Object.keys(upd).length) return res.json(u);
  const setClause = Object.keys(upd).map(k => `${k}=?`).join(',');
  await pool.query(`UPDATE users SET ${setClause} WHERE id=?`, [...Object.values(upd), id]);
  io.emit('users:updated');
  const [[updUser]] = await pool.query('SELECT id,email,name,role,active,avatar_color FROM users WHERE id=?', [id]);
  res.json(updUser);
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
  await pool.query('UPDATE users SET active=0 WHERE id=?', [Number(req.params.id)]);
  io.emit('users:updated');
  res.json({ ok: true });
});

// Health check — used by Electron shell to detect server readiness
app.get('/health', (_req, res) => res.json({ ok: true, service: 'scheduler' }));

// Global error handler — catches unhandled promise rejections from async routes
// (Express 4 does not auto-catch async throws without this)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[scheduler] Unhandled route error:', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// ── Exportable entry point (used by Electron in-process execution) ────────────
async function startServer({ port } = {}) {
  const p = port || PORT;
  // Init MySQL schema (creates tables if they don't exist, then seeds defaults)
  const dbModule = require('./db');
  await dbModule.init();
  await dbModule.seedDefaults(pool);
  // Phase 4: listen on the http.Server we wrapped above so Socket.io's
  // upgrade handler is attached. Express alone won't carry the socket layer.
  server.listen(p, '0.0.0.0', () => {
    console.log(`[scheduler] Running at http://localhost:${p}`);
    if (AUTH_ENABLED) console.log('[scheduler] Auth: ENABLED — JWT required for /api/*');
    else              console.log('[scheduler] Auth: DISABLED — set AUTH_ENABLED=true in .env to require login');
  });
  server.on('error', err => console.error('[scheduler] Server error:', err.message));
  // Phase 7 (email): kick off any scheduled cron jobs (digest emails etc.).
  // Wrapped in typeof check so a missing cronJobs.js doesn't crash boot.
  try {
    const cron = require('./cronJobs');
    if (cron && typeof cron.start === 'function') cron.start({ pool, emailSvc });
  } catch (_) { /* cronJobs.js is optional */ }
  startRepoAutoSync();
  return server;
}

// ── Repo auto-sync ────────────────────────────────────────────────────────────
// Replaces scripts/repo-sync.js, which broke when PM2 moved to a SYSTEM
// service: SYSTEM isn't the repo owner (git "dubious ownership"), has no git
// identity, and has no GitHub credentials — and the scripts/ files are
// SYSTEM-ACL-locked so the script itself can't be patched. This runs the same
// job in-process instead: when the auto-updater pulls new files from Dan's
// repo, commit + push them to origin so the centralized repo tracks Dan's
// version. Lives here because server.js is on the updater's preserved list
// and the app already runs as SYSTEM. Disable with REPO_AUTO_SYNC=off.
function startRepoAutoSync() {
  if ((process.env.REPO_AUTO_SYNC || '').toLowerCase() === 'off') return;
  const { execSync } = require('child_process');
  const repoRoot = path.join(__dirname, '..');
  if (!fs.existsSync(path.join(repoRoot, '.git'))) return; // Electron / standalone installs have no repo

  // Everything the auto-updater writes (SAFE_DIRS + SAFE_FILES + dep merge).
  // ⚠ custom-public/ excluded — it holds only local-only files (app-local.js);
  //   committing Dan's files from there spreads stale shadow files to the repo.
  // ⚠ scripts/repo-sync.js excluded — monorepo infrastructure we own; Dan's
  //   version must not overwrite our SYNC_PATHS additions.
  const SYNC_PATHS = [
    'SDC_Scheduler/public',
    'SDC_Scheduler/auth.js', 'SDC_Scheduler/emailService.js',
    'SDC_Scheduler/package.json', 'SDC_Scheduler/package-lock.json',
    'SDC_Scheduler/ARROW_ROUTING_RULES.md', 'SDC_Scheduler/.gitignore',
  ];
  // safe.directory: git runs as SYSTEM but the repo is owned by a user account.
  // credential store file: SYSTEM has no credential-manager entries; the file is
  // ACL-locked to SYSTEM/Administrators/akamuju.
  const GIT_FLAGS = `-c safe.directory="${repoRoot.replace(/\\/g, '/')}"`
    + ' -c user.name="SDC Repo Sync" -c user.email="repo-sync@stevendouglas.local"'
    + ' -c credential.helper= -c "credential.helper=store --file=C:/ProgramData/SDC_Scheduler/git-credentials"';
  const git = (args) => execSync(`git -C "${repoRoot}" ${GIT_FLAGS} ${args}`, { stdio: 'pipe', timeout: 60000 }).toString().trim();

  let lastError = '';
  const tick = () => {
    try {
      git(`add ${SYNC_PATHS.map(s => `"${s}"`).join(' ')}`);
      let staged = true;
      try { git('diff --cached --quiet'); staged = false; } catch { staged = true; }
      if (!staged) return;
      let danSha = 'unknown';
      try { danSha = fs.readFileSync(path.join(__dirname, '.update-sha'), 'utf8').trim().slice(0, 7); } catch {}
      git(`commit -m "chore(scheduler): sync from danbelliveau2@${danSha}"`);
      git('push origin master');
      lastError = '';
      console.log(`[repo-sync] Committed and pushed scheduler sync (danbelliveau2@${danSha}).`);
    } catch (e) {
      // Log each distinct failure once — not every 5 minutes forever.
      const msg = (e.stderr ? e.stderr.toString() : e.message || '').trim().slice(0, 300);
      if (msg !== lastError) { lastError = msg; console.error(`[repo-sync] ${msg}`); }
    }
  };
  setTimeout(tick, 30 * 1000);            // first pass shortly after boot (updater restarts us post-pull)
  setInterval(tick, 5 * 60 * 1000);
  console.log('[repo-sync] In-process repo auto-sync armed (every 5 min).');
}

if (require.main === module) {
  startServer().then(_server => {
    process.on('SIGTERM', () => {
      console.log('[scheduler] SIGTERM — shutting down gracefully');
      _server.close(() => process.exit(0));
    });
  }).catch(err => {
    console.error('[scheduler] Startup failed:', err.message);
    process.exit(1);
  });
}
module.exports = { startServer };
