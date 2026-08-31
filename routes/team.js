'use strict';
const { Router } = require('express');
const planner = require('../lib/plannerClient');
const { isEtcSharedConfigured, etcQuery } = require('../lib/mysqlDb');

// The 7 delivery-team codes shared with ETC Planner's Employee.team
// (2026-08-13) — a subset of TEAM_DISCIPLINES below. The other 5 (ops,
// finance, growth, sales, exec) stay Scheduler-local by design (see the
// migration plan's "scope of groups" decision), so a discipline/active edit
// on one of THOSE never gets written through, even for a row whose
// employee_id happens to be set (the one-time link script matched by name
// against ETC's whole roster, not just the 7 in-scope teams, so a back-office
// person can be linked as metadata without being in scope for writes).
const SHARED_TEAM_DISCIPLINES = new Set(['pm', 'mech', 'controls', 'build', 'wire', 'service', 'mfgops']);

// Writes a linked row's discipline/active through to the shared Employee row
// — the ONE place that decides a linked person's group/status, replacing the
// old hourly name-matched pull + HTTP push. Fails soft: if the shared
// connection isn't configured or the write fails, the caller's own
// team_members write already succeeded, so the board stays correct either
// way — this only keeps ETC in step.
async function writeThroughToEtc(employeeId, discipline, active) {
  if (employeeId == null || !SHARED_TEAM_DISCIPLINES.has(discipline) || !isEtcSharedConfigured()) return;
  try {
    await etcQuery('UPDATE sdc_etc_planner.Employee SET team = ?, active = ? WHERE id = ?', [discipline, active ? 1 : 0, employeeId]);
  } catch (e) {
    console.error(`[team] write-through to ETC Employee#${employeeId} failed:`, e.message);
  }
}

// Must stay in step with DISCIPLINES in public/app.js — this is the server-side
// gate, so a bucket the board can render but this Set doesn't know would reject
// every drag into it with "invalid discipline".
const TEAM_DISCIPLINES = new Set([
  'mech', 'controls', 'pm', 'build', 'wire',
  // v4.65: one bucket per company department (from the official
  // Employee-Department map). The last four are back-office — on the board for
  // headcount, but not offered as task assignees (see app.js).
  'service', 'mfgops', 'ops', 'finance', 'growth', 'sales', 'exec',
]);

// Nickname-normalized name key so team_members names line up with the ETC
// roster names despite spelling drift (Mike/Michael, Josh/Joshua, …).
const ETC_NICKNAMES = { mike:'michael', josh:'joshua', rich:'richard', tim:'timothy', matt:'matthew', rob:'robert', dave:'david', mitch:'mitchell', nick:'nicholas', greg:'gregory', dan:'daniel', tom:'thomas', jon:'jonathan', chris:'christopher', andy:'andrew', bill:'william', billy:'william', sam:'samuel', joe:'joseph', jim:'james', ben:'benjamin' };
function normEtcName(name) {
  const parts = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/);
  if (parts.length) parts[0] = ETC_NICKNAMES[parts[0]] || parts[0];
  return parts.join('');
}

