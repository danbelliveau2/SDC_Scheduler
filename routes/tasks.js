'use strict';
const { Router } = require('express');

const FIELDS = ['name', 'project', 'phase', 'phase_group', 'department', 'sub_department', 'assignee', 'start_date', 'end_date', 'duration_days', 'predecessors', 'is_milestone', 'progress', 'allocation', 'priority', 'notes', 'sort_order', 'anchor_key', 'baseline_start_date', 'baseline_end_date', 'duration_link_task_id', 'is_action', 'completed_on', 'machine'];

module.exports = function createRouter(deps) {
  const { pool, io, requireRole, cascadeSchedule, logHistory, emailSvc } = deps;
  const router = Router();

  // ── helpers ──────────────────────────────────────────────────────────────────
  // Priorities are a dense 1..N queue per assignee PER PROJECT, over OPEN
  // (progress < 100) non-milestone tasks only. Completed tasks drop out of
  // the queue (priority cleared) and everyone below shifts up. preferredId
  // wins ties at equal priority — so setting a task to position 5 lands it
  // exactly at 5 and displaces the incumbent downward (insert semantics).
  // The old version numbered EVERY task the assignee had — all projects,
  // milestones, completed work — which is why bars showed "12, 13" with no
  // 3 or 6.
  async function compactPrioritiesForAssignee(assignee, project, preferredId) {
    if (!assignee) return;
    const [rows] = await pool.query(
      `SELECT id, priority FROM tasks
        WHERE assignee = ? AND (project <=> ?)
          AND COALESCE(is_milestone, 0) = 0
          AND COALESCE(progress, 0) < 100
        ORDER BY (priority IS NULL) ASC, priority ASC, (id = ?) DESC, id ASC`,
      [assignee, project ?? null, preferredId ?? -1]
    );
    for (let i = 0; i < rows.length; i++) {
      const target = i + 1;
      if (rows[i].priority !== target) {
        await pool.query('UPDATE tasks SET priority = ? WHERE id = ?', [target, rows[i].id]);
      }
    }
    // Completed / milestone tasks leave the queue entirely.
    await pool.query(
      `UPDATE tasks SET priority = NULL
        WHERE assignee = ? AND (project <=> ?) AND priority IS NOT NULL
          AND (COALESCE(progress, 0) >= 100 OR COALESCE(is_milestone, 0) = 1)`,
      [assignee, project ?? null]
    );
  }

  // One-time heal on every boot: existing data carries years of global,
  // gap-riddled numbering — sweep every (assignee, project) pair once so
  // the queues start dense. Idempotent and cheap; fire-and-forget.
  (async () => {
    try {
      const [pairs] = await pool.query(
        "SELECT DISTINCT assignee, project FROM tasks WHERE assignee IS NOT NULL AND assignee != ''"
      );
      for (const p of pairs) await compactPrioritiesForAssignee(p.assignee, p.project);
    } catch (_) { /* non-critical */ }
  })();

  async function cascadeDurationLinks() {
    function addBusinessDaysISO(dateStr, n) {
      if (!dateStr) return null;
      if (n === 0) return dateStr;
      const d = new Date(dateStr + 'T00:00:00Z');
      let remaining = Math.abs(n);
      const dir = n >= 0 ? 1 : -1;
      while (remaining > 0) {
        d.setUTCDate(d.getUTCDate() + dir);
        const day = d.getUTCDay();
        if (day !== 0 && day !== 6) remaining--;
      }
      return d.toISOString().slice(0, 10);
    }
    for (let iter = 0; iter < 20; iter++) {
      const [linked] = await pool.query(
        'SELECT id, duration_days, duration_link_task_id, start_date, end_date FROM tasks WHERE duration_link_task_id IS NOT NULL'
      );
      let changed = false;
      for (const dep of linked) {
        const [srcRows] = await pool.query('SELECT duration_days FROM tasks WHERE id = ?', [dep.duration_link_task_id]);
        const src = srcRows[0] || null;
        if (!src || dep.duration_link_task_id === dep.id) continue;
        const newDur = Number(src.duration_days) || 0;
        if (newDur === dep.duration_days) continue;
        const newMilestone = newDur === 0 ? 1 : 0;
        let newEnd = dep.end_date;
        if (newDur === 0) {
          newEnd = dep.start_date;
        } else if (dep.start_date) {
          newEnd = addBusinessDaysISO(dep.start_date, newDur - 1);
        }
        await pool.query(
          'UPDATE tasks SET duration_days = ?, end_date = ?, is_milestone = ? WHERE id = ?',
          [newDur, newEnd, newMilestone, dep.id]
        );
        changed = true;
      }
      if (!changed) break;
    }
  }

  // ── GET /api/tasks ────────────────────────────────────────────────────────────
  router.get('/api/tasks', async (req, res) => {
    try {
      const [tasks] = await pool.query('SELECT * FROM tasks ORDER BY sort_order, id');
      res.json(tasks);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // ── POST /api/tasks ───────────────────────────────────────────────────────────
  router.post('/api/tasks', requireRole('editor'), async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });

      const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks');
      const maxOrder = maxRow.m;
      let insertSortOrder;
      if (req.body.sort_order != null) {
        insertSortOrder = Number(req.body.sort_order);
      } else {
        insertSortOrder = maxOrder + 1;
      }
      let nextPriority = 1;
      if (req.body.priority != null) {
        nextPriority = Math.max(1, Number(req.body.priority) || 1);
      } else if (req.body.assignee) {
        // Join the end of this person's queue for THIS project.
        const [[peekRow]] = await pool.query(
          'SELECT COALESCE(MAX(priority), 0) AS m FROM tasks WHERE assignee = ? AND (project <=> ?)',
          [req.body.assignee, req.body.project || null]
        );
        nextPriority = (peekRow?.m || 0) + 1;
      }
      const cols = ['name', 'project', 'phase', 'phase_group', 'department', 'sub_department', 'assignee', 'start_date', 'end_date', 'duration_days', 'predecessors', 'is_milestone', 'progress', 'allocation', 'priority', 'notes', 'sort_order', 'anchor_key', 'is_action', 'machine'];
      const values = [
        name,
        req.body.project || null,
        req.body.phase || null,
        req.body.phase_group || null,
        req.body.department || null,
        req.body.sub_department || null,
        req.body.assignee || null,
        req.body.start_date ? String(req.body.start_date).slice(0, 10) : null,
        req.body.end_date ? String(req.body.end_date).slice(0, 10) : null,
        req.body.duration_days ?? null,
        req.body.predecessors || null,
        req.body.is_milestone ? 1 : 0,
        req.body.progress || 0,
        req.body.allocation == null ? 90 : Math.max(0, Math.min(100, Number(req.body.allocation) || 0)),
        nextPriority,
        req.body.notes || null,
        insertSortOrder,
        req.body.anchor_key || null,
        req.body.is_action ? 1 : 0,
        req.body.machine || null,
      ];
      const placeholders = cols.map(() => '?').join(', ');
      const [result] = await pool.query(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders})`, values);
      if (req.body.assignee) await compactPrioritiesForAssignee(req.body.assignee, req.body.project || null, req.body.priority != null ? result.insertId : undefined);
      await cascadeSchedule();
      const [[task]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [result.insertId]);
      await logHistory(task.id, task.project, 'create', null, null, task, null);
      res.json(task);
      io.emit('tasks:updated', { project: task.project || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── PUT /api/tasks/:id ────────────────────────────────────────────────────────
  router.put('/api/tasks/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'not found' });

      if (req.body.version != null && existing.version != null
          && Number(req.body.version) !== Number(existing.version)) {
        return res.status(409).json({
          error: 'This task was modified by another user. Refresh to see the latest version.',
          code: 'STALE_VERSION',
          server_version: existing.version,
          server_row: existing,
        });
      }

      const INT_FIELDS = new Set(['duration_days','progress','allocation','priority','duration_link_task_id','is_action']);
      const DATE_FIELDS = new Set(['start_date','end_date','baseline_start_date','baseline_end_date','completed_on']);
      const updates = {};
      for (const f of FIELDS) {
        if (f in req.body) {
          if (f === 'is_milestone' || f === 'is_action') updates[f] = req.body[f] ? 1 : 0;
          else if (INT_FIELDS.has(f)) updates[f] = req.body[f] == null || req.body[f] === '' ? null : Number(req.body[f]) || 0;
          else if (DATE_FIELDS.has(f)) updates[f] = req.body[f] ? String(req.body[f]).slice(0, 10) : null;
          else updates[f] = req.body[f] === '' ? null : req.body[f];
        }
      }
      if ('progress' in updates && !('completed_on' in updates)) {
        const newProgress = Number(updates.progress) || 0;
        const oldProgress = Number(existing.progress) || 0;
        if (newProgress >= 100 && oldProgress < 100) {
          updates.completed_on = new Date().toISOString().slice(0, 10);
        } else if (newProgress < 100 && oldProgress >= 100) {
          updates.completed_on = null;
        }
      }
      if (Object.keys(updates).length === 0) return res.json(existing);

      const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      await pool.query(`UPDATE tasks SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
      await pool.query('UPDATE tasks SET version = COALESCE(version,1) + 1 WHERE id = ?', [id]);

      const finalAssignee = ('assignee' in updates) ? updates.assignee : existing.assignee;
      const finalProject  = ('project'  in updates) ? updates.project  : existing.project;
      const assigneeChanged = 'assignee' in updates && updates.assignee !== existing.assignee;
      const projectChanged  = 'project'  in updates && updates.project  !== existing.project;
      const priorityExplicit = 'priority' in updates;

      if (assigneeChanged && !priorityExplicit && finalAssignee) {
        // New assignee, no explicit slot → join the END of that person's
        // queue for THIS project.
        const [[peekRow]] = await pool.query(
          'SELECT COALESCE(MAX(priority), 0) AS m FROM tasks WHERE assignee = ? AND (project <=> ?)',
          [finalAssignee, finalProject ?? null]
        );
        await pool.query('UPDATE tasks SET priority = ? WHERE id = ?', [(peekRow?.m || 0) + 1, id]);
      }

      // No manual conflict shuffling — compaction below owns the queue.
      // preferredId makes an explicit priority an INSERT at that position:
      // the moved task wins the tie, the incumbent and everyone after shift.
      if (finalAssignee) {
        await compactPrioritiesForAssignee(finalAssignee, finalProject, priorityExplicit ? id : undefined);
      }
      if ((assigneeChanged || projectChanged) && existing.assignee) {
        await compactPrioritiesForAssignee(existing.assignee, existing.project);
      }

      if ('duration_days' in updates) await cascadeDurationLinks();
      await cascadeSchedule();

      const [[updated]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [id]);
      await logHistory(id, updated.project, 'update', null, existing, updated, null);
      res.json(updated);
      io.emit('tasks:updated', { project: updated.project || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/tasks/:id ─────────────────────────────────────────────────────
  router.delete('/api/tasks/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[before]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [id]);
      const [[t]] = await pool.query('SELECT anchor_key, assignee FROM tasks WHERE id = ?', [id]);
      if (t && t.anchor_key && t.anchor_key !== 'backlog') {
        return res.status(400).json({ error: 'Anchor milestones cannot be deleted.' });
      }
      const stripRef = (predStr, marker) => {
        if (!predStr) return predStr;
        const kept = String(predStr).split(',').map(s => s.trim()).filter(Boolean).filter(seg => {
          const m = seg.match(marker ? /^#(\d+)/ : /^(\d+)/);
          return !(m && Number(m[1]) === id);
        });
        return kept.join(', ');
      };
      const [taskRefs] = await pool.query('SELECT id, predecessors FROM tasks WHERE predecessors LIKE ?', [`%${id}%`]);
      for (const r of taskRefs) {
        const np = stripRef(r.predecessors, false);
        if (np !== r.predecessors) await pool.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [np || null, r.id]);
      }
      const [finRefs] = await pool.query('SELECT id, predecessors FROM project_financials WHERE predecessors LIKE ?', [`%#${id}%`]);
      for (const r of finRefs) {
        const np = stripRef(r.predecessors, true);
        if (np !== r.predecessors) await pool.query('UPDATE project_financials SET predecessors = ? WHERE id = ?', [np || null, r.id]);
      }
      await pool.query('DELETE FROM tasks WHERE id = ?', [id]);
      await pool.query('DELETE FROM task_comments WHERE task_id = ?', [id]);
      if (before) await logHistory(id, before.project, 'delete', null, before, null, null);
      if (t && t.assignee) await compactPrioritiesForAssignee(t.assignee, t.project || null);
      await cascadeSchedule();
      res.json({ ok: true });
      io.emit('tasks:updated', { project: before?.project || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/tasks/reorder ───────────────────────────────────────────────────
  router.post('/api/tasks/reorder', requireRole('editor'), async (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array of ids' });
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      try {
        for (let idx = 0; idx < order.length; idx++) {
          await conn.query('UPDATE tasks SET sort_order = ? WHERE id = ?', [idx, order[idx]]);
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

  // ── GET /api/tasks/comment-counts ─────────────────────────────────────────────
  router.get('/api/tasks/comment-counts', async (req, res) => {
    try {
      const project = (req.query.project || '').toString().trim();
      if (!project) return res.json({});
      const [rows] = await pool.query(
        'SELECT c.task_id, COUNT(*) AS cnt FROM task_comments c JOIN tasks t ON t.id = c.task_id WHERE t.project = ? GROUP BY c.task_id',
        [project]
      );
      const map = {};
      for (const r of rows) map[r.task_id] = r.cnt;
      res.json(map);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // ── GET /api/tasks/history ────────────────────────────────────────────────────
  router.get('/api/tasks/history', async (req, res) => {
    try {
      const project = (req.query.project || '').toString().trim();
      if (!project) return res.status(400).json({ error: 'project required' });
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
      const [rows] = await pool.query(
        'SELECT * FROM task_history WHERE project = ? ORDER BY changed_at DESC LIMIT ?',
        [project, limit]
      );
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // ── GET /api/tasks/:id/comments ───────────────────────────────────────────────
  router.get('/api/tasks/:id/comments', async (req, res) => {
    try {
      const taskId = Number(req.params.id);
      const [rows] = await pool.query('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC', [taskId]);
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // ── POST /api/tasks/:id/comments ──────────────────────────────────────────────
  router.post('/api/tasks/:id/comments', requireRole('viewer'), async (req, res) => {
    try {
      const taskId = Number(req.params.id);
      const [[task]] = await pool.query('SELECT name, project FROM tasks WHERE id = ?', [taskId]);
      if (!task) return res.status(404).json({ error: 'task not found' });

      const body = (req.body.body || '').toString().trim();
      if (!body) return res.status(400).json({ error: 'body required' });

      const synthetic  = req.authUser && req.authUser.id === 0;
      const authorName = (!synthetic && req.authUser && req.authUser.name)
                         || (req.body.author_name || '').trim()
                         || (req.authUser && req.authUser.name)
                         || 'anonymous';
      const authorId   = (req.authUser && req.authUser.id) || null;

      const [knownNameRows] = await pool.query('SELECT name FROM team_members WHERE active = 1');
      const knownNames = knownNameRows.map(r => r.name).filter(Boolean);
      knownNames.sort((a, b) => b.length - a.length);
      const mentions = [];
      for (const name of knownNames) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('@' + escaped + '(?=[^a-zA-Z]|$)', 'i').test(body) && !mentions.includes(name)) {
          mentions.push(name);
        }
      }

      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const [r] = await pool.query(
        'INSERT INTO task_comments (task_id, project, author_id, author_name, body, mentions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [taskId, task.project, authorId, authorName, body, JSON.stringify(mentions), now, now]
      );

      const [[comment]] = await pool.query('SELECT * FROM task_comments WHERE id = ?', [r.insertId]);
      res.status(201).json(comment);

      io.emit('comments:updated', { taskId, project: task.project });

      for (const name of mentions) {
        try {
          const [[userRow]] = await pool.query('SELECT email FROM users WHERE name = ? AND active = 1', [name]);
          const to = userRow ? userRow.email : null;
          if (to && emailSvc && emailSvc.sendMentionEmail) {
            emailSvc.sendMentionEmail({
              pool, to, taskId, taskName: task.name, project: task.project,
              commentBody: body, authorName,
            }).catch(() => {});
          }
        } catch (_) {}
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/comments/:id ──────────────────────────────────────────────────
  router.delete('/api/comments/:id', requireRole('viewer'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[comment]] = await pool.query('SELECT * FROM task_comments WHERE id = ?', [id]);
      if (!comment) return res.status(404).json({ error: 'not found' });
      await pool.query('DELETE FROM task_comments WHERE id = ?', [id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/baseline/set ────────────────────────────────────────────────────
  router.post('/api/baseline/set', requireRole('editor'), async (req, res) => {
    try {
      const project = (req.body.project || '').toString().trim();
      if (!project) return res.status(400).json({ error: 'project required' });
      const [result] = await pool.query(
        'UPDATE tasks SET baseline_start_date = start_date, baseline_end_date = end_date WHERE project = ?',
        [project]
      );
      res.json({ ok: true, baselined: result.affectedRows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/baseline/clear ──────────────────────────────────────────────────
  router.post('/api/baseline/clear', requireRole('editor'), async (req, res) => {
    try {
      const project = (req.body.project || '').toString().trim();
      if (!project) return res.status(400).json({ error: 'project required' });
      const [result] = await pool.query(
        'UPDATE tasks SET baseline_start_date = NULL, baseline_end_date = NULL WHERE project = ?',
        [project]
      );
      res.json({ ok: true, cleared: result.affectedRows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
