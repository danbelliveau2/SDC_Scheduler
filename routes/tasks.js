'use strict';
const { Router } = require('express');

const FIELDS = ['name', 'project', 'phase', 'phase_group', 'department', 'sub_department', 'assignee', 'start_date', 'end_date', 'duration_days', 'predecessors', 'is_milestone', 'progress', 'allocation', 'priority', 'notes', 'sort_order', 'anchor_key', 'baseline_start_date', 'baseline_end_date', 'duration_link_task_id', 'is_action', 'dates_locked', 'completed_on', 'machine', 'join_prev'];

// Every catch block here used to do `res.status(500).json({error: e.message})`
// and NOTHING else — the real cause of any specific save failure was visible
// only in a response body nobody was capturing server-side (found live,
// 2026-08-13, while chasing a save that failed the same way on every retry).
// One shape for every log line so grepping the server output for a task id or
// user turns up every attempt against it.
function logSaveError(action, taskId, req, err) {
  console.error(`[tasks] ${action} #${taskId} failed (user=${req.user || 'anonymous'}): ${err.message}`);
}

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
        'SELECT id, duration_days, duration_link_task_id, start_date, end_date FROM tasks WHERE duration_link_task_id IS NOT NULL AND COALESCE(dates_locked, 0) = 0'
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
      // Customer share link → ONLY that project's rows leave the building.
      const [tasks] = req.shareProject
        ? await pool.query('SELECT * FROM tasks WHERE project = ? ORDER BY sort_order, id', [req.shareProject])
        : await pool.query('SELECT * FROM tasks ORDER BY sort_order, id');
      res.json(tasks);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // ── POST /api/tasks ───────────────────────────────────────────────────────────
  // Same two-phase shape as PUT below: the INSERT itself must succeed or fail
  // cleanly; the compaction/cascade that follows is best-effort and logged.
  //
  // `client_ref` (2026-08-13) makes a retried create idempotent: it's a value
  // the CLIENT generates once per create attempt and resends unchanged on
  // every retry. If a first attempt's INSERT actually committed but its
  // response never reached the browser (dropped connection, the ~2-min deploy
  // restart landing mid-request), a naive retry would insert a second,
  // duplicate row — with client_ref UNIQUE, that retry's INSERT hits
  // ER_DUP_ENTRY instead, and this returns the row that already exists rather
  // than creating another one.
  router.post('/api/tasks', requireRole('editor'), async (req, res) => {
    const clientRef = req.body.client_ref ? String(req.body.client_ref).slice(0, 64) : null;
    let task;

    // ── Phase 1: the create itself ────────────────────────────────────────────
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
      const cols = ['name', 'project', 'phase', 'phase_group', 'department', 'sub_department', 'assignee', 'start_date', 'end_date', 'duration_days', 'predecessors', 'is_milestone', 'progress', 'allocation', 'priority', 'notes', 'sort_order', 'anchor_key', 'is_action', 'machine', 'client_ref'];
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
        clientRef,
      ];
      const placeholders = cols.map(() => '?').join(', ');
      let insertId;
      try {
        const [result] = await pool.query(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders})`, values);
        insertId = result.insertId;
      } catch (e) {
        if (clientRef && e.code === 'ER_DUP_ENTRY') {
          const [[dupe]] = await pool.query('SELECT * FROM tasks WHERE client_ref = ?', [clientRef]);
          if (dupe) { res.json(dupe); return; }
        }
        throw e;
      }
      [[task]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [insertId]);
    } catch (e) {
      logSaveError('POST', 'new', req, e);
      return res.status(500).json({ error: e.message });
    }

    // ── Phase 2: derived side effects (best-effort) ──────────────────────────
    try {
      if (task.assignee) await compactPrioritiesForAssignee(task.assignee, task.project || null, req.body.priority != null ? task.id : undefined);
      await cascadeSchedule();
    } catch (e) {
      logSaveError('POST (side effects)', task.id, req, e);
    }

    try {
      const [[final]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [task.id]);
      await logHistory(final.id, final.project, 'create', req.user || null, null, final, null);
      res.json(final);
      io.emit('tasks:updated', { project: final.project || null });
    } catch (e) {
      logSaveError('POST (response)', task.id, req, e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── PUT /api/tasks/:id ────────────────────────────────────────────────────────
  //
  // Split into two phases (2026-08-13, found live: a side-effect throwing here
  // used to report the WHOLE edit as failed even after the field write already
  // committed — the client would then retry an edit that had already saved).
  //
  // Phase 1 — the actual edit the user made. Transactional: the field UPDATE
  // and the version bump either both land or neither does. Any failure here IS
  // a real save failure and the client is right to retry it.
  //
  // Phase 2 — priority compaction + the duration/schedule cascades. These are
  // DERIVED from the edit, not the edit itself, and can affect many other rows.
  // Best-effort: a failure here is logged (see logSaveError) but never turns a
  // successful edit into a reported failure. The cascade math itself
  // (cascadeSchedule / cascadeDurationLinks / computeDatesFromPreds) is
  // unchanged — only how a failure IN it is handled.
  router.put('/api/tasks/:id', requireRole('editor'), async (req, res) => {
    const id = Number(req.params.id);
    let existing, updates;

    // ── Phase 1: the edit itself ──────────────────────────────────────────────
    {
      let conn;
      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [[existingRow]] = await conn.query('SELECT * FROM tasks WHERE id = ?', [id]);
        if (!existingRow) {
          await conn.rollback();
          return res.status(404).json({ error: 'not found' });
        }
        existing = existingRow;

        if (req.body.version != null && existing.version != null
            && Number(req.body.version) !== Number(existing.version)) {
          await conn.rollback();
          return res.status(409).json({
            error: 'This task was modified by another user. Refresh to see the latest version.',
            code: 'STALE_VERSION',
            server_version: existing.version,
            server_row: existing,
          });
        }

        const INT_FIELDS = new Set(['duration_days','progress','allocation','priority','duration_link_task_id','is_action']);
        const DATE_FIELDS = new Set(['start_date','end_date','baseline_start_date','baseline_end_date','completed_on']);
        updates = {};
        for (const f of FIELDS) {
          if (f in req.body) {
            if (f === 'is_milestone' || f === 'is_action' || f === 'dates_locked') updates[f] = req.body[f] ? 1 : 0;
            else if (INT_FIELDS.has(f)) {
              if (req.body[f] == null || req.body[f] === '') { updates[f] = null; continue; }
              const n = Number(req.body[f]);
              // A non-numeric value used to silently become 0 (`Number(x) || 0`)
              // — a quiet data-corruption path disguised as a successful save.
              if (Number.isNaN(n)) {
                await conn.rollback();
                return res.status(400).json({ error: `"${req.body[f]}" is not a valid number for ${f}.`, field: f });
              }
              updates[f] = n;
            }
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
        if (Object.keys(updates).length === 0) {
          await conn.rollback();
          return res.json(existing);
        }

        // ── Manual date lock (auto-pin) ─────────────────────────────────────
        // Editing a start/finish date PINS the task so the predecessor cascade
        // (server.js cascadeSchedule) stops reverting the hand-set dates — the
        // root cause of "I changed dates and they went back overnight." Editing
        // the task's predecessors UNPINS it (the user is handing scheduling
        // back to the graph). An explicit `dates_locked` in the request always
        // wins, so a future lock/unlock toggle can override either default.
        if (!('dates_locked' in updates)) {
          if ('predecessors' in req.body) {
            updates.dates_locked = 0;
          } else if (('start_date' in req.body || 'end_date' in req.body) && !('duration_days' in req.body)) {
            // A pure Start/Finish date edit pins. A duration edit (which also
            // ships end_date) does NOT — it stays graph-driven. The client
            // sends an explicit dates_locked=1 on real Finish-date edits
            // (which also carry duration_days), honored above.
            updates.dates_locked = 1;
          }
        }

        const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        await conn.query(`UPDATE tasks SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
        await conn.query('UPDATE tasks SET version = COALESCE(version,1) + 1 WHERE id = ?', [id]);
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch (_) {}
        logSaveError('PUT', id, req, e);
        return res.status(500).json({ error: e.message });
      } finally {
        if (conn) conn.release();
      }
    }

    // ── Phase 2: derived side effects (best-effort) ──────────────────────────
    try {
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
    } catch (e) {
      logSaveError('PUT (side effects)', id, req, e);
      // The edit itself already committed in Phase 1 — fall through to a
      // normal success response rather than reporting it as failed.
    }

    try {
      const [[updated]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [id]);
      await logHistory(id, updated.project, 'update', req.user || null, existing, updated, null);
      res.json(updated);
      io.emit('tasks:updated', { project: updated.project || null });
    } catch (e) {
      logSaveError('PUT (response)', id, req, e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/tasks/:id ─────────────────────────────────────────────────────
  // Same two-phase shape as PUT/POST above: the delete + its predecessor-
  // reference cleanup either all commit or none do (a partial delete would
  // leave other tasks pointing at a row that no longer exists). Compaction
  // and the schedule cascade after it are derived and best-effort.
  router.delete('/api/tasks/:id', requireRole('editor'), async (req, res) => {
    const id = Number(req.params.id);
    let before, t;

    try {
      const [[beforeRow]] = await pool.query('SELECT * FROM tasks WHERE id = ?', [id]);
      before = beforeRow;
      const [[tRow]] = await pool.query('SELECT anchor_key, assignee FROM tasks WHERE id = ?', [id]);
      t = tRow;
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

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [taskRefs] = await conn.query('SELECT id, predecessors FROM tasks WHERE predecessors LIKE ?', [`%${id}%`]);
        for (const r of taskRefs) {
          const np = stripRef(r.predecessors, false);
          if (np !== r.predecessors) await conn.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [np || null, r.id]);
        }
        const [finRefs] = await conn.query('SELECT id, predecessors FROM project_financials WHERE predecessors LIKE ?', [`%#${id}%`]);
        for (const r of finRefs) {
          const np = stripRef(r.predecessors, true);
          if (np !== r.predecessors) await conn.query('UPDATE project_financials SET predecessors = ? WHERE id = ?', [np || null, r.id]);
        }
        await conn.query('DELETE FROM tasks WHERE id = ?', [id]);
        await conn.query('DELETE FROM task_comments WHERE task_id = ?', [id]);
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch (_) {}
        throw e;
      } finally {
        conn.release();
      }
    } catch (e) {
      logSaveError('DELETE', id, req, e);
      return res.status(500).json({ error: e.message });
    }

    try {
      if (before) await logHistory(id, before.project, 'delete', req.user || null, before, null, null);
      if (t && t.assignee) await compactPrioritiesForAssignee(t.assignee, t.project || null);
      await cascadeSchedule();
    } catch (e) {
      logSaveError('DELETE (side effects)', id, req, e);
    }

    res.json({ ok: true });
    io.emit('tasks:updated', { project: before?.project || null });
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
