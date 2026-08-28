'use strict';
const { Router } = require('express');

// 'machine' — per-machine payment terms on multi-machine projects (M1/M2/…);
// NULL/'' means M1 / single-machine (legacy rows keep working untouched).
// archived_at / archived_reason are settable so a mistakenly-archived row can
// be restored (PUT archived_at: null) without a DB session.
const FIN_FIELDS = ['name', 'percent', 'amount', 'due_date', 'paid', 'predecessors', 'sync_to_anchor', 'sort_order', 'machine', 'sent', 'sent_at', 'paid_at', 'terms_days', 'archived_at', 'archived_reason'];

// Archive milestones whose machine is no longer part of the schedule.
//
// A milestone belongs to a machine by NAME, and the Project Release panel only
// renders a block per machine that exists in `tasks`. So when a machine was
// deleted (or its last task retagged), its milestones stayed in the table with
// no way to reach them in the UI — and the Invoicing page, which lists every
// row for the project, showed them under "No trigger" indefinitely.
//
// Deliberately conservative, because this runs on a read path:
//   * only rows that NAME a machine (machine-less rows belong to the base
//     machine and are always legitimate),
//   * only when that (project, machine) pair has no tasks at all,
//   * only in a project that still HAS tasks — an empty or mid-import project
//     is never touched,
//   * archive, never DELETE, so sent/paid history stays readable and a
//     mistake is one PUT away from being undone.
// Idempotent: the archived_at IS NULL guard makes repeat calls no-ops.
async function archiveOrphanedMilestones(pool, project) {
  const params = [];
  let scope = '';
  if (project) { scope = ' AND f.project = ?'; params.push(project); }
  const [r] = await pool.query(`
    UPDATE project_financials f
       SET f.archived_at = NOW(), f.archived_reason = 'orphan-machine'
     WHERE f.archived_at IS NULL
       AND f.machine IS NOT NULL AND f.machine <> ''${scope}
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.project = f.project AND t.machine = f.machine)
       AND EXISTS     (SELECT 1 FROM tasks t WHERE t.project = f.project)
  `, params);
  return r.affectedRows || 0;
}

module.exports = function createRouter(deps) {
  const { pool, requireRole } = deps;
  const router = Router();

  router.get('/api/financials', async (req, res) => {
    try {
      // Customer share link → forced to that project regardless of the query.
      const project = req.shareProject || (req.query.project || '').toString();
      // Keep milestones in step with the schedule at the point every consumer
      // (Project Release, Invoicing, the Gantt overlay, the dashboards) reads
      // them, so a machine deleted in the schedule stops being an active
      // invoicing row immediately rather than at the next restart.
      if (project) { try { await archiveOrphanedMilestones(pool, project); } catch (_) {} }
      // Archived rows are history: excluded from every active view unless a
      // caller explicitly asks for them.
      const withArchived = ['1', 'true', 'yes'].includes(String(req.query.include_archived || '').toLowerCase());
      const archFilter = withArchived ? '' : ' AND archived_at IS NULL';
      const [rows] = project
        ? await pool.query(`SELECT * FROM project_financials WHERE project = ?${archFilter} ORDER BY sort_order, id`, [project])
        : await pool.query(`SELECT * FROM project_financials WHERE 1 = 1${archFilter} ORDER BY project, sort_order, id`);
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // Reconcile one project on demand — same routine the read path runs, for
  // callers that change machine tags and want the sync to happen now.
  router.post('/api/financials/reconcile', requireRole('editor'), async (req, res) => {
    try {
      const project = (req.body.project || '').toString().trim();
      const archived = await archiveOrphanedMilestones(pool, project || null);
      res.json({ ok: true, archived });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/financials', requireRole('editor'), async (req, res) => {
    try {
      const project = (req.body.project || '').toString().trim();
      if (!project) return res.status(400).json({ error: 'project required' });
      const name = (req.body.name || '').toString().trim();
      const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_financials WHERE project = ?', [project]);
      const [result] = await pool.query(
        'INSERT INTO project_financials (project, name, percent, amount, due_date, paid, predecessors, sync_to_anchor, sort_order, machine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [project, name,
         req.body.percent != null ? Number(req.body.percent) : null,
         req.body.amount  != null ? Number(req.body.amount)  : null,
         req.body.due_date || null,
         req.body.paid ? 1 : 0,
         req.body.predecessors || null,
         req.body.sync_to_anchor || null,
         maxRow.m + 1,
         req.body.machine || null]
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
          if (f === 'paid' || f === 'sent') updates[f] = req.body[f] ? 1 : 0;
          else if (f === 'percent' || f === 'amount' || f === 'terms_days') updates[f] = req.body[f] == null ? null : Number(req.body[f]);
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

  // Atomic "may I initialize this scope's milestones?" claim.
  //
  // Seeding used to be gated on "the scope has no rows", which cannot tell a
  // brand-new project apart from one where the user just deleted the rows —
  // so every Project Release open re-created the deleted milestones. The claim
  // row is the durable answer instead: the first caller for a (project,
  // machine) scope gets allowed:true, everyone after gets allowed:false, and
  // a scope that already has rows is claimed WITHOUT being offered for
  // seeding. INSERT IGNORE + affectedRows makes it safe under concurrent
  // opens and idempotent under repeated submissions.
  //
  // machine: '' (or omitted) = the project-level default/release seed.
  router.post('/api/financials/claim-seed', requireRole('editor'), async (req, res) => {
    try {
      const project = (req.body.project || '').toString().trim();
      if (!project) return res.status(400).json({ error: 'project required' });
      const machine = (req.body.machine || '').toString().trim();
      const [claim] = await pool.query(
        'INSERT IGNORE INTO project_financials_seed (project, machine) VALUES (?, ?)',
        [project, machine]
      );
      // Someone already claimed this scope — never seed again.
      if (!claim.affectedRows) return res.json({ ok: true, allowed: false, reason: 'already-claimed' });
      // First claim, but the scope already holds rows (pre-existing project):
      // the claim is what we wanted; seeding on top would duplicate them.
      const [[existing]] = machine
        ? await pool.query('SELECT COUNT(*) AS n FROM project_financials WHERE project = ? AND machine = ?', [project, machine])
        : await pool.query('SELECT COUNT(*) AS n FROM project_financials WHERE project = ?', [project]);
      if (existing.n > 0) return res.json({ ok: true, allowed: false, reason: 'has-rows' });
      res.json({ ok: true, allowed: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/financials/seed', requireRole('editor'), async (req, res) => {
    try {
      const project = (req.body.project || '').toString().trim();
      if (!project) return res.status(400).json({ error: 'project required' });
      const [[existingFin]] = await pool.query('SELECT COUNT(*) AS n FROM project_financials WHERE project = ?', [project]);
      if (existingFin.n > 0) return res.json({ ok: true, seeded: 0 });
      // Same claim gate as claim-seed: once a project's milestones have been
      // initialized, an empty grid means "the user emptied it", not "seed me".
      const [claim] = await pool.query(
        'INSERT IGNORE INTO project_financials_seed (project, machine) VALUES (?, \'\')', [project]
      );
      if (!claim.affectedRows) return res.json({ ok: true, seeded: 0, reason: 'already-claimed' });
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
