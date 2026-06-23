'use strict';
const { Router } = require('express');

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
