'use strict';
/**
 * routes/manufacturing.js — the Manufacturing page's data (2026-08-26).
 *
 * Serves the shop's in-house manufacturing queue: Total ETO's "In House Tasks"
 * (what has to be MADE), joined to this scheduler's build dates (WHEN it is
 * needed). Read-only in both directions — nothing here writes to ETO, and
 * nothing writes to the scheduler either.
 *
 * WHY THIS EXISTS WHEN ETO ALREADY HAS THE GRID
 *
 * Pat already has this list inside Total ETO, so a faithful copy would add
 * nothing. What ETO cannot do is say whether a part is LATE, because a due date
 * on the process schedule is optional and mostly skipped: FinalRequiredDate is
 * set on 100 of 229 active schedules (measured 2026-08-26). The scheduler knows
 * every job's build window and ship date, so it can supply the missing due date
 * and rank the queue by real urgency.
 *
 * That is not hypothetical. On the day this was written, job 1161's
 * 839-B-001 BUBBLER TANK CHAMBER (qty 3) had been open 45 days, had never been
 * worked on, and had NO required date in ETO — while this scheduler had job
 * 1161's Builder 1 running Aug 25-31 and PowerUp on Sep 8. A part needed for a
 * build that already ran, invisible to the system that owns the part.
 *
 * ── The join, and where it is weak ─────────────────────────────────────────
 * ETO ProjectID  ===  scheduler projects.job_number, the same key etoDb.js
 * uses everywhere else. Jobs whose in-house tasks exist but which have no
 * scheduler project simply get no build context — they are still listed, with
 * `schedule: null`, rather than dropped. Silently hiding shop work because a PM
 * has not made a project yet would be the worst possible failure here.
 */
const { Router } = require('express');

const DAY_MS = 86400000;

/**
 * YYYY-MM-DD in UTC. Deliberate, for both kinds of input this sees:
 *
 *   ETO datetimes — stored as midnight, and the mssql driver reads SQL Server
 *   datetimes as UTC, so 2026-09-11 00:00:00 arrives as Sep 10 20:00 EDT. UTC
 *   formatting recovers 2026-09-11; local formatting reports Sep 10, a day
 *   early. See the matching note on isoDate in lib/etoDb.js.
 *
 *   Scheduler dates — plain 'YYYY-MM-DD' strings in MySQL, which Date parses as
 *   UTC midnight, so UTC formatting round-trips them unchanged. Local
 *   formatting would move those back a day too.
 *
 * Local time is wrong for both. Do not switch it.
 */
function isoDay(d) {
  if (!d) return null;
  const dt = new Date(d);
  return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
}

/** Whole days from `d` until now; negative means `d` is in the future. */
function daysAgo(d) {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (isNaN(t)) return null;
  return Math.round((Date.now() - t) / DAY_MS);
}

