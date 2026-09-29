'use strict';
/**
 * portal.js — the customer-facing portal API: login, session, and the
 * customer-scoped analytics dashboard. Mounted on the SNAPSHOT_PUBLIC_PORT
 * listener in server.js (the tunnel-facing "portal" listener), never on
 * the main app — same isolation reasoning as the Service module.
 *
 * Every route here is customer-facing and public-reachable, so every route
 * either requires a valid customer session (requireCustomerAuth) or is the
 * login step itself. Nothing here ever trusts a client-supplied customer
 * name — the logged-in session's req.customerName is the only source of
 * "whose data is this."
 *
 * createStaffRouter (below) is the opposite of all that: a small STAFF-only
 * router — requireRole('editor'), mounted on the MAIN app — for creating,
 * resetting, and disabling a customer's login. Kept in this file because it
 * shares the customer_accounts schema and the password-generation logic, not
 * because it belongs on the public listener; server.js mounts it separately.
 */
const { Router } = require('express');
const bcrypt = require('bcryptjs');
const {
  signCustomerToken, setCustomerSessionCookie, clearCustomerSessionCookie, requireCustomerAuth,
} = require('../lib/customerAuth');
const { createRateLimiter, clientIp } = require('../lib/rateLimit');
// Shared with public/app.js's Portal tab (loaded there as the browser
// global PortalCalc via a <script> tag) — one copy of this math, not two
// that can drift out of sync. See public/portalCalc.js's own header.
const calc = require('../public/portalCalc');

// Tighter than the service form's public intake (8/hr): the username here
// is a customer name, which is guessable, so a brute-force attempt only
// needs to try passwords. 5 attempts / 15 min per IP is a real speed bump
// without locking out someone who fat-fingers their password twice.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_MAX = Number(process.env.PORTAL_LOGIN_RATE_MAX || 5);
const rateLimited = createRateLimiter({ windowMs: LOGIN_WINDOW_MS });

