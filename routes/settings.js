'use strict';
const { Router } = require('express');

module.exports = function createRouter(deps) {
  const { pool, io, requireRole } = deps;
  const router = Router();

  router.get('/api/settings', async (req, res) => {
    try {
      // project_estimate:* and project_quote:* hold base64 .xlsx blobs (tens of MB total) —
      // they're fetched individually via /api/project/:project/quote and .../estimate-file,
      // never read off the bulk settings object, so excluding them here just drops dead
      // weight. Without this, every page load and every settings:updated / socket-reconnect
      // refetch pulls the entire multi-MB blob set for no reason.
      const [rows] = await pool.query(
        "SELECT `key`, value FROM settings WHERE `key` NOT LIKE 'project_estimate:%' AND `key` NOT LIKE 'project_quote:%'"
      );
      const out = {};
      for (const r of rows) {
        try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
      }
      res.json(out);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // Most settings are admin-only (colors, thresholds), but a few keys are
  // normal PM workflow — editors may write those.
  const EDITOR_KEYS = new Set(['project_leads']); // { "<project>": { pm, debug } }
  router.put('/api/settings/:key',
    (req, res, next) => requireRole(EDITOR_KEYS.has(req.params.key) ? 'editor' : 'admin')(req, res, next),
    async (req, res) => {
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