// ── PULL-sync: the Reports app's Employee roster is the MASTER for the 7
// delivery teams (Dan, 2026-08-31: "I want our list to be pulling directly
// from there — if that list ever changes, ours changes accordingly").
// Direction summary: existence/active/grouping flow ETC → board here; board
// edits still write straight through (writeThroughToEtc above), so both
// stay in step whichever side changes first.
//   * ETC person on a shared team, missing here      → created
//   * discipline/active drifted                      → aligned to ETC
//   * board row on a shared card, not in ETC roster  → deactivated (never
//     deleted — task assignments + history stay intact)
// Placeholders and the 5 Scheduler-local disciplines are untouched.
// Fail-soft: planner not configured (local dev) → no-op.
async function syncTeamFromPlanner(pool, io) {
  if (!planner.CONFIGURED) return { ok: false, reason: 'ETC Planner not configured' };
  const employees = await planner.getEmployees();
  const [team] = await pool.query('SELECT * FROM team_members');
  const byKey = new Map(team.map(t => [normEtcName(t.name), t]));
  const isPh = (n) => /placeholder/i.test(n || '');
  let created = 0, updated = 0, deactivated = 0;
  const seen = new Set();
  for (const e of employees) {
    if (isPh(e.name) || !e.name) continue;
    const disc = e.discipline;
    if (!SHARED_TEAM_DISCIPLINES.has(disc)) continue;
    const key = normEtcName(e.name);
    seen.add(key);
    const row = byKey.get(key);
    if (!row) {
      if (!e.active) continue;
      const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order),0) AS m FROM team_members WHERE discipline = ?', [disc]);
      await pool.query('INSERT INTO team_members (name, discipline, sort_order, active) VALUES (?, ?, ?, 1)', [e.name, disc, maxRow.m + 1]);
      created++;
    } else {
      const wantActive = e.active ? 1 : 0;
      // Only shared-card rows follow ETC's grouping — a linked back-office
      // person keeps their Scheduler-local card.
      const wantDisc = SHARED_TEAM_DISCIPLINES.has(row.discipline) ? disc : row.discipline;
      if ((row.active ? 1 : 0) !== wantActive || row.discipline !== wantDisc) {
        await pool.query('UPDATE team_members SET active = ?, discipline = ? WHERE id = ?', [wantActive, wantDisc, row.id]);
        updated++;
      }
    }
  }
  for (const t of team) {
    if (!SHARED_TEAM_DISCIPLINES.has(t.discipline) || isPh(t.name) || !t.active) continue;
    if (!seen.has(normEtcName(t.name))) {
      await pool.query('UPDATE team_members SET active = 0 WHERE id = ?', [t.id]);
      deactivated++;
    }
  }
  if ((created || updated || deactivated) && io) io.emit('team:updated');
  return { ok: true, created, updated, deactivated };
}

module.exports = function createRouter(deps) {
  const { pool, io, requireRole } = deps;
  const router = Router();

  // Roster pull-sync: once shortly after boot, then every 30 minutes (same
  // rhythm as the other ETC/ETO syncs), plus on demand below.
  if (planner.CONFIGURED) {
    const run = () => syncTeamFromPlanner(pool, io)
      .then(r => { if (r.ok && (r.created || r.updated || r.deactivated)) console.log('[team] roster sync:', JSON.stringify(r)); })
      .catch(e => console.error('[team] roster sync failed:', e.message));
    setTimeout(run, 20 * 1000);
    setInterval(run, 30 * 60 * 1000);
  }

  router.post('/api/team/sync-etc', requireRole('editor'), async (_req, res) => {
    try { res.json(await syncTeamFromPlanner(pool, io)); }
    catch (e) { res.status(503).json({ ok: false, error: e.message }); }
  });

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
      if ('discipline' in updates || 'active' in updates) {
        writeThroughToEtc(existing.employee_id, updated.discipline, Boolean(updated.active));
      }
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

      // Direct write-through, replacing the old HTTP push via plannerClient
      // (2026-08-13) — this comes from ETC's own "Unassigned"/"Inactive"
      // cards, so the person is already a real Employee row keyed by
      // paylocityId; link team_members.employee_id to it (once, if not
      // already set) so future edits stay ID-matched, then write the
      // assignment straight to the shared row.
      let etcPushed = false;
      if (paylocityId && isEtcSharedConfigured()) {
        try {
          let employeeId = row.employee_id;
          if (employeeId == null) {
            const [[emp]] = await etcQuery('SELECT id FROM sdc_etc_planner.Employee WHERE paylocityId = ?', [paylocityId]);
            if (emp) {
              employeeId = emp.id;
              await pool.query('UPDATE team_members SET employee_id = ? WHERE id = ?', [employeeId, row.id]);
              row.employee_id = employeeId;
            }
          }
          if (employeeId != null) {
            await writeThroughToEtc(employeeId, discipline, true);
            etcPushed = true;
          }
        } catch (_) { /* Scheduler assignment stands even if ETC's shared table is unreachable */ }
      }
      res.json({ ok: true, member: row, etcPushed });
      io.emit('team:updated');
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