module.exports = function createPortalRouter({ pool }) {
  const router = Router();

  router.post('/portal/api/login', async (req, res) => {
    try {
      const ip = clientIp(req);
      if (rateLimited(ip, LOGIN_RATE_MAX)) {
        return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.', code: 'RATE_LIMITED' });
      }
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
      }
      const [[account]] = await pool.query(
        'SELECT * FROM customer_accounts WHERE LOWER(username) = LOWER(?) AND disabled_at IS NULL', [username]
      );
      // Same generic error whether the username doesn't exist or the
      // password is wrong — a distinct "no such user" message lets an
      // attacker enumerate valid customer logins for free.
      const bad = () => res.status(401).json({ error: 'Incorrect username or password.', code: 'BAD_CREDENTIALS' });
      if (!account) return bad();
      const ok = await bcrypt.compare(password, account.password_hash);
      if (!ok) return bad();

      await pool.query('UPDATE customer_accounts SET last_login_at = NOW() WHERE id = ?', [account.id]);
      const token = signCustomerToken(account);
      setCustomerSessionCookie(res, token);
      res.json({ ok: true, customerName: account.customer_name, mustChangePassword: !!account.must_change_password });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/portal/api/logout', (_req, res) => {
    clearCustomerSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/portal/api/me', requireCustomerAuth, (req, res) => {
    res.json({ ok: true, customerName: req.customerName });
  });

  router.post('/portal/api/change-password', requireCustomerAuth, async (req, res) => {
    try {
      const current = String(req.body?.currentPassword || '');
      const next = String(req.body?.newPassword || '');
      if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
      const [[account]] = await pool.query('SELECT * FROM customer_accounts WHERE id = ?', [req.customerAccountId]);
      if (!account) return res.status(404).json({ error: 'Account not found.' });
      const ok = await bcrypt.compare(current, account.password_hash);
      if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
      const hash = await bcrypt.hash(next, 12);
      await pool.query('UPDATE customer_accounts SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hash, req.customerAccountId]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The full analytics dashboard: every non-template project this customer
  // owns (projects.customer, the ETC-Planner-synced column — see the plan's
  // decision on why this replaces the internal Portal tab's old 4-entry
  // manual-only list), each broken into machine units, with Progress,
  // Where-it-stands, Payment milestones and Risk plan computed per
  // lib/portalCalc.js — the same formulas already verified against the
  // internal staff Portal tab.
  // Matches public/app.js's PORTAL_RECENT_WINDOWS exactly — the "Completed
  // recently" window in Event Status. Any other value falls back to 30.
  const RECENT_WINDOWS = new Set([14, 30, 60]);

  router.get('/portal/api/dashboard', requireCustomerAuth, async (req, res) => {
    try {
      const recentDays = RECENT_WINDOWS.has(Number(req.query.recentDays)) ? Number(req.query.recentDays) : 30;
      const [projectRows] = await pool.query(
        'SELECT id, name, share_token, workspace FROM projects WHERE customer = ? AND (is_template = 0 OR is_template IS NULL) ORDER BY name ASC',
        [req.customerName]
      );
      if (!projectRows.length) {
        return res.json({ ok: true, customerName: req.customerName, projects: [], units: [] });
      }

      // Mint a share token for any project that doesn't have one yet, so
      // "Open" always has a live link to send the customer to (Phase 5 wires
      // up where that link actually resolves).
      for (const p of projectRows) {
        if (!p.share_token) {
          const token = require('crypto').randomBytes(24).toString('hex');
          await pool.query('UPDATE projects SET share_token = ? WHERE id = ?', [token, p.id]);
          p.share_token = token;
        }
      }

      const names = projectRows.map(p => p.name);
      const [rawTaskRows] = await pool.query(
        `SELECT * FROM tasks WHERE project IN (${names.map(() => '?').join(',')})`, names
      );
      // Collapses duplicate anchor-named tasks (e.g. two "SAT" rows on the
      // same project — a real data state, not hypothetical) the same way
      // the staff app does client-side, or every count that touches an
      // affected project drifts from what the internal Portal tab shows.
      const taskRows = calc.normalizeTasks(rawTaskRows);
      const [finRows] = await pool.query(
        `SELECT * FROM project_financials WHERE project IN (${names.map(() => '?').join(',')})`, names
      );
      const [[riskSettingsRow]] = await pool.query('SELECT value FROM settings WHERE `key` = ?', ['risk_plans']);
      const riskPlans = riskSettingsRow ? JSON.parse(riskSettingsRow.value) : {};
      const [[leadsSettingsRow]] = await pool.query('SELECT value FROM settings WHERE `key` = ?', ['project_leads']);
      const projectLeads = leadsSettingsRow ? JSON.parse(leadsSettingsRow.value) : {};
      const [teamMembers] = await pool.query('SELECT name, discipline, specialty, active FROM team_members');

      const tasksByProject = new Map(names.map(n => [n, []]));
      taskRows.forEach(t => tasksByProject.get(t.project)?.push(t));
      const finByProject = new Map(names.map(n => [n, []]));
      finRows.forEach(f => finByProject.get(f.project)?.push(f));

      let unitCount = 0;
      const units = [];
      const projects = projectRows.map(p => {
        const rows = tasksByProject.get(p.name) || [];
        const isSales = p.workspace === 'Sales';
        const rawUnits = calc.portalUnits(rows);
        unitCount += rawUnits.length;
        const tasksById = new Map(rows.map(t => [t.id, t]));
        rawUnits.forEach(u => {
          units.push({
            project: p.name,
            machine: u.machine,
            due: calc.portalDueRow(u),
            progress: calc.portalProgress(u.rows),
            // Per-machine Event Status, so picking a single machine on a
            // multi-machine job shows that machine's own events — not the
            // whole job's — same as the internal Portal tab.
            eventStatus: u.rows.length ? {
              mix: calc.portalTaskMix(u.rows, isSales),
              deptChart: calc.portalDeptChart(u.rows, isSales),
              work: calc.portalWork(u.rows, isSales, recentDays),
              recentDays,
            } : null,
          });
        });
        return {
          id: p.id,
          name: p.name,
          shareToken: p.share_token,
          isSales,
          machines: rawUnits.map(u => u.machine).filter(Boolean),
          money: calc.portalMoney(finByProject.get(p.name) || [], tasksById, rows),
          risk: calc.portalRisk(riskPlans[p.name], rows),
          team: calc.portalTeam(rows, teamMembers, projectLeads[p.name]),
          eventStatus: rows.length ? {
            mix: calc.portalTaskMix(rows, isSales),
            deptChart: calc.portalDeptChart(rows, isSales),
            work: calc.portalWork(rows, isSales, recentDays),
            recentDays,
          } : null,
        };
      });

      // Raw ingredients too, alongside the pre-computed summaries above —
      // the customer page's own render call now uses these directly (via
      // public/portalRender.js, the SAME functions public/app.js's Portal
      // tab uses), rather than a second, separately-maintained computation.
      const financialsByProject = {};
      finByProject.forEach((rows, name) => { financialsByProject[name] = rows; });

      res.json({
        ok: true,
        customerName: req.customerName,
        projectCount: projects.length,
        unitCount,
        projects,
        units,
        recentDays,
        rawTasks: taskRows,
        financials: financialsByProject,
        riskPlans,
        projectLeads,
        teamMembers,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { router };
};

// Same word-word-word-NN shape as routes/users.js's _genTempPassword() —
// easy for staff to read aloud or paste into a chat message.
const PASSWORD_WORDS = ['blue', 'lime', 'gear', 'bolt', 'fast', 'spark', 'steel', 'motor', 'shaft', 'cam', 'weld', 'panel'];
function genCustomerPassword() {
  const pick = () => PASSWORD_WORDS[Math.floor(Math.random() * PASSWORD_WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${Math.floor(10 + Math.random() * 89)}`;
}

module.exports.createStaffRouter = function createStaffRouter({ pool, requireRole }) {
  const staffRouter = Router();

  staffRouter.get('/api/portal/customer-accounts/:customerName', requireRole('editor'), async (req, res) => {
    try {
      const [[account]] = await pool.query(
        'SELECT id, customer_name, username, must_change_password, created_at, last_login_at, disabled_at FROM customer_accounts WHERE customer_name = ?',
        [req.params.customerName]
      );
      res.json({ ok: true, account: account || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Create-or-reset in one step: a customer with no login yet gets one, a
  // customer who already has one gets a fresh password (their username never
  // changes). Re-enables a disabled account too — resetting a login is a
  // deliberate "let them back in" action.
  staffRouter.post('/api/portal/customer-accounts/:customerName', requireRole('editor'), async (req, res) => {
    try {
      const customerName = req.params.customerName;
      if (!customerName.trim()) return res.status(400).json({ error: 'Customer name is required.' });
      const password = genCustomerPassword();
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        `INSERT INTO customer_accounts (customer_name, username, password_hash)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), disabled_at = NULL`,
        [customerName, customerName, hash]
      );
      res.json({ ok: true, username: customerName, password });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  staffRouter.post('/api/portal/customer-accounts/:customerName/disable', requireRole('editor'), async (req, res) => {
    try {
      await pool.query('UPDATE customer_accounts SET disabled_at = NOW() WHERE customer_name = ?', [req.params.customerName]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  staffRouter.post('/api/portal/customer-accounts/:customerName/enable', requireRole('editor'), async (req, res) => {
    try {
      await pool.query('UPDATE customer_accounts SET disabled_at = NULL WHERE customer_name = ?', [req.params.customerName]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { staffRouter };
};
