'use strict';
const { Router } = require('express');

function _randomAvatarColor() {
  const colors = ['#1574c4','#059669','#d97706','#7c3aed','#db2777','#0891b2','#65a30d','#dc2626','#9333ea','#0d9488'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function _genTempPassword() {
  const words = ['blue', 'lime', 'gear', 'bolt', 'fast', 'spark', 'steel', 'motor', 'shaft', 'cam', 'weld', 'panel'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${pick()}-${Math.floor(10 + Math.random() * 89)}`;
}

module.exports = function createRouter(deps) {
  const { pool, io, requireRole, bcrypt, _activeCache } = deps;
  const router = Router();

  router.get('/api/users', requireRole('admin'), async (_req, res) => {
    try {
      const [rows] = await pool.query('SELECT id,email,name,role,active,avatar_color,created_at,last_login FROM users ORDER BY name');
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.post('/api/users', requireRole('admin'), async (req, res) => {
    const email        = (req.body.email        || '').toString().trim().toLowerCase().slice(0, 254);
    const name         = (req.body.name         || '').toString().trim().slice(0, 100);
    const password     = (req.body.password     || '').toString().slice(0, 1024);
    const role         = (req.body.role         || 'editor');
    const avatar_color = (req.body.avatar_color || _randomAvatarColor()).toString().slice(0, 20);
    if (!email || !name || !password) return res.status(400).json({ error: 'email, name, password required' });
    if (!['viewer', 'editor', 'admin'].includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (String(password).length < 1) return res.status(400).json({ error: 'Password is required.' });
    try {
      const [r] = await pool.query(
        'INSERT INTO users (email,name,password_hash,role,active,avatar_color) VALUES (?,?,?,?,1,?)',
        [email, name, await bcrypt.hash(password, 12), role, avatar_color]
      );
      io.emit('users:updated');
      const [[newUser]] = await pool.query('SELECT id,email,name,role,active,avatar_color,created_at,last_login FROM users WHERE id=?', [r.insertId]);
      res.status(201).json(newUser);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY' || String(e.message).includes('Duplicate entry') || String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered.' });
      res.status(500).json({ error: 'Failed to create user: ' + e.message });
    }
  });

  router.put('/api/users/:id', requireRole('admin'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[u]] = await pool.query('SELECT * FROM users WHERE id=?', [id]);
      if (!u) return res.status(404).json({ error: 'not found' });
      const allowed = ['email', 'name', 'role', 'active', 'avatar_color'];
      const upd = {};
      for (const k of allowed) {
        if (req.body[k] === undefined) continue;
        if (k === 'active') upd[k] = req.body[k] ? 1 : 0;
        else if (k === 'email') upd[k] = String(req.body[k]).trim().toLowerCase().slice(0, 254);
        else if (k === 'name') upd[k] = String(req.body[k]).trim().slice(0, 100);
        else upd[k] = req.body[k];
      }
      if (req.body.password) upd.password_hash = await bcrypt.hash(String(req.body.password).slice(0, 1024), 12);
      if (!Object.keys(upd).length) return res.json(u);
      const setClause = Object.keys(upd).map(k => `${k}=?`).join(',');
      await pool.query(`UPDATE users SET ${setClause} WHERE id=?`, [...Object.values(upd), id]);
      // Invalidate active cache so a disable/enable takes effect within the next request.
      _activeCache.delete(id);
      io.emit('users:updated');
      const [[updUser]] = await pool.query('SELECT id,email,name,role,active,avatar_color,created_at,last_login FROM users WHERE id=?', [id]);
      res.json(updUser);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Hard-delete a user account. Guarded: you can't delete yourself, and you can't
  // remove the last admin (that would lock everyone out of user management).
  router.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[u]] = await pool.query('SELECT id, role FROM users WHERE id=?', [id]);
      if (!u) return res.status(404).json({ error: 'User not found' });
      if (req.authUser && Number(req.authUser.id) === id) {
        return res.status(400).json({ error: "You can't delete your own account." });
      }
      if (u.role === 'admin') {
        const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND id<>?", [id]);
        if (n === 0) return res.status(400).json({ error: "Can't delete the last admin account." });
      }
      await pool.query('DELETE FROM users WHERE id=?', [id]);
      _activeCache.delete(id);
      io.emit('users:updated');
      res.json({ ok: true, deleted: id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Admin "unlock this person" — set a new password (or generate a temp one) and
  // re-activate the account in a single call.
  router.post('/api/users/:id/reset-password', requireRole('admin'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[u]] = await pool.query('SELECT id,email,name FROM users WHERE id=?', [id]);
      if (!u) return res.status(404).json({ error: 'User not found' });
      let pw = (req.body && req.body.new_password ? String(req.body.new_password) : '').trim().slice(0, 1024);
      let generated = false;
      if (!pw) { pw = _genTempPassword(); generated = true; }
      if (pw.length < 1) return res.status(400).json({ error: 'New password cannot be empty.' });
      const hash = await bcrypt.hash(pw, 12);
      await pool.query('UPDATE users SET password_hash=?, active=1 WHERE id=?', [hash, id]);
      _activeCache.delete(id);
      io.emit('users:updated');
      res.json({ ok: true, email: u.email, name: u.name, reactivated: true, tempPassword: pw, generated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
