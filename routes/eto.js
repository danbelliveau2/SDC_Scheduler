'use strict';
const { Router } = require('express');

module.exports = function createRouter(deps) {
  const { pool, io, requireRole, etoDb, ops } = deps;
  const router = Router();

  // Merge a PM-entered materials estimate (job_estimates) onto the ETO base cost.
  async function applyEstimateOverride(base, job) {
    const out = { ...base, estimateSource: 'eto', etoEstimate: base.estimated };
    try {
      const [[ovr]] = await pool.query('SELECT materials_estimate FROM job_estimates WHERE job = ?', [String(job)]);
      if (ovr && ovr.materials_estimate != null) {
        const est = Number(ovr.materials_estimate);
        out.estimated = est;
        out.estimateSource = 'user';
        out.etc = Math.max(0, est - out.purchased);
        out.projection = out.purchased + out.etc;
        out.pctOfEstimate = est ? Math.round((out.purchased / est) * 100) : null;
      }
    } catch (_) { /* table may not exist yet on a fresh DB — fall back to ETO */ }
    return out;
  }

  const _readinessCache   = new Map(); // job → { at, data }
  const _vendorStatusCache = new Map();
  const _partCostCache    = new Map();

  router.get('/api/eto/status', async (_req, res) => {
    if (!etoDb.CONFIGURED) return res.json({ configured: false, connected: false });
    try {
      await etoDb.ping();
      res.json({ configured: true, connected: true });
    } catch (e) {
      res.json({ configured: true, connected: false, error: e.message });
    }
  });

  router.get('/api/eto/project/:job', async (req, res) => {
    const job = parseInt(req.params.job, 10);
    if (!Number.isInteger(job)) return res.status(400).json({ error: 'job must be a number' });
    try {
      const info = await etoDb.getProjectInfo(job);
      if (!info) return res.status(404).json({ error: `No ETO project ${job}` });
      res.json(info);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  router.get('/api/eto/costing/:job', async (req, res) => {
    const job = parseInt(req.params.job, 10);
    if (!Number.isInteger(job)) return res.status(400).json({ error: 'job must be a number' });
    try {
      const costing = await etoDb.getProjectCosting(job);
      if (!costing) return res.status(404).json({ error: `No ETO costing for project ${job}` });
      res.json(costing);
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  router.get('/api/eto/readiness/:job', async (req, res) => {
    const job = parseInt(req.params.job, 10);
    if (!Number.isInteger(job)) return res.status(400).json({ error: 'job must be a number' });
    const cached = _readinessCache.get(job);
    if (cached && !req.query.refresh && Date.now() - cached.at < 5 * 60 * 1000) {
      return res.json({ ...cached.data, cached: true });
    }
    try {
      const data = await etoDb.getReadiness(job);
      if (!data) return res.status(404).json({ error: `No ETO specs found for job ${job}` });
      _readinessCache.set(job, { at: Date.now(), data });
      res.json(data);
    } catch (e) {
      console.error('[eto] readiness failed:', e.message);
      res.status(503).json({ error: e.message });
    }
  });

  router.get('/api/eto/vendors/:job', async (req, res) => {
    const job = parseInt(req.params.job, 10);
    if (!Number.isInteger(job)) return res.status(400).json({ error: 'job must be a number' });
    const cached = _vendorStatusCache.get(job);
    if (cached && !req.query.refresh && Date.now() - cached.at < 5 * 60 * 1000) {
      return res.json({ ...cached.data, cached: true });
    }
    try {
      const data = await etoDb.getVendorStatus(job);
      _vendorStatusCache.set(job, { at: Date.now(), data });
      res.json(data);
    } catch (e) {
      console.error('[eto] vendor status failed:', e.message);
      res.status(503).json({ error: e.message });
    }
  });

  router.get('/api/eto/partcost/:job', async (req, res) => {
    const job = parseInt(req.params.job, 10);
    if (!Number.isInteger(job)) return res.status(400).json({ error: 'job must be a number' });
    const cached = _partCostCache.get(job);
    if (cached && !req.query.refresh && Date.now() - cached.at < 5 * 60 * 1000) {
      return res.json({ ...(await applyEstimateOverride(cached.data, job)), cached: true });
    }
    try {
      const data = await etoDb.getPartCost(job);
      _partCostCache.set(job, { at: Date.now(), data });
      res.json(await applyEstimateOverride(data, job));
    } catch (e) {
      console.error('[eto] part cost failed:', e.message);
      res.status(503).json({ error: e.message });
    }
  });

  router.put('/api/eto/partcost/:job/estimate', requireRole('editor'), async (req, res) => {
    const job = parseInt(req.params.job, 10);
    if (!Number.isInteger(job)) return res.status(400).json({ error: 'job must be a number' });
    const raw = req.body ? req.body.estimate : undefined;
    if (raw === null || raw === '' || raw === undefined) {
      await pool.query('DELETE FROM job_estimates WHERE job = ?', [String(job)]);
      return res.json({ ok: true, cleared: true });
    }
    const n = Number(raw);
    if (!isFinite(n) || n < 0) return res.status(400).json({ error: 'estimate must be a non-negative number' });
    await pool.query(
      `INSERT INTO job_estimates (job, materials_estimate, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE materials_estimate = VALUES(materials_estimate), updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
      [String(job), n, (req.authUser && req.authUser.name) || req.user || null]);
    res.json({ ok: true, estimate: n });
  });

  router.post('/api/eto/sync-vendor-pos', requireRole('editor'), async (req, res) => {
    const scope = req.body && req.body.scope === 'all' ? 'all' : 'linked';
    try {
      const result = await etoDb.syncVendorPOs(pool, scope);
      ops.recordEtoSync(result);
      res.json({ ok: true, ...result });
      if (result.created || result.updated) io.emit('vendor_pos:updated');
    } catch (e) {
      console.error('[eto] vendor PO sync failed:', e.message);
      res.status(503).json({ error: e.message });
    }
  });

  router.get('/api/eto/po/:job/:po/lines', async (req, res) => {
    const job = parseInt(req.params.job, 10);
    const po = parseInt(req.params.po, 10);
    if (!Number.isInteger(job) || !Number.isInteger(po)) return res.status(400).json({ error: 'job and po must be numbers' });
    try {
      res.json(await etoDb.getPoLines(job, po));
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  return router;
};
