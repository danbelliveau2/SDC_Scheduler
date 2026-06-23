'use strict';
const { Router } = require('express');

const VPO_FIELDS = ['priority', 'po', 'job', 'vendor', 'po_date', 'lead_time', 'eta', 'ship_date', 'delivery_date', 'tracking', 'po_price', 'pm', 'comments', 'partial', 'complete', 'sort_order'];
const _vpoBool = (f) => f === 'partial' || f === 'complete';
const _bt = (c) => `\`${c}\``; // backtick a column name

module.exports = function createRouter(deps) {
  const { pool, io, requireRole } = deps;
  const router = Router();

  router.get('/api/vendor-pos', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM vendor_pos ORDER BY sort_order, priority, id');
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.post('/api/vendor-pos', requireRole('editor'), async (req, res) => {
    try {
      const b = req.body || {};
      const cols = [], vals = [];
      for (const f of VPO_FIELDS) { if (f in b) { cols.push(f); vals.push(_vpoBool(f) ? (b[f] ? 1 : 0) : b[f]); } }
      if (!cols.includes('sort_order')) { const [[m]] = await pool.query('SELECT COALESCE(MAX(sort_order),0) AS m FROM vendor_pos'); cols.push('sort_order'); vals.push(m.m + 1); }
      const [result] = await pool.query(`INSERT INTO vendor_pos (${cols.map(_bt).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
      const [[row]] = await pool.query('SELECT * FROM vendor_pos WHERE id = ?', [result.insertId]);
      res.json(row);
      io.emit('vendor_pos:updated');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/api/vendor-pos/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT * FROM vendor_pos WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'not found' });
      const updates = {};
      for (const f of VPO_FIELDS) { if (f in req.body) updates[f] = _vpoBool(f) ? (req.body[f] ? 1 : 0) : req.body[f]; }
      if (Object.keys(updates).length === 0) return res.json(existing);
      if ('complete' in updates) {
        if (updates.complete && !existing.complete) updates.completed_on = new Date().toISOString();
        else if (!updates.complete) updates.completed_on = null;
      }
      const setClause = Object.keys(updates).map(k => `${_bt(k)} = ?`).join(', ');
      await pool.query(`UPDATE vendor_pos SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
      const [[row]] = await pool.query('SELECT * FROM vendor_pos WHERE id = ?', [id]);
      res.json(row);
      io.emit('vendor_pos:updated');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/vendor-pos/:id', requireRole('editor'), async (req, res) => {
    try {
      await pool.query('DELETE FROM vendor_pos WHERE id = ?', [Number(req.params.id)]);
      res.json({ ok: true });
      io.emit('vendor_pos:updated');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
