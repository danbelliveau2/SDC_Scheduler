'use strict';
const { Router } = require('express');

const FIN_FIELDS = ['name', 'percent', 'amount', 'due_date', 'paid', 'predecessors', 'sync_to_anchor', 'sort_order'];

module.exports = function createRouter(deps) {
  const { pool, requireRole } = deps;
  const router = Router();

  router.get('/api/financials', async (req, res) => {
    try {
      const project = (req.query.project || '').toString();
      const [rows] = project
        ? await pool.query('SELECT * FROM project_financials WHERE project = ? ORDER BY sort_order, id', [project])
        : await pool.query('SELECT * FROM project_financials ORDER BY project, sort_order, id');
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.post('/api/financials', requireRole('editor'), async (req, res) => {
    try {
      const project = (req.body.project || '').toString().trim();
      if (!project) return res.status(400).json({ error: 'project required' });
      const name = (req.body.name || '').toString().trim();
      const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_financials WHERE project = ?', [project]);
      const [result] = await pool.query(
        'INSERT INTO project_financials (project, name, percent, amount, due_date, paid, predecessors, sync_to_anchor, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [project, name,
         req.body.percent != null ? Number(req.body.percent) : null,
         req.body.amount  != null ? Number(req.body.amount)  : null,
         req.body.due_date || null,
         req.body.paid ? 1 : 0,
         req.body.predecessors || null,
         req.body.sync_to_anchor || null,
         maxRow.m + 1]
      );
      const [[row]] = await pool.query('SELECT * FROM project_financials WHERE id = ?', [result.insertId]);
      res.json(row);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/api/financials/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT * FROM project_financials WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'not found' });
      const updates = {};
      for (const f of FIN_FIELDS) {
        if (f in req.body) {
          if (f === 'paid') updates[f] = req.body[f] ? 1 : 0;
          else if (f === 'percent' || f === 'amount') updates[f] = req.body[f] == null ? null : Number(req.body[f]);
          else if (f === 'name') updates[f] = (req.body[f] || '').toString().trim();
          else updates[f] = req.body[f] || null;
        }
      }
      if (Object.keys(updates).length === 0) return res.json(existing);
      const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      await pool.query(`UPDATE project_financials SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
      const [[row]] = await pool.query('SELECT * FROM project_financials WHERE id = ?', [id]);
      res.json(row);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/financials/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      await pool.query('DELETE FROM project_financials WHERE id = ?', [id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/financials/seed', requireRole('editor'), async (req, res) => {
    try {
      const project = (req.body.project || '').toString().trim();
      if (!project) return res.status(400).json({ error: 'project required' });
      const [[existingFin]] = await pool.query('SELECT COUNT(*) AS n FROM project_financials WHERE project = ?', [project]);
      if (existingFin.n > 0) return res.json({ ok: true, seeded: 0 });
      const [[defRow]] = await pool.query("SELECT value FROM settings WHERE `key` = 'default_financial_milestones'");
      let defaults = [];
      try { defaults = JSON.parse(defRow?.value || '[]'); } catch { defaults = []; }
      for (let i = 0; i < defaults.length; i++) {
        const d = defaults[i];
        await pool.query(
          'INSERT INTO project_financials (project, name, percent, amount, due_date, paid, predecessors, sync_to_anchor, sort_order) VALUES (?, ?, ?, NULL, NULL, 0, ?, ?, ?)',
          [project, d.name, d.percent != null ? Number(d.percent) : null, d.predecessors || null, d.sync_to_anchor || null, i]
        );
      }
      res.json({ ok: true, seeded: defaults.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
