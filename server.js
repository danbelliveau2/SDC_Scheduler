/**
 * server.js — SDC Scheduler Express + Socket.io app (thin orchestrator).
 *
 * Route groups live in routes/. This file handles:
 *   1. Setup        — express, http.Server, socket.io, presence, middleware
 *   2. Auth routes  — mounted BEFORE requireAuth guard (public)
 *   3. Global auth + active-user cache middleware
 *   4. Scheduling engine — parsePredecessorRef, addBusinessDays, cascadeSchedule, logHistory
 *   5. Route mounting — all route groups
 *   6. /health, /api/status, /api/backup
 *   7. startServer(), SIGTERM, db/cron bootstrap
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
const { requireAuth, requireRole, signToken, AUTH_ENABLED } = require('./lib/auth');
const ops = require('./lib/ops'); // backups, health/status, crash logging
const agent = require('./lib/agent'); // local-Ollama read-only assistant
let hoursApi;
try { hoursApi = require('./lib/hoursApi'); } catch (_) { hoursApi = { ENABLED: false, getJobHours: () => Promise.reject(new Error('not configured')) }; }
let emailSvc;
try { emailSvc = require('./lib/emailService'); }
catch (_) { emailSvc = { sendMentionEmail: () => {}, sendDigest: () => {} }; }

const app = express();
const PORT = process.env.PORT || 3000;

// Phase 4 (Socket.io): wrap Express in HTTP server and attach Socket.io
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: '*' } });

// Presence tracking: project → Map<socketId, { name, avatar_color, id }>.
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
// Exclude SSE endpoints — compression buffers chunks waiting for a flush size,
// which silently kills server-sent events (text deltas never reach the client).
app.use(compression({ filter: (req, res) => /\/(ask-stream|sse)\b/.test(req.path) ? false : compression.filter(req, res) }));

app.use(express.json({ limit: '10mb' }));

// Static assets: use `no-cache` (NOT no-store) so the browser revalidates
// every request via ETag / Last-Modified.
app.use((req, res, next) => {
  if (req.path.match(/\.(js|css|svg|png|jpg|ico|woff2?)(\?|$)/)) {
    res.set('Cache-Control', 'no-cache');
  } else {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
// Serve auth-ui.js with minlength patched to 1.
app.get('/auth-ui.js', (req, res) => {
  const src = fs.existsSync(path.join(__dirname, 'public', 'auth-ui.js'))
    ? path.join(__dirname, 'public', 'auth-ui.js')
    : path.join(__dirname, 'custom-public', 'auth-ui.js');
  const content = fs.readFileSync(src, 'utf8').replace(/minlength="6"/g, 'minlength="1"');
  res.type('application/javascript').send(content);
});
// public/ is CANONICAL; custom-public/ is fallback only.
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true }));
app.use(express.static(path.join(__dirname, 'custom-public'), { etag: true, lastModified: true }));

// ─── Public auth routes (BEFORE global requireAuth guard) ──────────────────
app.use(require('./routes/auth')({ pool, io, requireAuth, signToken, bcrypt, AUTH_ENABLED }));

// Public capability probe — no auth needed, frontend uses this to show/hide the Job Hours drawer
app.get('/api/hours/status', (_req, res) => res.json({ enabled: hoursApi.ENABLED }));

// Global auth guard — every /api/* request below this line goes through it.
app.use(requireAuth);

// Active-flag check: JWT tokens can outlive a user's active=0 status.
// Re-checks the DB on every authenticated request; 60-second in-memory cache.
const _activeCache = new Map(); // userId → { active, expiresAt }
const ACTIVE_CACHE_TTL_MS = 60_000;
app.use(async (req, res, next) => {
  if (!req.authUser || !req.authUser.id || req.authUser.id === 0) return next();
  const cached = _activeCache.get(req.authUser.id);
  if (cached && Date.now() < cached.expiresAt) {
    if (!cached.active) return res.status(403).json({ error: 'Your account has been disabled. Contact an admin.', code: 'ACCOUNT_DISABLED' });
    return next();
  }
  try {
    const [[u]] = await pool.query('SELECT active FROM users WHERE id = ?', [req.authUser.id]);
    const active = u ? !!u.active : false;
    _activeCache.set(req.authUser.id, { active, expiresAt: Date.now() + ACTIVE_CACHE_TTL_MS });
    if (!active) return res.status(403).json({ error: 'Your account has been disabled. Contact an admin.', code: 'ACCOUNT_DISABLED' });
  } catch (_) { /* DB error — fail open so a DB hiccup doesn't lock everyone out */ }
  next();
});

// ---------- Schedule auto-computation (FS/SS/FF/SF + lag) ----------
// All scheduling is done in BUSINESS DAYS (Mon–Fri).
function parsePredecessorRef(s) {
  // Accepts half-week decimals too, e.g. "5FF -5.5w" (27.5 bd → rounds to 28).
  const m = String(s || '').trim().match(/^(\d+)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+(?:\.\d+)?)?\s*([wd])?$/i);
  if (!m) return null;
  const id = Number(m[1]);
  const type = (m[2] || 'FS').toUpperCase();
  let lagDays = 0;
  if (m[3]) {
    const n = Number(m[3].replace(/\s+/g, ''));
    lagDays = Math.round((m[4] || 'd').toLowerCase() === 'w' ? n * 5 : n);
  }
  return { id, type, lagDays };
}

