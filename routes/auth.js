'use strict';
const { Router } = require('express');
const crypto = require('crypto');

// ── Spent SSO nonces (in-memory) ─────────────────────────────────────────────
// Tokens from the ETC Planner are single-use. In-memory is the right scope: the
// tokens live 60 seconds, so a restart losing the set costs nothing worse than
// allowing a replay of a token that is almost certainly already expired.
const _ssoSpent = new Map();
const SSO_NONCE_TTL_MS = 5 * 60 * 1000;
function _ssoRemember(nonce) {
  const now = Date.now();
  _ssoSpent.set(nonce, now + SSO_NONCE_TTL_MS);
  if (_ssoSpent.size > 500) {
    for (const [k, until] of _ssoSpent) if (until < now) _ssoSpent.delete(k);
  }
}

// ── Login rate limiter (in-memory) ───────────────────────────────────────────
const _loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS    = 15 * 60 * 1000; // 15 min
function _loginBlocked(email) {
  const rec = _loginAttempts.get(email);
  if (!rec) return false;
  if (Date.now() > rec.until) { _loginAttempts.delete(email); return false; }
  return rec.count >= LOGIN_MAX_ATTEMPTS;
}
function _loginFail(email) {
  const rec = _loginAttempts.get(email) || { count: 0, until: Date.now() + LOGIN_WINDOW_MS };
  rec.count++;
  rec.until = Date.now() + LOGIN_WINDOW_MS;
  _loginAttempts.set(email, rec);
}
function _loginOk(email) { _loginAttempts.delete(email); }

function _randomAvatarColor() {
  const colors = ['#1574c4','#059669','#d97706','#7c3aed','#db2777','#0891b2','#65a30d','#dc2626','#9333ea','#0d9488'];
  return colors[Math.floor(Math.random() * colors.length)];
}