module.exports = function createRouter(deps) {
  const { pool, etoDb } = deps;
  const router = Router();

  router.get('/api/manufacturing/in-house', async (req, res) => {
    if (!etoDb || !etoDb.CONFIGURED) {
      return res.status(503).json({ error: 'Total ETO is not configured on this server.' });
    }

    let tasks;
    try {
      tasks = await etoDb.getInHouseTasks();
    } catch (e) {
      // ETO down is not the same as "nothing to make" — say so rather than
      // rendering a reassuring empty queue.
      return res.status(503).json({ error: `Could not reach Total ETO: ${e.message}` });
    }

    // ── Build context per job, from this scheduler ──────────────────────────
    // One query for the jobs actually in the queue (3 jobs / 11 tasks when this
    // was written, so no need to page). Build window = the span of every dated
    // SHOP task; ship = the ship_machine anchor.
    const jobs = [...new Set(tasks.map(t => String(t.ProjectID)))];
    const schedules = new Map();
    if (jobs.length) {
      try {
        const [projects] = await pool.query(
          `SELECT name, job_number, status FROM projects
           WHERE job_number IN (?) AND (is_template IS NULL OR is_template = 0)`,
          [jobs]
        );
        for (const p of projects) {
          const [[span]] = await pool.query(
            `SELECT MIN(start_date) AS build_start, MAX(end_date) AS build_end
             FROM tasks
             WHERE project = ? AND department = 'shop'
               AND start_date IS NOT NULL AND start_date != ''`,
            [p.name]
          );
          const [[ship]] = await pool.query(
            `SELECT MIN(start_date) AS ship_date FROM tasks
             WHERE project = ? AND anchor_key = 'ship_machine'
               AND start_date IS NOT NULL AND start_date != ''`,
            [p.name]
          );
          schedules.set(String(p.job_number), {
            project: p.name,
            status: p.status,
            build_start: span && span.build_start ? isoDay(span.build_start) : null,
            build_end: span && span.build_end ? isoDay(span.build_end) : null,
            ship_date: ship && ship.ship_date ? isoDay(ship.ship_date) : null,
          });
        }
      } catch (e) {
        // Losing build context degrades the page to ETO's own grid, which is
        // still useful. Don't fail the whole request over it.
        console.warn('[manufacturing] build-date lookup failed:', e.message);
      }
    }

    // ── Derive the judgements the shop actually needs ───────────────────────
    const rows = tasks.map(t => {
      const job = String(t.ProjectID);
      const sched = schedules.get(job) || null;

      const etoDue = isoDay(t.FinalRequiredDate);
      // Fall back to the build start: a part is needed by the time the build
      // that consumes it begins. Flagged as derived so nobody mistakes it for
      // a date a buyer actually promised.
      const due = etoDue || (sched && sched.build_start) || null;
      const dueFrom = etoDue ? 'eto' : (due ? 'build-start' : null);

      const startedDays = daysAgo(t.StartDate);
      const lastWorkedDays = daysAgo(t.LastWorkedOnDate);
      const dueInDays = due ? -daysAgo(due) : null;
      const neverStarted = !t.LastWorkedOnDate;

      // Build already underway (or done) while the part is still outstanding.
      // The loudest signal on the page, and the one ETO cannot produce.
      const buildStartedDays = sched && sched.build_start ? daysAgo(sched.build_start) : null;
      const buildUnderway = buildStartedDays != null && buildStartedDays >= 0;

      const flags = [];
      if (buildUnderway && neverStarted) flags.push('build-started-part-not');
      if (dueInDays != null && dueInDays < 0) flags.push('overdue');
      else if (dueInDays != null && dueInDays <= 14) flags.push('due-soon');
      // Stalled means opened long ago with no work logged — distinct from
      // "recently raised and not started yet", which is normal.
      if (neverStarted && startedDays != null && startedDays > 30) flags.push('stalled');
      if (!etoDue) flags.push('no-eto-due-date');
      if (t.HasActivePunchIns) flags.push('active-now');

      return {
        job,
        section: t.SpecID == null ? null : Number(t.SpecID),
        ps_number: t.ProcessNumber,
        sequence: t.Sequence,
        part_no: t.PartNumber,
        description: t.PartDesc,
        process: t.ProcessName,
        qty: t.Quantity == null ? null : Number(t.Quantity),
        qty_issued: t.QuantityIssued == null ? null : Number(t.QuantityIssued),
        qty_received: t.QuantityReceived == null ? null : Number(t.QuantityReceived),
        qty_remaining: t.RemainingQty == null ? null : Number(t.RemainingQty),
        started_on: isoDay(t.StartDate),
        started_days: startedDays,
        last_worked_on: isoDay(t.LastWorkedOnDate),
        last_worked_days: lastWorkedDays,
        never_started: neverStarted,
        due,
        due_from: dueFrom,
        due_in_days: dueInDays,
        // Owner of the process schedule, NOT an assigned machinist. ETO has no
        // assignee on these rows; see etoDb.getInHouseTasks.
        owner: t.Owner || null,
        active_now: !!t.HasActivePunchIns,
        schedule: sched,
        flags,
      };
    });

    // Most urgent first: critical flag, then soonest due, then oldest.
    const rank = (r) =>
      (r.flags.includes('build-started-part-not') ? 0 :
       r.flags.includes('overdue') ? 1 :
       r.flags.includes('due-soon') ? 2 :
       r.flags.includes('stalled') ? 3 : 4);
    rows.sort((a, b) =>
      rank(a) - rank(b) ||
      (a.due_in_days ?? 9e9) - (b.due_in_days ?? 9e9) ||
      (b.started_days ?? 0) - (a.started_days ?? 0));

    res.json({
      generated_at: new Date().toISOString(),
      totals: {
        tasks: rows.length,
        jobs: jobs.length,
        never_started: rows.filter(r => r.never_started).length,
        active_now: rows.filter(r => r.active_now).length,
        build_started_part_not: rows.filter(r => r.flags.includes('build-started-part-not')).length,
        overdue: rows.filter(r => r.flags.includes('overdue')).length,
        due_soon: rows.filter(r => r.flags.includes('due-soon')).length,
        stalled: rows.filter(r => r.flags.includes('stalled')).length,
        no_eto_due_date: rows.filter(r => r.flags.includes('no-eto-due-date')).length,
        // Jobs in the queue with no scheduler project to date them against.
        jobs_without_schedule: jobs.filter(j => !schedules.has(j)).length,
      },
      by_process: Object.entries(
        rows.reduce((acc, r) => { acc[r.process || '—'] = (acc[r.process || '—'] || 0) + 1; return acc; }, {})
      ).map(([process, count]) => ({ process, count })).sort((a, b) => b.count - a.count),
      rows,
    });
  });

  return router;
};
