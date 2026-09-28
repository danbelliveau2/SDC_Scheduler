'use strict';
/**
 * Reconciles projects.customer from two read-only sources, in priority order:
 *   1. The ETC Planner (sdc_etc_planner.Job.customer), via plannerClient.getJobs()
 *      — manager-curated (a person may have retyped "FIRST SOLAR, INC." as
 *      "First Solar" there). Wins whenever the Planner tracks the job.
 *   2. Total ETO's raw vwProjects.CName, via etoDb.getEtoCustomerMap() —
 *      fallback for jobs the Planner doesn't track yet (its own ETO sync
 *      skips jobs it doesn't already recognize).
 *
 * Both maps are fetched first and merged in memory, so each project gets
 * exactly ONE write per tick to the value that wins — never a raw-ETO write
 * immediately clobbered by a Planner write a moment later.
 *
 * Never touches a row flagged customer_manually_edited, and writes only rows
 * whose value actually changed, so re-running every 30 min doesn't churn
 * customer_synced_at on rows nothing changed for. A source that fails or
 * isn't configured just contributes an empty map — never blocks the other.
 */
async function syncCustomerNames(pool, { etoDb, plannerClient } = {}) {
  const plannerMap = new Map();
  if (plannerClient && plannerClient.CONFIGURED) {
    try {
      const jobs = await plannerClient.getJobs();
      for (const j of jobs) {
        if (j && j.jobId != null && j.customer) plannerMap.set(String(j.jobId).trim(), j.customer);
      }
    } catch (e) {
      console.warn('[customerSync] ETC Planner fetch failed (falling back to ETO only):', e.message);
    }
  }

  let etoMap = new Map();
  if (etoDb && etoDb.CONFIGURED) {
    try {
      etoMap = await etoDb.getEtoCustomerMap();
    } catch (e) {
      console.warn('[customerSync] Total ETO fetch failed:', e.message);
    }
  }

  if (plannerMap.size === 0 && etoMap.size === 0) return { matched: 0, updated: 0, jobs: 0 };

  const [rows] = await pool.query(
    `SELECT id, job_number, customer FROM projects
     WHERE job_number IS NOT NULL AND job_number != ''
       AND (is_template IS NULL OR is_template = 0)
       AND (customer_manually_edited IS NULL OR customer_manually_edited = 0)`
  );

  let matched = 0, updated = 0;
  for (const row of rows) {
    const jobNumber = String(row.job_number).trim();
    const next = plannerMap.has(jobNumber) ? plannerMap.get(jobNumber)
      : etoMap.has(jobNumber) ? etoMap.get(jobNumber)
      : undefined;
    if (next === undefined) continue;
    matched++;
    if ((row.customer || null) === (next || null)) continue;
    await pool.query(
      `UPDATE projects SET customer = ?, customer_synced_at = NOW() WHERE id = ?`,
      [next, row.id]
    );
    updated++;
  }
  return { matched, updated, jobs: rows.length, plannerJobs: plannerMap.size, etoJobs: etoMap.size };
}

module.exports = { syncCustomerNames };
