'use strict';
const { Router } = require('express');

// Scheduler-side proxy to the SDC ETC Planner integration API. The browser
// (public/app.js "create project from job list" picker) calls these; they run
// server-to-server via plannerClient so the shared token never reaches the
// client. All GETs are read-only and available to any signed-in user (the
// global requireAuth guard already applies). NOTE: distinct from routes/eto.js
// — "eto" is the Total ETO ERP; "planner" is the sibling ETC Planner app.
module.exports = function createRouter(deps) {
  const { plannerClient } = deps;
  const router = Router();

  const _detailCache = new Map(); // jobId → { at, data }
  const DETAIL_TTL = 60 * 1000;

  router.get('/api/planner/status', async (_req, res) => {
    if (!plannerClient.CONFIGURED) return res.json({ configured: false, connected: false });
    try {
      const r = await plannerClient.ping();
      res.json({ configured: true, connected: true, ...r });
    } catch (e) {
      res.json({ configured: true, connected: false, error: e.message });
    }
  });

  router.get('/api/planner/jobs', async (req, res) => {
    if (!plannerClient.CONFIGURED) return res.status(503).json({ error: 'ETC Planner not configured' });
    try {
      const jobs = await plannerClient.getJobs({ q: req.query.q, status: req.query.status });
      res.json({ jobs });
    } catch (e) {
      console.error('[planner] job list failed:', e.message);
      res.status(503).json({ error: e.message });
    }
  });

  router.get('/api/planner/jobs/:jobId', async (req, res) => {
    if (!plannerClient.CONFIGURED) return res.status(503).json({ error: 'ETC Planner not configured' });
    const jobId = req.params.jobId;
    const cached = _detailCache.get(jobId);
    if (cached && !req.query.refresh && Date.now() - cached.at < DETAIL_TTL) {
      return res.json({ ...cached.data, cached: true });
    }
    try {
      const data = await plannerClient.getJobDetail(jobId);
      if (!data) return res.status(404).json({ error: `No planner job ${jobId}` });
      _detailCache.set(jobId, { at: Date.now(), data });
      res.json(data);
    } catch (e) {
      console.error('[planner] job detail failed:', e.message);
      res.status(503).json({ error: e.message });
    }
  });

  return router;
};
