'use strict';
const { Router } = require('express');

module.exports = function createRouter(deps) {
  const { hoursApi } = deps;
  const router = Router();

  router.get('/api/hours/status', async (_req, res) => {
    if (!hoursApi.ENABLED) return res.json({ enabled: false });
    const check = await hoursApi.checkStatus().catch(e => ({ ok: false, error: e.message }));
    res.json({ enabled: true, ...check });
  });

  router.get('/api/hours/jobs/list', async (_req, res) => {
    if (!hoursApi.ENABLED) return res.status(503).json({ error: 'Job Hours not configured' });
    try { res.json(await hoursApi.getJobsList()); }
    catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.get('/api/hours/:job', async (req, res) => {
    if (!hoursApi.ENABLED) return res.status(503).json({ error: 'Job Hours not configured — set the Reports App URL and shared token (hours come from Paylocity + the Reports App DB, not Power BI).' });
    try { res.json(await hoursApi.getJobHours(req.params.job)); }
    catch (e) { res.status(503).json({ error: e.message }); }
  });

  return router;
};
