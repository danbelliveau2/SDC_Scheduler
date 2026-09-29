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
      // Customer portal session (req.shareCustomer) or a single-project share
      // link (req.shareProject) → risk_plans and project_leads are keyed by
      // project name and hold other customers'/projects' data (risk register
      // text, who's the PM) that this viewer has no business receiving even
      // if the UI never displays it. Every OTHER settings key (colors,
      // thresholds, app-wide config) isn't project-specific and stays as-is —
      // this is a targeted fix for the two keys the portal actually reads,
      // not a full settings audit.
      const scopeProject = req.shareProject || null;
      if (scopeProject || req.shareCustomer) {
        for (const key of ['risk_plans', 'project_leads']) {
          if (!out[key] || typeof out[key] !== 'object') continue;
          const allowed = scopeProject
            ? new Set([scopeProject])
            : new Set((await pool.query('SELECT name FROM projects WHERE customer = ?', [req.shareCustomer]))[0].map(r => r.name));
          const filtered = {};
          for (const proj of Object.keys(out[key])) {
            if (allowed.has(proj)) filtered[proj] = out[key][proj];
          }
          out[key] = filtered;
        }
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
