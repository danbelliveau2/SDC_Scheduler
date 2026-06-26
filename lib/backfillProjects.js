'use strict';
/**
 * backfillProjects.js — register + ETO-link orphan schedules on boot.
 *
 * A schedule can live as a task-tab (a `project` value on tasks) with no row in
 * the `projects` table, so it never gets a `job_number` / ETO link and won't
 * show procurement data. This walks those cases once at startup:
 *
 *   1. Task-tabs with a numeric job prefix (e.g. "1160_Y Site Automation") that
 *      have NO projects row → create the row, and set job_number to the prefix
 *      ONLY if that number is a real Total ETO job (validated, never bogus).
 *   2. Existing projects rows with an empty job_number whose name has a numeric
 *      prefix → fill in job_number if the prefix is a real ETO job.
 *
 * Validation requires the ETO bridge; if ETO isn't configured we skip (the chosen
 * "validate vs ETO" policy — we don't guess links). Re-running is safe and
 * self-healing: a tab linked to a job that only appears in ETO later gets linked
 * on the next boot.
 *
 * Non-numeric tabs (templates, ad-hoc names) are intentionally left alone.
 */

// Leading 3+ digits → the SDC convention puts the ETO job number first.
function jobFromName(name) {
  const m = String(name || '').match(/^\s*(\d{3,})/);
  return m ? parseInt(m[1], 10) : null;
}

async function backfillProjects(pool, etoDb) {
  if (!etoDb || !etoDb.CONFIGURED) {
    console.log('[backfill] ETO not configured — skipping project link backfill.');
    return { skipped: true };
  }

  const validCache = new Map();
  const isValidJob = async (job) => {
    if (validCache.has(job)) return validCache.get(job);
    let okv = false;
    try { okv = !!(await etoDb.getProjectInfo(job)); } catch (_) { okv = false; }
    validCache.set(job, okv);
    return okv;
  };

  let registered = 0, linked = 0, checked = 0;

  // 1) Orphan task-tabs (no projects row) — only ones with a numeric job prefix.
  try {
    const [orphans] = await pool.query(
      `SELECT DISTINCT t.project AS name
         FROM tasks t
         LEFT JOIN projects p ON p.name = t.project
        WHERE p.id IS NULL AND t.project IS NOT NULL AND t.project <> ''`);
    for (const r of orphans) {
      const job = jobFromName(r.name);
      if (!job) continue;                 // skip templates / non-job tabs
      checked++;
      const valid = await isValidJob(job);
      try {
        await pool.query(
          'INSERT IGNORE INTO projects (name, status, job_number, workspace) VALUES (?, "active", ?, "default")',
          [r.name, valid ? String(job) : null]);
        registered++;
        if (valid) { linked++; console.log(`[backfill] registered "${r.name}" → ETO job ${job}`); }
        else console.log(`[backfill] registered "${r.name}" (prefix ${job} not a live ETO job — left unlinked)`);
      } catch (e) { console.warn(`[backfill] could not register "${r.name}": ${e.message}`); }
    }
  } catch (e) { console.warn('[backfill] orphan scan failed:', e.message); }

  // 2) Registered-but-unlinked projects with a numeric prefix.
  try {
    const [unlinked] = await pool.query(
      `SELECT id, name FROM projects WHERE (job_number IS NULL OR job_number = '')`);
    for (const p of unlinked) {
      const job = jobFromName(p.name);
      if (!job) continue;
      checked++;
      if (await isValidJob(job)) {
        try {
          await pool.query('UPDATE projects SET job_number = ? WHERE id = ?', [String(job), p.id]);
          linked++;
          console.log(`[backfill] linked existing project "${p.name}" → ETO job ${job}`);
        } catch (e) { console.warn(`[backfill] could not link "${p.name}": ${e.message}`); }
      }
    }
  } catch (e) { console.warn('[backfill] unlinked scan failed:', e.message); }

  console.log(`[backfill] done — ${registered} newly registered, ${linked} linked to ETO (checked ${checked} prefixes).`);
  return { registered, linked, checked };
}

module.exports = { backfillProjects, jobFromName };