function isWeekend(d) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

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
      case 'FS': cStart = addBusinessDaysISO(pred.end_date,   1 + p.lagDays); break;
      case 'SS': cStart = addBusinessDaysISO(pred.start_date, p.lagDays);     break;
      case 'FF': cEnd   = addBusinessDaysISO(pred.end_date,   p.lagDays);     break;
      case 'SF': cEnd   = addBusinessDaysISO(pred.start_date, p.lagDays);     break;
    }
    if (cStart && (!start || cStart > start)) start = cStart;
    if (cEnd   && (!end   || cEnd   > end))   end   = cEnd;
  }

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

// ── ETO DB (needed by eto + agent routes) ─────────────────────────────────
const etoDb = require('./lib/etoDb');

// ── Route mounting ─────────────────────────────────────────────────────────
const routeDeps = { pool, io, requireRole, requireAuth, cascadeSchedule, logHistory, etoDb, ops, agent, hoursApi, emailSvc, bcrypt, _activeCache };

app.use(require('./routes/users')(    { ...routeDeps }));
app.use(require('./routes/tasks')(    { ...routeDeps }));
app.use(require('./routes/team')(     { ...routeDeps }));
app.use(require('./routes/settings')( { ...routeDeps }));
app.use(require('./routes/shopParts')({ ...routeDeps }));
app.use(require('./routes/vendorPos')({ ...routeDeps }));
app.use(require('./routes/financials')({ ...routeDeps }));
app.use(require('./routes/eto')(      { ...routeDeps }));
app.use(require('./routes/agent')(    { ...routeDeps }));
app.use(require('./routes/hours')(    { ...routeDeps }));
app.use(require('./routes/projects')( { ...routeDeps }));

// ── Health + status + backup ───────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    const s = await ops.getStatus(pool);
    res.json({ ok: s.ok, service: 'scheduler', uptimeSeconds: s.uptimeSeconds, db: { ok: s.db.ok } });
  } catch (e) { res.status(503).json({ ok: false, service: 'scheduler', error: e.message }); }
});

app.get('/api/status', requireAuth, async (_req, res) => {
  try { res.json(await ops.getStatus(pool)); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.post('/api/backup', requireRole('admin'), async (_req, res) => {
  try {
    const r = await ops.runBackup();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[scheduler] Unhandled route error:', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// ── Exportable entry point (used by Electron in-process execution) ─────────
async function startServer({ port } = {}) {
  const p = port || PORT;
  const dbModule = require('./db');
  await dbModule.init();
  await dbModule.seedDefaults(pool);
  server.listen(p, '0.0.0.0', () => {
    console.log(`[scheduler] Running at http://localhost:${p}`);
    if (AUTH_ENABLED) console.log('[scheduler] Auth: ENABLED — JWT required for /api/*');
    else              console.log('[scheduler] Auth: DISABLED — set AUTH_ENABLED=true in .env to require login');
  });
  server.on('error', err => console.error('[scheduler] Server error:', err.message));
  try {
    const cron = require('./lib/cronJobs');
    if (cron && typeof cron.start === 'function') cron.start({ pool, emailSvc, etoDb, io, ops, hoursApi });
  } catch (_) { /* cronJobs.js is optional */ }
  try {
    const { backfillProjects } = require('./lib/backfillProjects');
    backfillProjects(pool, etoDb)
      .then(r => { if (r && (r.registered || r.linked)) { try { /* notifyClients moved to projects router */ } catch (_) {} } })
      .catch(e => console.warn('[backfill] failed:', e.message));
  } catch (_) { /* backfillProjects.js is optional */ }

  // Warm up Power BI hours cache for all active projects 30s after startup.
  // Runs silently in background — errors are ignored so startup is never blocked.
  if (hoursApi.ENABLED) {
    setTimeout(async () => {
      try {
        const [rows] = await pool.query(`SELECT hours_job_id, job_number FROM projects WHERE status = 'active' AND (hours_job_id IS NOT NULL OR job_number IS NOT NULL)`);
        const ids = [...new Set(rows.map(r => (r.hours_job_id || r.job_number || '').trim()).filter(Boolean))];
        console.log(`[hoursApi] warmup starting for ${ids.length} job(s):`, ids.join(', '));
        for (const id of ids) await hoursApi.getJobHours(id).catch(() => {});
        console.log('[hoursApi] warmup complete');
      } catch (e) { console.warn('[hoursApi] warmup failed:', e.message); }
    }, 5_000);
  }

  return server;
}

process.on('uncaughtException', (err) => {
  console.error('[scheduler] UNCAUGHT EXCEPTION — exiting for clean PM2 restart:', err && err.stack || err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[scheduler] UNHANDLED REJECTION:', reason && reason.stack || reason);
});

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
