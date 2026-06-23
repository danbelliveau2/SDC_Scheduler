'use strict';
const { Router } = require('express');

module.exports = function createRouter(deps) {
  const { pool, io, requireRole } = deps;
  const router = Router();

  router.get('/api/settings', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT `key`, value FROM settings');
      const out = {};
      for (const r of rows) {
        try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
      }
      res.json(out);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.put('/api/settings/:key', requireRole('admin'), async (req, res) => {
    try {
      const key = req.params.key;
      const value = JSON.stringify(req.body);
      await pool.query(
        'INSERT INTO settings (`key`, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
        [key, value]
      );
      res.json({ ok: true });
      io.emit('settings:updated', { key });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
