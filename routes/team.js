'use strict';
const { Router } = require('express');
const planner = require('../lib/plannerClient');

const TEAM_DISCIPLINES = new Set(['mech', 'controls', 'pm', 'build', 'wire']);

// Scheduler discipline code → ETC Planner's full label (ETC stores labels).
const ETC_DISCIPLINE_LABEL = {
  pm: 'Project Management', mech: 'Mechanical Engineers',
  controls: 'Controls Engineers', build: 'Builders', wire: 'Electricians',
};
// Nickname-normalized name key so team_members names line up with the ETC
// roster names despite spelling drift (Mike/Michael, Josh/Joshua, …).
const ETC_NICKNAMES = { mike:'michael', josh:'joshua', rich:'richard', tim:'timothy', matt:'matthew', rob:'robert', dave:'david', mitch:'mitchell', nick:'nicholas', greg:'gregory', dan:'daniel', tom:'thomas', jon:'jonathan', chris:'christopher', andy:'andrew', bill:'william', billy:'william', sam:'samuel', joe:'joseph', jim:'james', ben:'benjamin' };
function normEtcName(name) {
  const parts = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/);
  if (parts.length) parts[0] = ETC_NICKNAMES[parts[0]] || parts[0];
  return parts.join('');
}

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

  // ── ETC master-roster extras (Unassigned + Inactive) ──────────────────────
  // ETC Planner is the master employee list. Unassigned = ETC active people not
  // yet on a Scheduler team (name-matched vs team_members); Inactive = ETC
  // inactive people. Fail-SOFT: if the planner isn't configured/reachable, the
  // board still renders its own 5 discipline cards.
  router.get('/api/team/etc-extras', async (req, res) => {
    try {
      if (!planner.CONFIGURED) return res.json({ ok: false, unassigned: [], inactive: [], reason: 'ETC Planner not configured' });
      const employees = await planner.getEmployees();
      const [team] = await pool.query('SELECT name FROM team_members');
      const teamKeys = new Set(team.map(t => normEtcName(t.name)));
      const isPh = (n) => /placeholder/i.test(n || '');
      const unassigned = [], inactive = [];
      for (const e of employees) {
        if (isPh(e.name)) continue;
        if (!e.active) { inactive.push({ paylocityId: e.paylocityId, name: e.name, discipline: e.discipline }); continue; }
        if (!teamKeys.has(normEtcName(e.name))) unassigned.push({ paylocityId: e.paylocityId, name: e.name, discipline: e.discipline });
      }
      unassigned.sort((a, b) => a.name.localeCompare(b.name));
      inactive.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ ok: true, unassigned, inactive });
    } catch (e) {
      res.json({ ok: false, unassigned: [], inactive: [], reason: e.message });
    }
  });

  // Assign an ETC person to a discipline: create/repoint the team_members row
  // AND push the grouping back to the planner (keyed by paylocityId) so both
  // apps agree. Planner push is best-effort — the Scheduler assignment stands
  // even if the planner is momentarily unreachable.
  router.post('/api/team/assign-from-etc', requireRole('editor'), async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      const discipline = req.body.discipline;
      const paylocityId = (req.body.paylocityId || '').toString().trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!TEAM_DISCIPLINES.has(discipline)) return res.status(400).json({ error: 'invalid discipline' });

      const [[dupe]] = await pool.query('SELECT * FROM team_members WHERE name = ?', [name]);
      let row = dupe;
      if (!dupe) {
        const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order),0) AS m FROM team_members WHERE discipline = ?', [discipline]);
        const [result] = await pool.query('INSERT INTO team_members (name, discipline, sort_order) VALUES (?, ?, ?)', [name, discipline, maxRow.m + 1]);
        [[row]] = await pool.query('SELECT * FROM team_members WHERE id = ?', [result.insertId]);
      } else if (dupe.discipline !== discipline) {
        await pool.query('UPDATE team_members SET discipline = ? WHERE id = ?', [discipline, dupe.id]);
        [[row]] = await pool.query('SELECT * FROM team_members WHERE id = ?', [dupe.id]);
      }

      let etcPushed = false;
      if (paylocityId && planner.CONFIGURED) {
        try { await planner.setEmployeeDiscipline(paylocityId, ETC_DISCIPLINE_LABEL[discipline] || null); etcPushed = true; }
        catch (_) { /* Scheduler assignment stands even if the planner is down */ }
      }
      res.json({ ok: true, member: row, etcPushed });
      io.emit('team:updated');
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
