'use strict';
/**
 * routes/manufacturing.js — the Manufacturing page's data (2026-08-26).
 *
 * Serves the shop's in-house manufacturing queue: what has to be MADE, joined
 * to this scheduler's build dates (WHEN it is needed). Read-only in both
 * directions — nothing here writes to ETO, and nothing writes to the scheduler
 * either.
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
 * ── TWO SOURCES OF IN-HOUSE WORK ───────────────────────────────────────────
 * The shop is asked to make things in two different ways, and this page merges
 * both. Showing only the first was under-reporting the queue by roughly 4x:
 *
 *   process-schedule — ETO's In House Tasks (vwProcessScheduleDetailInHouse).
 *                      Rich progress data: process name, sequence, qty issued,
 *                      last-worked-on date, live punch-ins. Weak dates.
 *   sdc-po          — a purchase order raised against "Steven Douglas Corp."
 *                      That is not a purchase; it is us making something,
 *                      booked as a PO. Firm dates, but NO progress data at all
 *                      beyond received quantity — no punches, no process, no
 *                      owner. See etoDb.getSdcPoTasks.
 *
 * Measured 2026-08-26: 11 parts in the process-schedule queue, 41 open SDC-PO
 * parts, overlapping on exactly 1. Forty parts the shop owed were invisible.
 *
 * The two are complementary rather than redundant, which is why they are merged
 * into ONE ranked queue rather than shown as two lists: the question a shop lead
 * asks is "what do we owe, most urgent first", and that question does not care
 * which ETO screen the work was entered on. Rows carry `source` so the UI can
 * still say where each came from — necessary, because the columns that are null
 * for an sdc-po row are genuinely unknown, not zero.
 *
 * ── The join, and where it is weak ─────────────────────────────────────────
 * ETO ProjectID  ===  scheduler projects.job_number, the same key etoDb.js
 * uses everywhere else. Jobs whose in-house tasks exist but which have no
 * scheduler project simply get no build context — they are still listed, with
 * `schedule: null`, rather than dropped. Silently hiding shop work because a PM
 * has not made a project yet would be the worst possible failure here. SDC POs
 * make this more visible: they land on internal/overhead job numbers
 * (8000176, 8000189, …) that will never have a scheduler project.
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

const num = (v) => (v == null ? null : Number(v));

module.exports = function createRouter(deps) {
  const { pool, etoDb } = deps;
  const router = Router();

  router.get('/api/manufacturing/in-house', async (req, res) => {
    if (!etoDb || !etoDb.CONFIGURED) {
      return res.status(503).json({ error: 'Total ETO is not configured on this server.' });
    }

    // Both sources are fetched independently and each is allowed to fail on its
    // own. One source down is a partial queue, which is still useful and is
    // DISCLOSED (`sources.*.error`); both down is a 503, because an empty
    // manufacturing queue reads as "nothing to make" and that would be a lie.
    const [psResult, poResult] = await Promise.all([
      etoDb.getInHouseTasks().then(
        (rows) => ({ rows }),
        (e) => ({ rows: [], error: `Could not read in-house tasks: ${e.message}` }),
      ),
      etoDb.getSdcPoTasks().then(
        (rows) => ({ rows }),
        (e) => ({ rows: [], error: `Could not read SDC purchase orders: ${e.message}` }),
      ),
    ]);

    if (psResult.error && poResult.error) {
      return res.status(503).json({ error: `Could not reach Total ETO. ${psResult.error} ${poResult.error}` });
    }

    // ── Build context per job, from this scheduler ──────────────────────────
    // Jobs come from BOTH sources, so a job that only has SDC-PO work still
    // gets its build dates.
    //
    // THREE queries total, not one per project. This used to run one span query
    // and one ship query for every project in the queue: 1 + 2N round trips,
    // 33 of them for the 16 jobs live on 2026-08-27, each with its own latency.
    // Grouping by project is the same answer in a fixed three trips.
    const jobs = [...new Set(
      [...psResult.rows, ...poResult.rows].map(t => String(t.ProjectID))
    )];
    const schedules = new Map();
    // Jobs whose job_number maps to more than one project — disclosed rather
    // than silently resolved, because the build window drives every flag on the
    // page and the right answer is to fix the duplicate project.
    const ambiguousJobs = [];
    if (jobs.length) {
      try {
        const [projects] = await pool.query(
          `SELECT id, name, job_number, status FROM projects
           WHERE job_number IN (?) AND (is_template IS NULL OR is_template = 0)`,
          [jobs]
        );

        // tasks.project is the project NAME, so both aggregates group by it.
        const names = projects.map(p => p.name);
        const spans = new Map();
        const ships = new Map();
        if (names.length) {
          const [spanRows] = await pool.query(
            `SELECT project, MIN(start_date) AS build_start, MAX(end_date) AS build_end
             FROM tasks
             WHERE project IN (?) AND department = 'shop'
               AND start_date IS NOT NULL AND start_date != ''
             GROUP BY project`,
            [names]
          );
          for (const r of spanRows) spans.set(r.project, r);
          const [shipRows] = await pool.query(
            `SELECT project, MIN(start_date) AS ship_date
             FROM tasks
             WHERE project IN (?) AND anchor_key = 'ship_machine'
               AND start_date IS NOT NULL AND start_date != ''
             GROUP BY project`,
            [names]
          );
          for (const r of shipRows) ships.set(r.project, r);
        }

        // A job_number is NOT unique in `projects` — 1101 has three rows and
        // 1153 has two (measured 2026-08-27), typically an old schedule kept
        // beside its revision. The previous code did `schedules.set(job, …)`
        // inside an unordered loop, so whichever row MySQL happened to return
        // last won. That silently picked a build window at random, and the
        // build window is what decides "overdue" and "build started, part not"
        // — the two loudest signals on this page.
        //
        // Resolve it deterministically instead: the project carrying the most
        // shop tasks is the one that actually holds the build; ties go to an
        // active project, then to the newest row. No job numbers are named
        // here — this is a rule, not a patch for 1101.
        const byJob = new Map();
        for (const p of projects) {
          const key = String(p.job_number);
          if (!byJob.has(key)) byJob.set(key, []);
          byJob.get(key).push(p);
        }
        const [taskCounts] = names.length
          ? await pool.query(
              `SELECT project, COUNT(*) AS n FROM tasks
               WHERE project IN (?) AND department = 'shop' GROUP BY project`,
              [names]
            )
          : [[]];
        const shopTaskCount = new Map(taskCounts.map(r => [r.project, Number(r.n)]));

        for (const [job, candidates] of byJob) {
          candidates.sort((a, b) =>
            (shopTaskCount.get(b.name) || 0) - (shopTaskCount.get(a.name) || 0) ||
            (b.status === 'active' ? 1 : 0) - (a.status === 'active' ? 1 : 0) ||
            b.id - a.id);
          const p = candidates[0];
          if (candidates.length > 1) {
            ambiguousJobs.push({
              job,
              chosen: p.name,
              others: candidates.slice(1).map(c => c.name),
            });
          }
          const span = spans.get(p.name);
          const ship = ships.get(p.name);
          schedules.set(job, {
            project: p.name,
            status: p.status,
            build_start: span && span.build_start ? isoDay(span.build_start) : null,
            build_end: span && span.build_end ? isoDay(span.build_end) : null,
            ship_date: ship && ship.ship_date ? isoDay(ship.ship_date) : null,
            // Present only when it matters, so the UI can say the dates below
            // were picked from several candidate projects.
            ambiguous: candidates.length > 1
              ? { chosen: p.name, others: candidates.slice(1).map(c => c.name) }
              : null,
          });
        }
      } catch (e) {
        // Losing build context degrades the page to ETO's own grid, which is
        // still useful. Don't fail the whole request over it.
        console.warn('[manufacturing] build-date lookup failed:', e.message);
      }
    }

    /**
     * The judgements the shop actually needs, applied identically to both
     * sources so one ranked queue is meaningful.
     *
     * `notStarted` differs per source and is passed in rather than derived
     * here, because "no work logged" and "nothing delivered" are different
     * facts that happen to answer the same question. Getting this wrong is the
     * main hazard in merging: an sdc-po row has no LastWorkedOnDate at all, so
     * reusing the process-schedule test verbatim would mark every single PO row
     * "never started" and fire `stalled` / `build-started-part-not` on all of
     * them — turning the page's loudest signals into noise.
     */
    function judge({ etoDue, sched, openedOn, notStarted, activeNow }) {
      // Fall back to the build start: a part is needed by the time the build
      // that consumes it begins. Flagged as derived so nobody mistakes it for
      // a date a buyer actually promised.
      const due = etoDue || (sched && sched.build_start) || null;
      const dueFrom = etoDue ? 'eto' : (due ? 'build-start' : null);

      const openedDays = daysAgo(openedOn);
      const dueInDays = due ? -daysAgo(due) : null;

      // Build already underway (or done) while the part is still outstanding.
      // The loudest signal on the page, and the one ETO cannot produce.
      const buildStartedDays = sched && sched.build_start ? daysAgo(sched.build_start) : null;
      const buildUnderway = buildStartedDays != null && buildStartedDays >= 0;

      const flags = [];
      if (buildUnderway && notStarted) flags.push('build-started-part-not');
      if (dueInDays != null && dueInDays < 0) flags.push('overdue');
      else if (dueInDays != null && dueInDays <= 14) flags.push('due-soon');
      // Stalled means opened long ago with no progress — distinct from
      // "recently raised and not started yet", which is normal.
      if (notStarted && openedDays != null && openedDays > 30) flags.push('stalled');
      if (!etoDue) flags.push('no-eto-due-date');
      if (activeNow) flags.push('active-now');

      return { due, due_from: dueFrom, due_in_days: dueInDays, opened_days: openedDays, flags };
    }

    // ── Source 1: ETO process schedules ────────────────────────────────────
    const psRows = psResult.rows.map(t => {
      const job = String(t.ProjectID);
      const sched = schedules.get(job) || null;
      const neverStarted = !t.LastWorkedOnDate;
      const j = judge({
        etoDue: isoDay(t.FinalRequiredDate),
        sched,
        openedOn: t.StartDate,
        notStarted: neverStarted,
        activeNow: !!t.HasActivePunchIns,
      });
      return {
        source: 'process-schedule',
        // Stable, source-side primary key. ETO holds several lines for the same
        // part on the same job, so job+part does not identify a row.
        row_id: t.ProcessScheduleDetailID == null ? null : `ps-${t.ProcessScheduleDetailID}`,
        job,
        item_id: t.ItemID == null ? null : Number(t.ItemID),
        section: t.SpecID == null ? null : Number(t.SpecID),
        ps_number: t.ProcessNumber,
        sequence: t.Sequence,
        po_number: null,
        part_no: t.PartNumber,
        description: t.PartDesc,
        process: t.ProcessName,
        qty: num(t.Quantity),
        qty_issued: num(t.QuantityIssued),
        qty_received: num(t.QuantityReceived),
        qty_remaining: num(t.RemainingQty),
        started_on: isoDay(t.StartDate),
        started_days: j.opened_days,
        last_worked_on: isoDay(t.LastWorkedOnDate),
        last_worked_days: daysAgo(t.LastWorkedOnDate),
        never_started: neverStarted,
        due: j.due,
        due_from: j.due_from,
        due_in_days: j.due_in_days,
        // Owner of the process schedule, NOT an assigned machinist. ETO has no
        // assignee on these rows; see etoDb.getInHouseTasks.
        owner: t.Owner || null,
        active_now: !!t.HasActivePunchIns,
        // Whether this row can report shop-floor progress at all. True here,
        // false for sdc-po — so the UI can show "no progress data" instead of
        // rendering an honest unknown as an idle zero.
        has_progress_data: true,
        schedule: sched,
        flags: j.flags,
      };
    });

    // ── Source 2: POs raised against ourselves ─────────────────────────────
    // Deduped against source 1 on (job, ItemID): the same part can be both on a
    // process schedule and on an SDC PO (1 part when this was written). The
    // process-schedule row wins because it is strictly richer — it carries the
    // process, sequence, issued qty and punch state that the PO row cannot.
    const psKeys = new Set(psRows.filter(r => r.item_id != null).map(r => `${r.job}:${r.item_id}`));
    let dedupedCount = 0;
    const poRows = [];
    for (const t of poResult.rows) {
      const job = String(t.ProjectID);
      const itemId = t.ItemID == null ? null : Number(t.ItemID);
      if (itemId != null && psKeys.has(`${job}:${itemId}`)) { dedupedCount++; continue; }

      const sched = schedules.get(job) || null;
      const qty = num(t.Quantity) || 0;
      const received = num(t.QuantityReceived) || 0;
      // Nothing delivered yet is the honest analogue of "never worked on" for a
      // PO line: partial receipt IS progress, so it must not count as unstarted.
      const nothingDelivered = received <= 0;
      const j = judge({
        // The line's own required date, falling back to the PO header's. Same
        // precedence every other SDC app uses for a PO's expected date.
        etoDue: isoDay(t.DateRequired) || isoDay(t.PurchaseDateRequired),
        sched,
        openedOn: t.PurchaseDate,
        notStarted: nothingDelivered,
        // No punch-in data exists on a PO line. False means "unknown", not
        // "idle" — has_progress_data below is what says which.
        activeNow: false,
      });
      poRows.push({
        source: 'sdc-po',
        row_id: t.PurchaseDetailID == null ? null : `po-${t.PurchaseDetailID}`,
        job,
        item_id: itemId,
        section: t.SpecID == null ? null : Number(t.SpecID),
        ps_number: null,
        sequence: null,
        po_number: t.PurchaseOrderID == null ? null : String(t.PurchaseOrderID),
        part_no: t.PartNumber,
        description: t.PartDesc,
        // No process name on a PO line. Left null rather than invented so the
        // by_process breakdown stays a real answer about ETO processes.
        process: null,
        qty,
        // ETO issues no material against a PO line — unknown, not zero.
        qty_issued: null,
        qty_received: received,
        qty_remaining: Math.max(0, qty - received),
        started_on: isoDay(t.PurchaseDate),
        started_days: j.opened_days,
        last_worked_on: isoDay(t.LastReceivedDate),
        last_worked_days: daysAgo(t.LastReceivedDate),
        never_started: nothingDelivered,
        due: j.due,
        due_from: j.due_from,
        due_in_days: j.due_in_days,
        owner: null,
        active_now: false,
        has_progress_data: false,
        schedule: sched,
        flags: j.flags,
      });
    }

    const rows = [...psRows, ...poRows];

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
      // Per-source health, so a partial queue is never mistaken for a short one.
      sources: {
        process_schedule: { count: psRows.length, error: psResult.error || null },
        sdc_po: { count: poRows.length, error: poResult.error || null, deduped: dedupedCount },
      },
      totals: {
        tasks: rows.length,
        jobs: jobs.length,
        process_schedule: psRows.length,
        sdc_po: poRows.length,
        never_started: rows.filter(r => r.never_started).length,
        active_now: rows.filter(r => r.active_now).length,
        build_started_part_not: rows.filter(r => r.flags.includes('build-started-part-not')).length,
        overdue: rows.filter(r => r.flags.includes('overdue')).length,
        due_soon: rows.filter(r => r.flags.includes('due-soon')).length,
        stalled: rows.filter(r => r.flags.includes('stalled')).length,
        no_eto_due_date: rows.filter(r => r.flags.includes('no-eto-due-date')).length,
        // Jobs in the queue with no scheduler project to date them against.
        jobs_without_schedule: jobs.filter(j => !schedules.has(j)).length,
        // Jobs whose job_number matches more than one project here. The build
        // dates shown for these were picked from several candidates, so the
        // page can say so rather than presenting a guess as fact.
        jobs_ambiguous_project: ambiguousJobs.length,
      },
      ambiguous_jobs: ambiguousJobs,
      by_source: [
        { source: 'process-schedule', label: 'Process schedule', count: psRows.length },
        { source: 'sdc-po', label: 'SDC purchase order', count: poRows.length },
      ],
      by_process: Object.entries(
        rows.reduce((acc, r) => { acc[r.process || '—'] = (acc[r.process || '—'] || 0) + 1; return acc; }, {})
      ).map(([process, count]) => ({ process, count })).sort((a, b) => b.count - a.count),
      rows,
    });
  });

  return router;
};
