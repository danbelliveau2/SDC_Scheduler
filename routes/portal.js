'use strict';
/**
 * portal.js — the customer-facing portal API: login and session only.
 * Mounted on the SNAPSHOT_PUBLIC_PORT listener in server.js (the
 * tunnel-facing "portal" listener), never on the main app — same isolation
 * reasoning as the Service module.
 *
 * Used to ALSO serve a full analytics dashboard endpoint here (every
 * project/task/financial/risk-plan row a customer's login could see, in one
 * JSON payload) for a standalone client page to render. Retired: a customer
 * session now runs the REAL app.js instead of a page trying to imitate it,
 * so that data comes from the same endpoints app.js already calls for
 * staff (/api/tasks, /api/financials, /api/settings, ...) — each one scoped
 * server-side by req.shareCustomer when the request carries a valid
 * customer session, in server.js. Nothing here needs to know what a
 * dashboard even looks like anymore.
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
