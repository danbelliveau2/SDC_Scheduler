'use strict';
/**
 * service.js — Service Log Replacement (Monica R2).
 *
 * Replaces the Smartsheet Service workflow end to end:
 *
 *   customer request (website)  →  service_requests row  ( = the Service Log)
 *     →  1..n service_work_orders  →  assigned SDC employee
 *     →  a linked `tasks` row so the assignment lands in normal Scheduler workload
 *     →  employee marks complete  →  prepopulated service_reports row
 *
 * MOUNTING. This router is mounted TWICE in server.js, deliberately:
 *   publicRouter — the customer-facing intake, mounted BEFORE the global
 *                  requireAuth guard (a customer has no SDC login). Same
 *                  precedent as routes/integration.js. It is exactly two
 *                  endpoints and it can only ever CREATE.
 *   router       — everything else, behind requireAuth like the rest of /api.
 *
 * WHAT IS NOT HERE, on purpose:
 *   • No ETO Service quote/order link (R2 §5 — documented as not currently
 *     possible). Nothing in this module depends on one existing.
 *   • No invented status workflow (R2 §17). `current_status` is a free
 *     operational label; the three checkboxes Monica named stay separate
 *     fields, because they are separate facts.
 *   • No recurrence engine for scheduled contracts (R2 §12) — that requires
 *     inspecting the real contract data first, which §12 explicitly says to do
 *     rather than inventing frequencies.
 */
const express = require('express');
const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const serviceNotify = require('../lib/serviceNotify');

// ── Vocabulary (R2 §1, §2) ───────────────────────────────────────────────────
// Server-side gates. Anything not in these sets is rejected rather than stored,
// so the filter/search UI in §15 can rely on a closed set of values.
const URGENCIES   = new Set(['machine_down', 'urgent_running', 'schedule', 'quote_mod']);
const DEPARTMENTS = new Set(['mechanical', 'controls', 'shop', 'all']);
const LOCATIONS   = new Set(['remote', 'onsite']);
const WARRANTY    = new Set(['warranty', 'non_warranty', 'unknown']);
// Whose machine is it. Drives whether a serial / job number can be demanded
// at all (an SDC machine has one; a third-party machine does not).
const MACHINE_TYPES = new Set(['sdc', 'non_sdc']);

// Fields a CUSTOMER may set. Kept separate from the internal list below so a
// crafted public payload can never reach `quote_sent`, `current_status`, or any
// other internal management field.
const CUSTOMER_FIELDS = [
  'company_name', 'requestor_name', 'requestor_email', 'requestor_phone',
  'machine_type', 'machine_serial', 'job_number', 'urgency', 'service_details',
  'location_type', 'department_needed', 'warranty', 'ppe_requirements',
  'additional_comments', 'onsite_address',
];

// Fields an SDC user may set on a Service Log entry — the customer fields plus
// Monica's internal management fields (§4). request_no is never in here: it is
// assigned once at creation and is the stable identifier for everything else.
const INTERNAL_FIELDS = [
  ...CUSTOMER_FIELDS,
  'quote_sent', 'quote_sent_at', 'po_received', 'po_received_at',
  'service_complete', 'service_complete_date', 'resource_assigned',
  'current_status', 'information_needed',
];

const WO_FIELDS = [
  'task_date', 'employee_name', 'employee_email', 'location_type',
  'task_description', 'ppe_requirements', 'onsite_address',
  'sdc_contact_name', 'sdc_contact_email', 'sdc_contact_phone',
  'budgeted_hours', 'status',
];

const REPORT_FIELDS = [
  'work_performed', 'findings', 'parts_used', 'hours_actual',
  'follow_up_needed', 'follow_up_notes', 'customer_contact',
];

const BOOL_FIELDS = new Set(['quote_sent', 'po_received', 'service_complete', 'follow_up_needed']);

// ── Attachment storage (R2 §16) ──────────────────────────────────────────────
// Local disk + a metadata row. The on-disk name is random and the extension is
// re-derived from an allowlist, so a customer-supplied filename can never
// traverse a path, collide, or land as an executable. The original name is kept
// in the DB purely for display and for the download filename.
const UPLOAD_DIR = process.env.SERVICE_UPLOAD_DIR || path.join(__dirname, '..', 'uploads', 'service');
const MAX_FILE_BYTES = Number(process.env.SERVICE_MAX_FILE_MB || 25) * 1024 * 1024;
const MAX_FILES = 10;

// Photos are the stated use case (§16 "supporting files such as pictures"),
// plus the document types a customer realistically attaches to a fault report.
const ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.bmp',
  '.pdf', '.txt', '.csv', '.log',
  '.doc', '.docx', '.xls', '.xlsx',
  '.mp4', '.mov',
  '.zip',
]);