module.exports = function createRouter(deps) {
  const { pool, io, requireAuth, signToken, bcrypt, AUTH_ENABLED } = deps;
  const router = Router();

  router.post('/api/auth/login', async (req, res) => {
    try {
      const email    = (req.body.email    || '').toString().trim().toLowerCase().slice(0, 254);
      const password = (req.body.password || '').toString().slice(0, 1024);
      if (!email || !password) return res.status(400).json({ error: 'email and password required' });
      if (_loginBlocked(email)) {
        return res.status(429).json({ error: 'Too many failed attempts. Wait 15 minutes and try again.', code: 'RATE_LIMITED' });
      }
      const [rows] = await pool.query('SELECT * FROM users WHERE LOWER(TRIM(email)) = ?', [email]);
      const user = rows[0] || null;
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        _loginFail(email);
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      if (!user.active) {
        return res.status(403).json({ error: 'This account is disabled. Ask an admin to re-enable it (Setup → Users).', code: 'ACCOUNT_DISABLED' });
      }
      _loginOk(email);
      await pool.query('UPDATE users SET last_login = ? WHERE id = ?', [new Date().toISOString().slice(0, 19).replace('T', ' '), user.id]);
      const token = signToken(user);
      res.json({
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar_color: user.avatar_color },
      });
    } catch (e) { res.status(500).json({ error: 'Login failed: ' + e.message }); }
  });

  // ── SSO hand-off from the SDC ETC Planner ───────────────────────────────────
  // The planner already authenticated the person; this exchanges its short-lived
  // signed assertion for a normal Scheduler session, so following a link from
  // there does not stop at the login modal.
  //
  // Trust anchor is SCHEDULER_SHARED_TOKEN — the secret the two apps already use
  // for their server-to-server calls. The message is domain-prefixed ("sso:v1"),
  // so a token minted for this cannot be replayed as a raw bearer token against
  // the integration endpoints, and vice versa.
  //
  // It does NOT create accounts. An assertion says who someone is; whether they
  // may use the Scheduler is this app's decision. An unknown email gets 404 and
  // the client falls back to the normal login form.
  router.post('/api/auth/sso', async (req, res) => {
    try {
      const secret = process.env.SCHEDULER_SHARED_TOKEN || '';
      if (!secret) return res.status(503).json({ error: 'SSO is not configured on this server.' });

      const raw = (req.body && req.body.token ? String(req.body.token) : '').slice(0, 2048);
      const [payload, sig] = raw.split('.');
      if (!payload || !sig) return res.status(400).json({ error: 'Malformed SSO token.' });

      const expected = crypto.createHmac('sha256', secret).update('sso:v1:' + payload).digest('base64url');
      // Length check first: timingSafeEqual throws on mismatched lengths.
      if (sig.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return res.status(401).json({ error: 'Invalid SSO token.' });
      }

      let body;
      try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
      catch { return res.status(400).json({ error: 'Malformed SSO token.' }); }

      const email = (body && body.e ? String(body.e) : '').trim().toLowerCase();
      const exp   = Number(body && body.x);
      const nonce = body && body.n ? String(body.n) : '';
      if (!email || !exp || !nonce) return res.status(400).json({ error: 'Incomplete SSO token.' });
      if (exp < Math.floor(Date.now() / 1000)) return res.status(401).json({ error: 'SSO token expired.' });

      // Single use. A token lives ~60s; remembering spent nonces for a few
      // minutes is enough to stop a replay from browser history or a log, and the
      // map is swept so it cannot grow without bound.
      if (_ssoSpent.has(nonce)) return res.status(401).json({ error: 'SSO token already used.' });
      _ssoRemember(nonce);

      const [rows] = await pool.query('SELECT * FROM users WHERE LOWER(TRIM(email)) = ?', [email]);
      const user = rows[0] || null;
      // 404, not 401: the token was perfectly valid, this app just has no such
      // user. The client distinguishes them — one is "sign in normally", the other
      // means something is wrong with the hand-off.
      if (!user) return res.status(404).json({ error: 'No Scheduler account for ' + email, code: 'NO_ACCOUNT' });
      if (!user.active) {
        return res.status(403).json({ error: 'This account is disabled. Ask an admin to re-enable it.', code: 'ACCOUNT_DISABLED' });
      }

      await pool.query('UPDATE users SET last_login = ? WHERE id = ?',
        [new Date().toISOString().slice(0, 19).replace('T', ' '), user.id]);
      res.json({
        token: signToken(user),
        user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar_color: user.avatar_color },
      });
    } catch (e) { res.status(500).json({ error: 'SSO failed: ' + e.message }); }
  });

  router.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.authUser, auth_enabled: AUTH_ENABLED });
  });

  router.put('/api/auth/password', requireAuth, async (req, res) => {
    try {
      const { current_password, new_password } = req.body || {};
      if (!current_password || !new_password)
        return res.status(400).json({ error: 'current_password and new_password are required' });
      if (String(new_password).length < 1)
        return res.status(400).json({ error: 'New password cannot be empty.' });
      const [urows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.authUser.id]);
      const user = urows[0] || null;
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (!(await bcrypt.compare(current_password, user.password_hash)))
        return res.status(401).json({ error: 'Current password is incorrect' });
      const hash = await bcrypt.hash(String(new_password), 12);
      await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
      res.json({ ok: true, message: 'Password updated successfully' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/auth/register', async (req, res) => {
    const email    = (req.body.email    || '').toString().trim().toLowerCase().slice(0, 254);
    const name     = (req.body.name     || '').toString().trim().slice(0, 100);
    const password = (req.body.password || '').toString().slice(0, 1024);
    const avatar_color = (req.body.avatar_color || _randomAvatarColor()).toString().slice(0, 20);
    if (!email || !name || !password) return res.status(400).json({ error: 'email, name, password required' });
    if (password.length < 1)           return res.status(400).json({ error: 'Password is required.' });
    try {
      const hash = await bcrypt.hash(password, 12);
      const [r] = await pool.query(
        `INSERT INTO users (email, name, password_hash, role, avatar_color) VALUES (?, ?, ?, 'editor', ?)`,
        [email, name, hash, avatar_color]
      );
      const [urows] = await pool.query('SELECT * FROM users WHERE id = ?', [r.insertId]);
      const user = urows[0];
      const token = signToken(user);
      io.emit('users:updated');
      res.status(201).json({
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar_color: user.avatar_color },
      });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY' || String(e.message).includes('Duplicate entry') || String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already registered. Try signing in.' });
      res.status(500).json({ error: 'Failed to register: ' + e.message });
    }
  });

  return router;
};

module.exports._randomAvatarColor = _randomAvatarColor;
