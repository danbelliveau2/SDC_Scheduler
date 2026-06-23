'use strict';
const { Router } = require('express');

const TEAM_DISCIPLINES = new Set(['mech', 'controls', 'pm', 'build', 'wire']);

module.exports = function createRouter(deps) {
  const { pool, io, requireRole } = deps;
  const router = Router();

  router.get('/api/team', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM team_members ORDER BY discipline, sort_order, name');
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.post('/api/team', requireRole('editor'), async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      const discipline = req.body.discipline;
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!TEAM_DISCIPLINES.has(discipline)) return res.status(400).json({ error: 'invalid discipline' });
      const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM team_members WHERE discipline = ?', [discipline]);
      const [result] = await pool.query('INSERT INTO team_members (name, discipline, sort_order) VALUES (?, ?, ?)', [name, discipline, maxRow.m + 1]);
      const [[row]] = await pool.query('SELECT * FROM team_members WHERE id = ?', [result.insertId]);
      res.json(row);
      io.emit('team:updated');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/api/team/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT * FROM team_members WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'not found' });
      const allowed = ['name', 'discipline', 'active', 'sort_order', 'is_lead', 'specialty'];
      const updates = {};
      for (const f of allowed) {
        if (f in req.body) {
          if (f === 'discipline' && !TEAM_DISCIPLINES.has(req.body[f])) return res.status(400).json({ error: 'invalid discipline' });
          if (f === 'active' || f === 'is_lead') updates[f] = req.body[f] ? 1 : 0;
          else if (f === 'name') updates[f] = (req.body[f] || '').trim();
          else if (f === 'specialty') updates[f] = (req.body[f] || '').trim() || null;
          else updates[f] = req.body[f];
        }
      }
      if (Object.keys(updates).length === 0) return res.json(existing);
      if (updates.name && updates.name !== existing.name) {
        await pool.query('UPDATE tasks SET assignee = ? WHERE assignee = ?', [updates.name, existing.name]);
      }
      const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      await pool.query(`UPDATE team_members SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
      const [[updated]] = await pool.query('SELECT * FROM team_members WHERE id = ?', [id]);
      res.json(updated);
      io.emit('team:updated');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/team/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      await pool.query('DELETE FROM team_members WHERE id = ?', [id]);
      res.json({ ok: true });
      io.emit('team:updated');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/team/reorder', requireRole('editor'), async (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array of ids' });
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      try {
        for (let idx = 0; idx < order.length; idx++) {
          await conn.query('UPDATE team_members SET sort_order = ? WHERE id = ?', [idx, order[idx]]);
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        conn.release();
        return res.status(500).json({ error: err.message });
      }
      conn.release();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