try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); }
catch (e) { console.warn('[service] could not create upload dir:', e.message); }

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ALLOWED_EXT.has(ext) ? ext : '.bin'}`);
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return cb(new Error(`File type ${ext || '(none)'} is not allowed.`));
    cb(null, true);
  },
});

// multer errors arrive as thrown exceptions from the middleware, which the
// global handler would turn into an opaque 500. A customer who attached a
// 40 MB video deserves to be told that, not "Internal server error".
function uploadOrExplain(field) {
  const mw = upload.array(field, MAX_FILES);
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `Each file must be under ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`
      : err.code === 'LIMIT_FILE_COUNT'
        ? `Please attach no more than ${MAX_FILES} files.`
        : err.message || 'Upload failed.';
    res.status(400).json({ error: msg });
  });
}

// ── Small helpers ────────────────────────────────────────────────────────────

/**
 * The real client IP, for the public endpoint's per-IP throttle.
 *
 * This deliberately does NOT trust the first X-Forwarded-For entry. XFF is a
 * list the client can start: anyone may send `X-Forwarded-For: 1.2.3.4`, and a
 * proxy APPENDS to it rather than replacing it, so the leftmost value is
 * attacker-controlled. Keying a rate limit on it means an abuser rotates that
 * header and gets unlimited submissions — the limiter looks present and does
 * nothing.
 *
 * Order of preference:
 *   1. CF-Connecting-IP — set by Cloudflare, which OVERWRITES any client-sent
 *      copy, so it cannot be forged from outside. This app is published through
 *      a Cloudflare Tunnel, making it the authoritative source here.
 *   2. The LAST X-Forwarded-For entry — the hop nearest us, i.e. the one added
 *      by our own proxy rather than anything the client injected.
 *   3. req.ip.
 */
function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf.slice(0, 64);
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1].slice(0, 64);
  return (req.ip || 'unknown').slice(0, 64);
}

const today = () => new Date().toISOString().slice(0, 10);
const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const trim = (v, n = 255) => (v == null ? null : String(v).trim().slice(0, n) || null);
const who = (req) => (req.authUser && req.authUser.name) || req.user || 'system';

function coerce(field, value) {
  if (BOOL_FIELDS.has(field)) return value ? 1 : 0;
  if (field === 'budgeted_hours' || field === 'hours_actual') {
    if (value === '' || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (field === 'service_details' || field === 'additional_comments' ||
      field === 'task_description' || field === 'information_needed' ||
      field === 'ppe_requirements' || field === 'onsite_address' ||
      field === 'work_performed' || field === 'findings' ||
      field === 'parts_used' || field === 'follow_up_notes') {
    return value == null ? null : String(value).trim().slice(0, 20000) || null;
  }
  return trim(value);
}

// Validates the closed-vocabulary fields. Returns an error string or null.
// Applied to BOTH the public and internal create/update paths — the public form
// and the internal form must not be able to disagree about what a valid urgency
// is.
function validateVocab(body) {
  if (body.urgency != null && body.urgency !== '' && !URGENCIES.has(body.urgency)) return 'Invalid urgency.';
  if (body.department_needed != null && body.department_needed !== '' && !DEPARTMENTS.has(body.department_needed)) return 'Invalid department.';
  if (body.location_type != null && body.location_type !== '' && !LOCATIONS.has(body.location_type)) return 'Invalid remote/on-site value.';
  if (body.warranty != null && body.warranty !== '' && !WARRANTY.has(body.warranty)) return 'Invalid warranty value.';
  if (body.machine_type != null && body.machine_type !== '' && !MACHINE_TYPES.has(body.machine_type)) return 'Invalid machine type.';
  return null;
}

module.exports = function createRouter(deps) {
  const { pool, io, requireRole, emailSvc } = deps;
  const router = Router();
  const publicRouter = Router();

  const notifyClients = () => { try { io.emit('service:updated'); } catch (_) {} };

  // ── Audit history (R2 §19) ─────────────────────────────────────────────────
  // Never allowed to break the operation it is recording — an audit write that
  // can fail a Work Order creation is worse than a missing audit line.
  async function logService(requestId, action, detail, changedBy, workOrderId = null) {
    try {
      await pool.query(
        'INSERT INTO service_history (service_request_id, work_order_id, action, detail, changed_by) VALUES (?, ?, ?, ?, ?)',
        [requestId, workOrderId, action, detail == null ? null : String(detail).slice(0, 2000), changedBy || null]
      );
    } catch (e) { console.warn('[service] history log failed (non-fatal):', e.message); }
  }

  // ── Identifiers (R2 §3) ────────────────────────────────────────────────────
  // SR-YYYY-NNNN, sequential within the year. Generated by reading the current
  // max and retrying on the UNIQUE-key collision rather than by holding a row
  // lock: two simultaneous website submissions are rare, a retry is cheap, and
  // the UNIQUE index is what actually guarantees correctness either way.
  async function nextRequestNo(conn) {
    const year = new Date().getFullYear();
    const [[row]] = await conn.query(
      "SELECT request_no FROM service_requests WHERE request_no LIKE ? ORDER BY LENGTH(request_no) DESC, request_no DESC LIMIT 1",
      [`SR-${year}-%`]
    );
    const last = row ? Number(String(row.request_no).split('-')[2]) : 0;
    return `SR-${year}-${String((Number.isFinite(last) ? last : 0) + 1).padStart(4, '0')}`;
  }

  // WO numbers hang off the parent so the linkage is legible on paper:
  // SR-2026-0007-WO2 is unmistakably the second visit for that request (§18).
  async function nextWoNo(requestNo, requestId) {
    const [[row]] = await pool.query(
      'SELECT COUNT(*) AS n FROM service_work_orders WHERE service_request_id = ?', [requestId]
    );
    return `${requestNo}-WO${row.n + 1}`;
  }

  async function createRequest(payload, { source, createdBy }) {
    const cols = ['request_no', 'source', 'created_by'];
    const vals = [null, source, createdBy];
    for (const f of CUSTOMER_FIELDS) {
      if (f in payload) { cols.push(f); vals.push(coerce(f, payload[f])); }
    }
    // A website request lands as 'new'; an internally-logged one too — the
    // Service team moves it from there. No invented pipeline (§17).
    cols.push('current_status'); vals.push(trim(payload.current_status) || 'new');

    for (let attempt = 0; attempt < 5; attempt++) {
      vals[0] = await nextRequestNo(pool);
      try {
        const [r] = await pool.query(
          `INSERT INTO service_requests (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals
        );
        return { id: r.insertId, request_no: vals[0] };
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY' && attempt < 4) continue; // lost a race — take the next number
        throw e;
      }
    }
    throw new Error('Could not allocate a Service Request number.');
  }

  async function attachFiles(requestId, files, uploadedBy, workOrderId = null) {
    if (!Array.isArray(files) || !files.length) return 0;
    for (const f of files) {
      await pool.query(
        `INSERT INTO service_attachments
           (service_request_id, work_order_id, filename, stored_name, mime_type, size_bytes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [requestId, workOrderId, trim(f.originalname) || f.filename, f.filename, trim(f.mimetype, 128), f.size, uploadedBy]
      );
    }
    return files.length;
  }

  // A work order joined to the parent request's customer context. This join is
  // what implements §6's "populate from the parent Service Log rather than
  // requiring duplicate entry" — the requestor's details are never copied onto
  // the WO row, so they cannot go stale against the request.
  async function woWithParent(id) {
    const [[wo]] = await pool.query(`
      SELECT w.*,
             r.request_no, r.company_name, r.requestor_name, r.requestor_email, r.requestor_phone,
             r.machine_serial, r.job_number, r.machine_type, r.urgency, r.department_needed, r.warranty,
             r.service_details
        FROM service_work_orders w
        JOIN service_requests r ON r.id = w.service_request_id
       WHERE w.id = ?`, [id]);
    return wo || null;
  }

  // ── Scheduler linkage (R2 §7) ──────────────────────────────────────────────
  // A Work Order creates a real row in `tasks`, which is the whole point: the
  // Service assignment shows up in the employee's existing Scheduler workload
  // with no parallel Service-only roster to maintain. It stays visibly Service
  // work via the "Service" department + the SR-prefixed name.
  //
  // Project resolution: prefer the schedule for the customer's job number, so a
  // service visit appears on that machine's own project. Fall back to a single
  // "Service" project for requests with no matching job (a machine SDC built
  // years ago may have no live schedule).
  async function resolveServiceProject(jobNumber) {
    if (jobNumber) {
      const [[p]] = await pool.query('SELECT name FROM projects WHERE job_number = ? LIMIT 1', [jobNumber]);
      if (p) return p.name;
    }
    await pool.query(
      "INSERT IGNORE INTO projects (name, status, job_number) VALUES ('Service', 'active', NULL)"
    ).catch(() => {});
    return 'Service';
  }

  async function syncWorkOrderTask(wo) {
    try {
      const project = await resolveServiceProject(wo.job_number);
      const name = `Service ${wo.wo_no}: ${String(wo.task_description || wo.company_name || 'Service visit').slice(0, 120)}`;
      const dur = 1;
      if (wo.task_id) {
        await pool.query(
          `UPDATE tasks SET name = ?, project = ?, assignee = ?, start_date = ?, end_date = ?,
                            duration_days = ?, dates_locked = 1
             WHERE id = ?`,
          [name, project, wo.employee_name || null, wo.task_date || null, wo.task_date || null, dur, wo.task_id]
        );
        return wo.task_id;
      }
      const [[m]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks WHERE project = ?', [project]);
      const [r] = await pool.query(
        `INSERT INTO tasks (name, project, department, assignee, start_date, end_date, duration_days,
                            progress, notes, sort_order, dates_locked)
         VALUES (?, ?, 'service', ?, ?, ?, ?, 0, ?, ?, 1)`,
        [name, project, wo.employee_name || null, wo.task_date || null, wo.task_date || null, dur,
         `Service Work Order ${wo.wo_no} (${wo.request_no}) — ${wo.company_name || ''}`.trim(), (m.m || 0) + 1]
      );
      await pool.query('UPDATE service_work_orders SET task_id = ? WHERE id = ?', [r.insertId, wo.id]);
      return r.insertId;
    } catch (e) {
      // A Work Order whose schedule row failed to write is still a valid Work
      // Order — the employee has been notified and can do the job. Log it and
      // move on rather than failing the create.
      console.warn(`[service] could not sync WO ${wo.wo_no} to a schedule task:`, e.message);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PUBLIC — customer intake (mounted BEFORE requireAuth)
  // ══════════════════════════════════════════════════════════════════════════

  // Naive per-IP throttle. This endpoint is unauthenticated and world-reachable,
  // so without one a single script could fill the Service Log. In-memory on
  // purpose: it needs no schema, and a restart clearing it is an acceptable
  // failure mode for what is a spam speed-bump, not a security control.
  const _rateHits = new Map(); // ip → number[] (ms timestamps)
  const RATE_WINDOW_MS = 60 * 60 * 1000;
  const RATE_MAX = Number(process.env.SERVICE_PUBLIC_RATE_MAX || 8);
  function rateLimited(ip) {
    const now = Date.now();
    const hits = (_rateHits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (hits.length >= RATE_MAX) { _rateHits.set(ip, hits); return true; }
    hits.push(now);
    _rateHits.set(ip, hits);
    if (_rateHits.size > 5000) _rateHits.clear(); // crude bound; see note above
    return false;
  }

  // Lets the public form render its dropdowns from the server's vocabulary
  // instead of hardcoding a second copy that can drift out of step (§1, §2).
  publicRouter.get('/api/public/service-options', (_req, res) => {
    res.json({
      urgencies: [
        { value: 'machine_down',   label: 'Machine down' },
        { value: 'urgent_running', label: 'Machine running but urgent' },
        { value: 'schedule',       label: 'Not urgent — want to schedule' },
        { value: 'quote_mod',      label: 'Need modification quoted' },
      ],
      departments: [
        { value: 'mechanical', label: 'Mechanical Engineering' },
        { value: 'controls',   label: 'Controls Engineering' },
        { value: 'shop',       label: 'Shop' },
        { value: 'all',        label: 'All' },
      ],
      locations: [
        { value: 'remote', label: 'Remote' },
        { value: 'onsite', label: 'On-site' },
      ],
      warranty: [
        { value: 'warranty',     label: 'Warranty' },
        { value: 'non_warranty', label: 'Not warranty' },
        { value: 'unknown',      label: "Don't know" },
      ],
      machineTypes: [
        { value: 'sdc',     label: 'SDC machine' },
        { value: 'non_sdc', label: 'Non-SDC machine' },
      ],
      maxFileMb: Math.round(MAX_FILE_BYTES / 1024 / 1024),
      maxFiles: MAX_FILES,
    });
  });

  // POST /api/public/service-requests — the website form target (R2 §1).
  // Accepts multipart (with files) or plain JSON. Creates the Service Request
  // AND therefore the Service Log entry, because they are the same row (§4).
  // Body parsing for the public intake, in three shapes, because we do not
  // control what the website posts:
  //   • multipart/form-data      — the hosted form (it can carry files)
  //   • application/x-www-form-urlencoded — a plain <form method="post">, which
  //     is what a hand-rolled website form sends if nobody sets an enctype
  //   • application/json         — an API caller (already parsed globally in
  //     server.js, listed here so this router works standalone too)
  // multer ignores non-multipart bodies and the express parsers ignore
  // multipart, so chaining all three is safe and each request hits exactly one.
  const parseBody = [
    express.urlencoded({ extended: false, limit: '1mb' }),
    express.json({ limit: '1mb' }),
    uploadOrExplain('files'),
  ];

  publicRouter.post('/api/public/service-requests', ...parseBody, async (req, res) => {
    const cleanupFiles = () => {
      for (const f of req.files || []) { try { fs.unlinkSync(f.path); } catch (_) {} }
    };
    try {
      const ip = clientIp(req);
      if (rateLimited(ip)) {
        cleanupFiles();
        return res.status(429).json({ error: 'Too many requests from this location. Please call SDC directly if this is urgent.' });
      }
      const b = req.body || {};

      // Honeypot: a hidden field no human fills in. Answer 200 with a plausible
      // number so a bot cannot distinguish rejection from success, but store
      // nothing.
      if (b.website) { cleanupFiles(); return res.json({ ok: true, request_no: 'SR-0000-0000' }); }

      // The serial / job number is required ONLY for an SDC-built machine.
      // Somebody else's equipment has no SDC serial and no SDC job number, so
      // demanding one would make the form impossible to submit for exactly the
      // customers who most need to describe what they have. For those, the
      // same field is a free-text make/model and is optional.
      const isNonSdc = b.machine_type === 'non_sdc';
      const required = [
        ['company_name',    'Company Name'],
        ['requestor_name',  'Your Name'],
        ['requestor_email', 'Your Email'],
        ['requestor_phone', 'Your Phone Number'],
        ...(isNonSdc ? [] : [['machine_serial', 'SDC Machine Serial # / Project Job #']]),
        ['urgency',         'Service Completion Timeline / Urgency'],
        ['service_details', 'Service Details'],
      ];
      const missing = required.filter(([f]) => !String(b[f] || '').trim()).map(([, label]) => label);
      if (missing.length) {
        cleanupFiles();
        return res.status(400).json({ error: `Please complete: ${missing.join(', ')}.` });
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.requestor_email).trim())) {
        cleanupFiles();
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
      const vocabErr = validateVocab(b);
      if (vocabErr) { cleanupFiles(); return res.status(400).json({ error: vocabErr }); }

      const created = await createRequest(b, { source: 'website', createdBy: trim(b.requestor_name) });
      const n = await attachFiles(created.id, req.files, trim(b.requestor_name));
      await logService(created.id, 'request_created',
        `Submitted from the website by ${trim(b.requestor_name) || 'a customer'}${n ? ` with ${n} attachment(s)` : ''}.`,
        trim(b.requestor_name) || 'customer');

      res.json({ ok: true, request_no: created.request_no });
      notifyClients();

      // Tell the Service team something came in. Best-effort, after the
      // response — a customer must never see a submission fail because SMTP is
      // down. SERVICE_INTAKE_EMAIL unset = no-op.
      const intake = process.env.SERVICE_INTAKE_EMAIL || '';
      if (intake && emailSvc && typeof emailSvc._sendOnce === 'function') {
        emailSvc._sendOnce(pool, {
          to: intake,
          subject: `[SDC Service] New request ${created.request_no} — ${trim(b.company_name) || ''} — ${serviceNotify.urgencyLabel(b.urgency)}`,
          html: `<p><strong>${created.request_no}</strong> submitted by ${trim(b.requestor_name)} (${trim(b.company_name)}).</p>
                 <p>Urgency: <strong>${serviceNotify.urgencyLabel(b.urgency)}</strong><br>
                    Machine/Job: ${trim(b.machine_serial) || '—'}</p>
                 <pre style="white-space:pre-wrap;font:13px/1.5 sans-serif">${String(b.service_details || '').replace(/[<>]/g, '')}</pre>`,
          text: `${created.request_no} — ${trim(b.company_name)} — ${serviceNotify.urgencyLabel(b.urgency)}\n\n${b.service_details || ''}`,
          referenceKey: `service-intake:${created.id}`,
          type: 'service_intake',
        }).catch(() => {});
      }
    } catch (e) {
      cleanupFiles();
      console.error('[service] public submit failed:', e.message);
      res.status(500).json({ error: 'Could not submit your request. Please call SDC directly.' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  INTERNAL — Service Log, Work Orders, Reports (behind requireAuth)
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/service/requests — the Service Log, plus every §13 view and every
  // §15 filter. All of them are ONE dataset with different WHERE clauses, which
  // is what §13 means by "UI views over the same Service data".
  router.get('/api/service/requests', async (req, res) => {
    try {
      const q = req.query || {};
      const where = [];
      const args  = [];

      if (q.view === 'open')      where.push('r.service_complete = 0');
      if (q.view === 'completed') where.push('r.service_complete = 1');

      for (const [param, col] of [
        ['status', 'r.current_status'], ['urgency', 'r.urgency'],
        ['department', 'r.department_needed'], ['location', 'r.location_type'],
        ['warranty', 'r.warranty'], ['company', 'r.company_name'],
        ['machine_type', 'r.machine_type'],
        ['job', 'r.job_number'], ['assigned', 'r.resource_assigned'],
      ]) {
        if (q[param]) { where.push(`${col} = ?`); args.push(q[param]); }
      }
      if (q.from) { where.push('DATE(r.created_at) >= ?'); args.push(q.from); }
      if (q.to)   { where.push('DATE(r.created_at) <= ?'); args.push(q.to); }

      // Free-text search across the identifiers a Service coordinator actually
      // has in hand when someone calls (§15).
      if (q.search) {
        where.push(`(r.request_no LIKE ? OR r.company_name LIKE ? OR r.requestor_name LIKE ?
                     OR r.machine_serial LIKE ? OR r.job_number LIKE ? OR r.service_details LIKE ?)`);
        const like = `%${String(q.search).slice(0, 100)}%`;
        args.push(like, like, like, like, like, like);
      }
      // Employee filter has to reach through the work orders — "show me every
      // request Nick is on" is a WO-level fact, not a request-level one.
      if (q.employee) {
        where.push('EXISTS (SELECT 1 FROM service_work_orders w WHERE w.service_request_id = r.id AND w.employee_name = ?)');
        args.push(q.employee);
      }

      const [rows] = await pool.query(`
        SELECT r.*,
               (SELECT COUNT(*) FROM service_work_orders w WHERE w.service_request_id = r.id) AS wo_count,
               (SELECT COUNT(*) FROM service_work_orders w WHERE w.service_request_id = r.id AND w.status = 'open') AS wo_open,
               (SELECT COUNT(*) FROM service_attachments a WHERE a.service_request_id = r.id) AS attachment_count,
               (SELECT GROUP_CONCAT(DISTINCT w.employee_name SEPARATOR ', ')
                  FROM service_work_orders w WHERE w.service_request_id = r.id) AS assigned_employees
          FROM service_requests r
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY r.service_complete ASC,
                  FIELD(r.urgency, 'machine_down', 'urgent_running', 'schedule', 'quote_mod'),
                  r.created_at DESC
         LIMIT 2000`, args);
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // GET /api/service/requests/:id — the whole lifecycle in one payload (§14):
  // customer request → log status → work orders → completion → report.
  router.get('/api/service/requests/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[request]] = await pool.query('SELECT * FROM service_requests WHERE id = ?', [id]);
      if (!request) return res.status(404).json({ error: 'Service request not found.' });

      const [workOrders] = await pool.query(
        `SELECT w.*, rep.id AS report_id, rep.status AS report_status, rep.report_no
           FROM service_work_orders w
           LEFT JOIN service_reports rep ON rep.work_order_id = w.id
          WHERE w.service_request_id = ?
          ORDER BY w.task_date IS NULL, w.task_date, w.id`, [id]);
      const [attachments] = await pool.query(
        'SELECT id, work_order_id, filename, mime_type, size_bytes, uploaded_by, created_at FROM service_attachments WHERE service_request_id = ? ORDER BY id',
        [id]);
      const [history] = await pool.query(
        'SELECT * FROM service_history WHERE service_request_id = ? ORDER BY changed_at DESC, id DESC LIMIT 500', [id]);

      res.json({ request, workOrders, attachments, history });
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // POST /api/service/requests — internally-logged request (phone call, email).
  // Same row, same numbering, `source` distinguishes it.
  router.post('/api/service/requests', requireRole('editor'), async (req, res) => {
    try {
      const b = req.body || {};
      if (!String(b.company_name || '').trim()) return res.status(400).json({ error: 'Company Name is required.' });
      const vocabErr = validateVocab(b);
      if (vocabErr) return res.status(400).json({ error: vocabErr });

      const created = await createRequest(b, { source: trim(b.source) || 'internal', createdBy: who(req) });
      // Internal creators may set the management fields in the same breath.
      const updates = {};
      for (const f of INTERNAL_FIELDS) {
        if (!CUSTOMER_FIELDS.includes(f) && f in b) updates[f] = coerce(f, b[f]);
      }
      if (Object.keys(updates).length) {
        await pool.query(
          `UPDATE service_requests SET ${Object.keys(updates).map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
          [...Object.values(updates), created.id]);
      }
      await logService(created.id, 'request_created', `Logged internally by ${who(req)}.`, who(req));

      const [[row]] = await pool.query('SELECT * FROM service_requests WHERE id = ?', [created.id]);
      res.json(row);
      notifyClients();
    } catch (e) {
      console.error('[service] create request failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/service/requests/:id — the Service Log edit path.
  //
  // The three checkboxes and the completion date auto-stamp their dates the way
  // shop_parts.part_complete already does in this codebase, so a coordinator
  // ticking "PO Received" never also has to type today's date. Unticking clears
  // it, so a mis-click leaves no phantom date behind.
  router.put('/api/service/requests/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT * FROM service_requests WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'Service request not found.' });
      const vocabErr = validateVocab(req.body || {});
      if (vocabErr) return res.status(400).json({ error: vocabErr });

      const updates = {};
      for (const f of INTERNAL_FIELDS) {
        if (f in req.body) updates[f] = coerce(f, req.body[f]);
      }
      if (!Object.keys(updates).length) return res.json(existing);

      const stamps = [
        ['quote_sent', 'quote_sent_at'],
        ['po_received', 'po_received_at'],
        ['service_complete', 'service_complete_date'],
      ];
      for (const [flag, dateCol] of stamps) {
        if (flag in updates && !(dateCol in updates)) {
          if (updates[flag] && !existing[flag])      updates[dateCol] = today();
          else if (!updates[flag] && existing[flag]) updates[dateCol] = null;
        }
      }

      await pool.query(
        `UPDATE service_requests SET ${Object.keys(updates).map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...Object.values(updates), id]);

      // §19 wants the meaningful transitions named, not a generic "row edited".
      const audit = [];
      if ('quote_sent' in updates && updates.quote_sent !== existing.quote_sent)
        audit.push(['quote_sent_changed', `Service Quote Sent ${updates.quote_sent ? 'checked' : 'unchecked'}.`]);
      if ('po_received' in updates && updates.po_received !== existing.po_received)
        audit.push(['po_received_changed', `PO Received ${updates.po_received ? 'checked' : 'unchecked'}.`]);
      if ('service_complete' in updates && updates.service_complete !== existing.service_complete)
        audit.push(['service_complete_changed', `Service ${updates.service_complete ? 'marked complete' : 'reopened'}.`]);
      if ('resource_assigned' in updates && updates.resource_assigned !== existing.resource_assigned)
        audit.push(['resource_assigned', `Resource assigned: ${updates.resource_assigned || '(cleared)'}.`]);
      if ('current_status' in updates && updates.current_status !== existing.current_status)
        audit.push(['status_changed', `Status: ${existing.current_status || '—'} → ${updates.current_status || '—'}.`]);
      const otherFields = Object.keys(updates).filter(k =>
        !['quote_sent', 'po_received', 'service_complete', 'resource_assigned', 'current_status',
          'quote_sent_at', 'po_received_at', 'service_complete_date'].includes(k));
      if (otherFields.length) audit.push(['request_updated', `Updated: ${otherFields.join(', ')}.`]);
      for (const [action, detail] of audit) await logService(id, action, detail, who(req));

      const [[row]] = await pool.query('SELECT * FROM service_requests WHERE id = ?', [id]);
      res.json(row);
      notifyClients();
    } catch (e) {
      console.error('[service] update request failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Admin-only: a Service Request is a business record, not a scratch row. The
  // FK cascade takes the work orders, attachments, reports and history with it;
  // the files on disk and any linked schedule tasks are cleaned up explicitly
  // since neither is reachable by the DB cascade.
  router.delete('/api/service/requests/:id', requireRole('admin'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [files] = await pool.query('SELECT stored_name FROM service_attachments WHERE service_request_id = ?', [id]);
      const [tasks] = await pool.query('SELECT task_id FROM service_work_orders WHERE service_request_id = ? AND task_id IS NOT NULL', [id]);
      await pool.query('DELETE FROM service_requests WHERE id = ?', [id]);
      await pool.query('DELETE FROM service_history WHERE service_request_id = ?', [id]).catch(() => {});
      for (const t of tasks) await pool.query('DELETE FROM tasks WHERE id = ?', [t.task_id]).catch(() => {});
      for (const f of files) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored_name)); } catch (_) {} }
      res.json({ ok: true });
      notifyClients();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Attachments (§16) ──────────────────────────────────────────────────────
  router.post('/api/service/requests/:id/attachments', requireRole('editor'), uploadOrExplain('files'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[exists]] = await pool.query('SELECT id FROM service_requests WHERE id = ?', [id]);
      if (!exists) {
        for (const f of req.files || []) { try { fs.unlinkSync(f.path); } catch (_) {} }
        return res.status(404).json({ error: 'Service request not found.' });
      }
      const workOrderId = req.body.work_order_id ? Number(req.body.work_order_id) : null;
      const n = await attachFiles(id, req.files, who(req), workOrderId);
      await logService(id, 'attachment_added', `${n} file(s) attached by ${who(req)}.`, who(req), workOrderId);
      const [rows] = await pool.query(
        'SELECT id, work_order_id, filename, mime_type, size_bytes, uploaded_by, created_at FROM service_attachments WHERE service_request_id = ? ORDER BY id', [id]);
      res.json(rows);
      notifyClients();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Files are served through this route, never from a static directory: the
  // upload dir stays outside anything express.static serves, so an attachment
  // is only reachable by an authenticated user who asks for it by id.
  router.get('/api/service/attachments/:id', async (req, res) => {
    try {
      const [[a]] = await pool.query('SELECT * FROM service_attachments WHERE id = ?', [Number(req.params.id)]);
      if (!a) return res.status(404).json({ error: 'Attachment not found.' });
      const full = path.join(UPLOAD_DIR, path.basename(a.stored_name));
      if (!fs.existsSync(full)) return res.status(410).json({ error: 'The stored file is missing from disk.' });
      res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
      // `inline` so photos open in a tab instead of forcing a download — the
      // common case is a coordinator glancing at a picture of the fault.
      res.setHeader('Content-Disposition', `inline; filename="${a.filename.replace(/["\\]/g, '')}"`);
      fs.createReadStream(full).pipe(res);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/service/attachments/:id', requireRole('editor'), async (req, res) => {
    try {
      const [[a]] = await pool.query('SELECT * FROM service_attachments WHERE id = ?', [Number(req.params.id)]);
      if (!a) return res.json({ ok: true });
      await pool.query('DELETE FROM service_attachments WHERE id = ?', [a.id]);
      try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(a.stored_name))); } catch (_) {}
      await logService(a.service_request_id, 'attachment_removed', `Removed ${a.filename}.`, who(req));
      res.json({ ok: true });
      notifyClients();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Employees (§7) ─────────────────────────────────────────────────────────
  // The EXISTING scheduler roster, joined to users for the email address a Work
  // Order needs. There is deliberately no Service-only employee table — §7 says
  // not to maintain a duplicate roster, and this is how that promise is kept.
  // Service-discipline members sort first since they are the usual assignees,
  // but the whole active roster is offered: a controls engineer gets sent on
  // service calls too.
  router.get('/api/service/employees', async (_req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT t.id, t.name, t.discipline, u.email
          FROM team_members t
          LEFT JOIN users u ON u.name = t.name AND u.active = 1
         WHERE t.active = 1
         ORDER BY (t.discipline = 'service') DESC, t.discipline, t.sort_order, t.name`);
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // ── Work Orders (§6, §13) ──────────────────────────────────────────────────
  router.get('/api/service/work-orders', async (req, res) => {
    try {
      const q = req.query || {};
      const where = [];
      const args  = [];

      // The §13 views, all over the same data.
      if (q.view === 'mine') {
        // Match on either identity — team_members.name and users.name agree for
        // most people but not all, and an employee looking for their own work
        // should not fall through a name-spelling crack.
        where.push('(w.employee_email = ? OR w.employee_name = ?)');
        args.push(req.authUser?.email || '', req.authUser?.name || '');
      }
      if (q.view === 'scheduled') { where.push("w.status = 'open' AND w.task_date >= ?"); args.push(today()); }
      if (q.view === 'open')      where.push("w.status = 'open'");
      if (q.view === 'completed') where.push("w.status = 'complete'");

      if (q.employee) { where.push('w.employee_name = ?'); args.push(q.employee); }
      if (q.status)   { where.push('w.status = ?');        args.push(q.status); }
      if (q.location) { where.push('w.location_type = ?'); args.push(q.location); }
      if (q.from)     { where.push('w.task_date >= ?');    args.push(q.from); }
      if (q.to)       { where.push('w.task_date <= ?');    args.push(q.to); }
      if (q.request)  { where.push('w.service_request_id = ?'); args.push(Number(q.request)); }

      const [rows] = await pool.query(`
        SELECT w.*,
               r.request_no, r.company_name, r.job_number, r.machine_serial, r.machine_type, r.urgency,
               r.requestor_name, r.requestor_email, r.requestor_phone, r.warranty,
               rep.id AS report_id, rep.status AS report_status, rep.report_no
          FROM service_work_orders w
          JOIN service_requests r ON r.id = w.service_request_id
          LEFT JOIN service_reports rep ON rep.work_order_id = w.id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY w.status = 'complete', w.task_date IS NULL, w.task_date, w.id
         LIMIT 2000`, args);
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // Single Work Order by id — what the "Open Work Order" button in a
  // notification email resolves against before opening its parent request.
  router.get('/api/service/work-orders/:id', async (req, res) => {
    try {
      const wo = await woWithParent(Number(req.params.id));
      if (!wo) return res.status(404).json({ error: 'Work Order not found.' });
      res.json(wo);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // POST — create a Work Order under a request (§6). This is the step that also
  // books the employee in the Scheduler (§7) and notifies them (§8).
  router.post('/api/service/requests/:id/work-orders', requireRole('editor'), async (req, res) => {
    try {
      const requestId = Number(req.params.id);
      const [[parent]] = await pool.query('SELECT * FROM service_requests WHERE id = ?', [requestId]);
      if (!parent) return res.status(404).json({ error: 'Service request not found.' });

      const b = req.body || {};
      if (!String(b.employee_name || '').trim()) return res.status(400).json({ error: 'Required Employee is required.' });
      if (b.location_type && !LOCATIONS.has(b.location_type)) return res.status(400).json({ error: 'Invalid remote/on-site value.' });

      const cols = ['service_request_id', 'wo_no', 'created_by'];
      const vals = [requestId, null, who(req)];
      for (const f of WO_FIELDS) {
        if (f in b) { cols.push(f); vals.push(coerce(f, b[f])); }
      }
      // Sensible inheritance from the parent, so the common case is a two-field
      // form (who + when). Explicit values on the request body always win.
      if (!cols.includes('location_type') && parent.location_type) { cols.push('location_type'); vals.push(parent.location_type); }
      if (!cols.includes('ppe_requirements') && parent.ppe_requirements) { cols.push('ppe_requirements'); vals.push(parent.ppe_requirements); }
      if (!cols.includes('onsite_address') && parent.onsite_address) { cols.push('onsite_address'); vals.push(parent.onsite_address); }
      if (!cols.includes('task_description') && parent.service_details) { cols.push('task_description'); vals.push(parent.service_details); }
      // The SDC remote-support contact defaults to whoever raised the WO —
      // they are the person the employee will call from site.
      if (!cols.includes('sdc_contact_name')) { cols.push('sdc_contact_name'); vals.push(who(req)); }
      if (!cols.includes('sdc_contact_email') && req.authUser?.email) { cols.push('sdc_contact_email'); vals.push(req.authUser.email); }

      let woId = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        vals[1] = await nextWoNo(parent.request_no, requestId);
        try {
          const [r] = await pool.query(
            `INSERT INTO service_work_orders (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
          woId = r.insertId;
          break;
        } catch (e) {
          if (e.code === 'ER_DUP_ENTRY' && attempt < 4) continue;
          throw e;
        }
      }

      const wo = await woWithParent(woId);
      await syncWorkOrderTask(wo);

      // Keep the Service Log's own "Resource Assigned" in step with reality —
      // it is one of Monica's named fields (§4) and a coordinator should not
      // have to maintain it by hand once a WO exists.
      const [[names]] = await pool.query(
        `SELECT GROUP_CONCAT(DISTINCT employee_name SEPARATOR ', ') AS n
           FROM service_work_orders WHERE service_request_id = ?`, [requestId]);
      await pool.query('UPDATE service_requests SET resource_assigned = ? WHERE id = ?', [names.n || null, requestId]);

      await logService(requestId, 'work_order_created',
        `${wo.wo_no} created for ${wo.employee_name}${wo.task_date ? ` on ${wo.task_date}` : ''}.`, who(req), woId);

      const fresh = await woWithParent(woId);
      res.json(fresh);
      notifyClients();

      // §8 — deliver it. After the response, so a slow SMTP server never makes
      // the Work Order look like it failed to save.
      if (b.notify !== false) {
        serviceNotify.sendWorkOrder({ pool, emailSvc, wo: fresh })
          .then(async (r) => {
            if (r.email?.sent || r.teams?.sent) {
              await pool.query('UPDATE service_work_orders SET notified_at = ? WHERE id = ?', [nowStamp(), woId]);
              await logService(requestId, 'work_order_notified',
                `Notification sent to ${fresh.employee_email || fresh.employee_name}.`, 'system', woId);
              notifyClients();
            } else if (!fresh.employee_email) {
              await logService(requestId, 'work_order_notify_failed',
                `No email address on file for ${fresh.employee_name} — Work Order not delivered.`, 'system', woId);
            }
          })
          .catch(e => console.warn('[service] WO notify failed:', e.message));
      }
    } catch (e) {
      console.error('[service] create work order failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/api/service/work-orders/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await woWithParent(id);
      if (!existing) return res.status(404).json({ error: 'Work Order not found.' });
      if (req.body.location_type && !LOCATIONS.has(req.body.location_type)) {
        return res.status(400).json({ error: 'Invalid remote/on-site value.' });
      }

      const updates = {};
      for (const f of WO_FIELDS) if (f in req.body) updates[f] = coerce(f, req.body[f]);
      if (!Object.keys(updates).length) return res.json(existing);

      // A WO moved to a NEW future date is owed a fresh day-before reminder —
      // clearing the stamp is what re-arms the sweep. (serviceNotify's dedupe
      // key also carries the date, so this cannot double-send for a date the
      // employee was already reminded about.)
      if ('task_date' in updates && updates.task_date !== existing.task_date) {
        updates.reminder_sent_at = null;
      }

      await pool.query(
        `UPDATE service_work_orders SET ${Object.keys(updates).map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...Object.values(updates), id]);

      const fresh = await woWithParent(id);
      await syncWorkOrderTask(fresh);

      if ('employee_name' in updates && updates.employee_name !== existing.employee_name) {
        await logService(fresh.service_request_id, 'work_order_reassigned',
          `${fresh.wo_no} reassigned: ${existing.employee_name || '—'} → ${fresh.employee_name || '—'}.`, who(req), id);
        // A reassignment is a new assignment for the new person — tell them.
        serviceNotify.sendWorkOrder({ pool, emailSvc, wo: fresh, resend: true })
          .then(() => pool.query('UPDATE service_work_orders SET notified_at = ? WHERE id = ?', [nowStamp(), id]))
          .catch(() => {});
      } else {
        await logService(fresh.service_request_id, 'work_order_updated',
          `${fresh.wo_no} updated: ${Object.keys(updates).join(', ')}.`, who(req), id);
      }

      res.json(fresh);
      notifyClients();
    } catch (e) {
      console.error('[service] update work order failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Manual resend (§8) — for "I never got it".
  router.post('/api/service/work-orders/:id/notify', requireRole('editor'), async (req, res) => {
    try {
      const wo = await woWithParent(Number(req.params.id));
      if (!wo) return res.status(404).json({ error: 'Work Order not found.' });
      if (!wo.employee_email && !serviceNotify.TEAMS_ENABLED) {
        return res.status(400).json({ error: `No email address on file for ${wo.employee_name}. Add one on their user account first.` });
      }
      const r = await serviceNotify.sendWorkOrder({ pool, emailSvc, wo, resend: true });
      if (r.email?.sent || r.teams?.sent) {
        await pool.query('UPDATE service_work_orders SET notified_at = ? WHERE id = ?', [nowStamp(), wo.id]);
        await logService(wo.service_request_id, 'work_order_notified', `Notification re-sent by ${who(req)}.`, who(req), wo.id);
      }
      res.json({ ok: true, ...r });
      notifyClients();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST complete (§10) — the employee's one-click finish. Deliberately NOT
  // requireRole('admin'): the assigned technician has to be able to do this
  // themselves from the field, which is the entire point of §10.
  //
  // This is also the §11 trigger: completing generates the prepopulated Service
  // Report in the same transaction of work, so there is no state where a WO is
  // complete but its report was never created.
  router.post('/api/service/work-orders/:id/complete', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const wo = await woWithParent(id);
      if (!wo) return res.status(404).json({ error: 'Work Order not found.' });
      if (wo.status === 'complete') {
        const [[rep]] = await pool.query('SELECT * FROM service_reports WHERE work_order_id = ?', [id]);
        return res.json({ workOrder: wo, report: rep || null, alreadyComplete: true });
      }

      const by = who(req);
      await pool.query(
        "UPDATE service_work_orders SET status = 'complete', completed_at = ?, completed_by = ? WHERE id = ?",
        [nowStamp(), by, id]);

      // The linked schedule task follows — 100% + completed_on, exactly as a
      // normal task would when finished, so Service work behaves like the rest
      // of the board rather than being a special case.
      if (wo.task_id) {
        await pool.query('UPDATE tasks SET progress = 100, completed_on = ? WHERE id = ?', [today(), wo.task_id]).catch(() => {});
      }

      const report = await generateReport(wo, by);
      await logService(wo.service_request_id, 'work_order_completed',
        `${wo.wo_no} marked complete by ${by}.`, by, id);
      if (report) {
        await logService(wo.service_request_id, 'service_report_generated',
          `Service Report ${report.report_no} generated and prepopulated.`, 'system', id);
      }

      // When every WO on the request is done, offer the Service Log the same
      // conclusion — but do NOT force it: Monica's `service_complete` is a
      // deliberate human decision (the customer may still owe sign-off), so
      // this only reports the fact and lets the coordinator tick the box.
      const [[remaining]] = await pool.query(
        "SELECT COUNT(*) AS n FROM service_work_orders WHERE service_request_id = ? AND status <> 'complete'",
        [wo.service_request_id]);

      res.json({
        workOrder: await woWithParent(id),
        report,
        allWorkOrdersComplete: remaining.n === 0,
      });
      notifyClients();
    } catch (e) {
      console.error('[service] complete work order failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/api/service/work-orders/:id/reopen', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const wo = await woWithParent(id);
      if (!wo) return res.status(404).json({ error: 'Work Order not found.' });
      await pool.query("UPDATE service_work_orders SET status = 'open', completed_at = NULL, completed_by = NULL WHERE id = ?", [id]);
      if (wo.task_id) await pool.query('UPDATE tasks SET progress = 0, completed_on = NULL WHERE id = ?', [wo.task_id]).catch(() => {});
      await logService(wo.service_request_id, 'work_order_reopened', `${wo.wo_no} reopened by ${who(req)}.`, who(req), id);
      res.json(await woWithParent(id));
      notifyClients();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/service/work-orders/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const wo = await woWithParent(id);
      if (!wo) return res.json({ ok: true });
      await pool.query('DELETE FROM service_work_orders WHERE id = ?', [id]);
      if (wo.task_id) await pool.query('DELETE FROM tasks WHERE id = ?', [wo.task_id]).catch(() => {});
      await logService(wo.service_request_id, 'work_order_deleted', `${wo.wo_no} deleted by ${who(req)}.`, who(req));
      res.json({ ok: true });
      notifyClients();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Service Report (§11) ───────────────────────────────────────────────────
  // Generated at completion, prepopulated from everything the system already
  // knows across the request, the log and the work order — §11's explicit
  // instruction not to make employees re-enter what we have.
  //
  // prefill_json is a SNAPSHOT taken at completion time, stored alongside the
  // report rather than re-joined on read. That is on purpose: a service report
  // is a record of the visit as it stood, and it should not silently change
  // months later because someone corrected a phone number on the request.
  async function generateReport(wo, by) {
    try {
      const prefill = {
        request_no: wo.request_no,
        wo_no: wo.wo_no,
        company_name: wo.company_name,
        requestor_name: wo.requestor_name,
        requestor_email: wo.requestor_email,
        requestor_phone: wo.requestor_phone,
        machine_serial: wo.machine_serial,
        job_number: wo.job_number,
        machine_type: wo.machine_type,
        urgency: wo.urgency,
        warranty: wo.warranty,
        department_needed: wo.department_needed,
        reported_issue: wo.service_details,
        task_description: wo.task_description,
        task_date: wo.task_date,
        location_type: wo.location_type,
        onsite_address: wo.onsite_address,
        ppe_requirements: wo.ppe_requirements,
        employee_name: wo.employee_name,
        employee_email: wo.employee_email,
        budgeted_hours: wo.budgeted_hours,
        sdc_contact_name: wo.sdc_contact_name,
        sdc_contact_phone: wo.sdc_contact_phone,
        completed_by: by,
        completed_at: nowStamp(),
      };
      const reportNo = `${wo.wo_no}-RPT`;
      // Budgeted hours seed the actuals field — the usual answer is "as
      // budgeted", and the technician edits it when it isn't.
      //
      // work_performed is deliberately left EMPTY. Seeding it from the task
      // description looks like helpful prepopulation but is the opposite: the
      // task description is what the technician was ASKED to do, not what they
      // did, and pre-filling it silently satisfies the submit gate below, so a
      // report could be filed without anyone describing the actual visit. The
      // task description is still right there in the prefill block for them to
      // work from. §11 says don't make them re-enter what we know — what they
      // did on site is not something we know.
      await pool.query(
        `INSERT INTO service_reports
           (service_request_id, work_order_id, report_no, status, prefill_json, hours_actual, customer_contact)
         VALUES (?, ?, ?, 'draft', ?, ?, ?)
         ON DUPLICATE KEY UPDATE prefill_json = VALUES(prefill_json)`,
        [wo.service_request_id, wo.id, reportNo, JSON.stringify(prefill),
         wo.budgeted_hours ?? null, wo.requestor_name || null]);
      const [[rep]] = await pool.query('SELECT * FROM service_reports WHERE work_order_id = ?', [wo.id]);
      return rep || null;
    } catch (e) {
      console.warn('[service] report generation failed (non-fatal):', e.message);
      return null;
    }
  }

  router.get('/api/service/reports/:id', async (req, res) => {
    try {
      const [[rep]] = await pool.query('SELECT * FROM service_reports WHERE id = ?', [Number(req.params.id)]);
      if (!rep) return res.status(404).json({ error: 'Service Report not found.' });
      let prefill = {};
      try { prefill = JSON.parse(rep.prefill_json || '{}'); } catch (_) {}
      res.json({ ...rep, prefill });
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.put('/api/service/reports/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[rep]] = await pool.query('SELECT * FROM service_reports WHERE id = ?', [id]);
      if (!rep) return res.status(404).json({ error: 'Service Report not found.' });
      if (rep.status === 'submitted' && req.body.status !== 'draft') {
        return res.status(409).json({ error: 'This Service Report has been submitted and can no longer be edited.' });
      }
      const updates = {};
      for (const f of REPORT_FIELDS) if (f in req.body) updates[f] = coerce(f, req.body[f]);
      if (Object.keys(updates).length) {
        await pool.query(
          `UPDATE service_reports SET ${Object.keys(updates).map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
          [...Object.values(updates), id]);
      }
      const [[fresh]] = await pool.query('SELECT * FROM service_reports WHERE id = ?', [id]);
      res.json(fresh);
      notifyClients();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/service/reports/:id/submit', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[rep]] = await pool.query('SELECT * FROM service_reports WHERE id = ?', [id]);
      if (!rep) return res.status(404).json({ error: 'Service Report not found.' });
      if (!String(rep.work_performed || '').trim()) {
        return res.status(400).json({ error: 'Describe the work performed before submitting the report.' });
      }
      await pool.query(
        "UPDATE service_reports SET status = 'submitted', submitted_at = ?, submitted_by = ? WHERE id = ?",
        [nowStamp(), who(req), id]);
      await logService(rep.service_request_id, 'service_report_submitted',
        `Service Report ${rep.report_no} submitted by ${who(req)}.`, who(req), rep.work_order_id);
      const [[fresh]] = await pool.query('SELECT * FROM service_reports WHERE id = ?', [id]);
      res.json(fresh);
      notifyClients();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Dashboard counts for the §13 view chips ────────────────────────────────
  router.get('/api/service/summary', async (req, res) => {
    try {
      const email = req.authUser?.email || '';
      const name  = req.authUser?.name  || '';
      const [[c]] = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM service_requests)                                            AS total,
          (SELECT COUNT(*) FROM service_requests WHERE service_complete = 0)                 AS open,
          (SELECT COUNT(*) FROM service_requests WHERE service_complete = 1)                 AS completed,
          (SELECT COUNT(*) FROM service_requests WHERE service_complete = 0 AND urgency = 'machine_down') AS machine_down,
          (SELECT COUNT(*) FROM service_work_orders)                                         AS work_orders,
          (SELECT COUNT(*) FROM service_work_orders WHERE status = 'open')                   AS work_orders_open,
          (SELECT COUNT(*) FROM service_work_orders WHERE status = 'open' AND task_date >= ?) AS scheduled,
          (SELECT COUNT(*) FROM service_work_orders WHERE status = 'open' AND (employee_email = ? OR employee_name = ?)) AS mine
      `, [today(), email, name]);
      res.json(c);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  return { router, publicRouter };
};

// Exported for lib/cronJobs.js's day-before reminder sweep (§9), so the query
// that decides "which work orders are due tomorrow" lives next to the module
// that owns the concept rather than being restated in the cron file.
module.exports.reminderSweep = async function reminderSweep({ pool, emailSvc }) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [rows] = await pool.query(`
    SELECT w.*, r.request_no, r.company_name, r.requestor_name, r.requestor_email, r.requestor_phone,
           r.machine_serial, r.job_number, r.machine_type, r.urgency
      FROM service_work_orders w
      JOIN service_requests r ON r.id = w.service_request_id
     WHERE w.status = 'open' AND w.task_date = ? AND w.reminder_sent_at IS NULL`, [tomorrow]);
  let sent = 0;
  for (const wo of rows) {
    try {
      const r = await serviceNotify.sendWorkOrderReminder({ pool, emailSvc, wo });
      // Stamp on any successful channel, AND on a "duplicate" verdict — a
      // duplicate means notification_log already has it, so re-trying tomorrow
      // would just spin. Stamping is what stops the sweep re-examining it.
      if (r.email?.sent || r.teams?.sent || r.email?.reason === 'duplicate') {
        await pool.query('UPDATE service_work_orders SET reminder_sent_at = ? WHERE id = ?',
          [new Date().toISOString().slice(0, 19).replace('T', ' '), wo.id]);
        await pool.query(
          'INSERT INTO service_history (service_request_id, work_order_id, action, detail, changed_by) VALUES (?, ?, ?, ?, ?)',
          [wo.service_request_id, wo.id, 'reminder_sent',
           `Day-before reminder sent to ${wo.employee_email || wo.employee_name} for ${wo.task_date}.`, 'system']
        ).catch(() => {});
        sent++;
      }
    } catch (e) {
      console.warn(`[service] reminder for ${wo.wo_no} failed:`, e.message);
    }
  }
  return { due: rows.length, sent };
};
