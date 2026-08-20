'use strict';
const { Router } = require('express');

// Server-to-server integration API for OTHER SDC apps (not signed-in users)
// to read a project's schedule dates by ETO ProjectID — the same join key
// etoDb.js already uses: scheduler projects.job_number === ETO ProjectID.
//
// Mounted BEFORE the global requireAuth guard in server.js (see the "Public
// auth routes" section there) since a caller here is another server process,
// not a browser session. Authenticated instead via a bearer token that must
// match READINESS_SHARED_TOKEN on both this app and the caller's — same
// pattern as lib/plannerClient.js's SCHEDULER_SHARED_TOKEN, just the other
// direction (Build Readiness Report calling in, instead of this app calling
// out to the ETC Planner).
//
// First consumer: Build_Readiness_Report/server/services/scheduler.js,
// added to replace the removed Smartsheet integration's build/ship dates.
module.exports = function createRouter(deps) {
  const { pool } = deps;
  const router = Router();

  const TOKEN = process.env.READINESS_SHARED_TOKEN || '';

  function requireSharedToken(req, res, next) {
    if (!TOKEN) return res.status(503).json({ error: 'READINESS_SHARED_TOKEN not configured on this server' });
    const auth = req.get('authorization') || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (provided !== TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }

  // GET /api/integration/project-dates/:jobNumber
  router.get('/api/integration/project-dates/:jobNumber', requireSharedToken, async (req, res) => {
    try {
      const [rows] = await pool.query(
        'SELECT job_number, est_start_date, complete_date FROM projects WHERE job_number = ? LIMIT 1',
        [String(req.params.jobNumber)]
      );
      if (!rows[0]) {
        return res.status(404).json({ error: `No scheduler project for job ${req.params.jobNumber}` });
      }
      res.json({
        jobNumber:  rows[0].job_number,
        buildStart: rows[0].est_start_date,
        shipDate:   rows[0].complete_date,
      });
    } catch (e) {
      console.error('[integration] project-dates failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
