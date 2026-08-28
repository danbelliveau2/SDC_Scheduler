'use strict';
/**
 * cronJobs.js — Phase 7 scheduled background work.
 *
 * Currently registers a single weekday-9am digest that emails each active user
 * a list of their open tasks. No-ops when emailService.ENABLED is false.
 *
 * start({ pool, emailSvc }) is called once from server.js. Safe to call without
 * node-cron installed — falls back to a 30-min setInterval that checks the
 * clock and fires once per qualifying window.
 */

function start({ pool, emailSvc, etoDb, io, ops, hoursApi }) {
  if (!pool) return;
  let cron;
  try { cron = require('node-cron'); }
  catch (_) { cron = null; }

  // Nightly DB backup at 02:00 ET. On failure, alert the first admin by email
  // (no-op if SMTP is off — the failure is still logged loudly either way).
  if (ops && typeof ops.runBackup === 'function') {
    const backupTick = async () => {
      try {
        await ops.runBackup();
      } catch (e) {
        if (emailSvc && emailSvc.ENABLED && typeof emailSvc.sendAlert === 'function') {
          try {
            const [admins] = await pool.query("SELECT email FROM users WHERE role = 'admin' AND active = 1 AND email IS NOT NULL ORDER BY id LIMIT 1");
            if (admins[0]) await emailSvc.sendAlert({ to: admins[0].email, subject: '[SDC Scheduler] Nightly DB backup FAILED', text: `The scheduled database backup failed:\n\n${e.message}\n\nCheck MYSQLDUMP_PATH and disk space on the server.` });
          } catch (_) {}
        }
      }
    };
    if (cron) {
      cron.schedule('0 2 * * *', backupTick, { timezone: 'America/New_York' });
      console.log('[cron] Registered: nightly DB backup at 02:00 ET');
    } else {
      let lastBackupDay = '';
      setInterval(() => {
        const now = new Date();
        if (now.getHours() === 2 && now.getMinutes() < 30) {
          const tag = now.toISOString().slice(0, 10);
          if (lastBackupDay !== tag) { lastBackupDay = tag; backupTick(); }
        }
      }, 20 * 60 * 1000);
      console.log('[cron] node-cron not installed — nightly backup via 20m setInterval fallback');
    }
  }

  // ETO → vendor_pos sync every 30 min (no-op when ETO_* env vars unset).
  // Scope 'all': refreshes every ETO-synced row + pulls newly cut open POs
  // across the whole ERP, so the tracker stays comprehensive on its own.
  if (etoDb && etoDb.CONFIGURED) {
    const etoTick = async () => {
      try {
        const r = await etoDb.syncVendorPOs(pool, 'all');
        if (ops && typeof ops.recordEtoSync === 'function') ops.recordEtoSync(r);
        if ((r.created || r.updated) && io) io.emit('vendor_pos:updated');
        console.log(`[cron] ETO vendor PO sync: ${r.pos} POs across ${r.jobs} jobs (${r.created} new, ${r.updated} updated)`);
      } catch (e) {
        console.warn('[cron] ETO vendor PO sync failed:', e.message);
      }

      // Shop Parts receiving, in its own try/catch so a failure here cannot cost
      // us the vendor PO sync above (and vice versa) — they share the tick but
      // not their fate. Only touches shop_parts rows with an eto_po set.
      try {
        if (typeof etoDb.syncShopPartReceipts === 'function') {
          const s = await etoDb.syncShopPartReceipts(pool);
          if (s.completed && io) io.emit('shop_parts:updated');
          if (s.linked) {
            console.log(`[cron] ETO shop part receipts: ${s.linked} linked, ${s.matched} matched, ` +
              `${s.completed} auto-completed, ${s.unmatched} not on PO, ${s.skipped} skipped (unparseable job)`);
          }
        }
      } catch (e) {
        console.warn('[cron] ETO shop part receipt sync failed:', e.message);
      }
    };
    setInterval(etoTick, 30 * 60 * 1000);
    setTimeout(etoTick, 15 * 1000); // first pass shortly after boot
    console.log('[cron] Registered: ETO vendor PO sync every 30 min');

    // Re-register / re-link orphan task-tab schedules every 30 min, so schedules
    // created (or ETO jobs that appear) BETWEEN restarts get picked up without a
    // reboot. Boot already runs this once (server.js); this is just the periodic
    // re-check that covers future cases. Independent of the sync above.
    let backfill = null;
    try { ({ backfillProjects: backfill } = require('./backfillProjects')); } catch (_) {}
    if (backfill) {
      setInterval(() => {
        backfill(pool, etoDb).catch(e => console.warn('[cron] project backfill failed:', e.message));
      }, 30 * 60 * 1000);
      console.log('[cron] Registered: orphan-schedule ETO backfill every 30 min');
    }
  }

  // Hours cache refresh — every 4 hours + once 2 min after boot. Warms the cache
  // so nobody waits on a round-trip to the Reports App. Source is Paylocity
  // punches + the Reports App DB, not Power BI (see lib/hoursApi.js).
  if (hoursApi && hoursApi.ENABLED) {
    const hoursRefreshTick = async () => {
      try {
        // Job ids come from the projects table only. This used to ALSO scavenge
        // ids out of the hours cache directory's filenames, which was doubly
        // wrong: it pointed at '.pbi-cache' (retired when hours moved off Power
        // BI on 2026-08-26), and the key format 'job_<a>_<b>' cannot be split
        // back on '_' because an id may itself contain one — "2023_SER" came
        // back apart as "2023" and "SER", and the refresh then logged failures
        // for jobs that never existed. The projects table is authoritative and
        // needs no reverse-engineering.
        const [rows] = await pool.query(`SELECT hours_job_id, job_number FROM projects WHERE (hours_job_id IS NOT NULL AND hours_job_id != '') OR (job_number IS NOT NULL AND job_number != '')`);
        const allIds = [...new Set(rows.map(r => (r.hours_job_id || r.job_number || '').trim()).filter(Boolean))];
        console.log(`[cron] hours cache refresh: ${allIds.length} job(s)`);
        for (const id of allIds) await hoursApi.getJobHours(id).catch(e => console.warn(`[cron] hours refresh failed for ${id}:`, e.message));
        console.log('[cron] hours cache refresh complete');
      } catch (e) {
        console.warn('[cron] hours cache refresh failed:', e.message);
      }
    };
    if (cron) {
      cron.schedule('0 */4 * * *', hoursRefreshTick);
      console.log('[cron] Registered: hours cache refresh every 4 hours');
    } else {
      setInterval(hoursRefreshTick, 4 * 60 * 60 * 1000);
      console.log('[cron] node-cron not installed — hours refresh via 4h setInterval fallback');
    }
    // Fire once 2 min after boot to fill in any jobs the 5s startup warmup didn't reach
    setTimeout(hoursRefreshTick, 2 * 60 * 1000);
  }

  // ── Service Work Order day-before reminders (R2 §9) ──────────────────────
  // Every day at 07:00 ET, find open Work Orders dated TOMORROW and remind the
  // assigned employee once. Runs seven days a week on purpose: Service work
  // lands on weekends, and a Saturday call-out still deserves its Friday
  // heads-up.
  //
  // Duplicate suppression is threefold and none of it lives here: the sweep
  // only selects rows with reminder_sent_at IS NULL, stamps that column when it
  // sends, and the send itself goes through notification_log's UNIQUE
  // reference_key. A double-fired cron, a restart mid-sweep, or a manual
  // re-run therefore cannot produce a second email.
  {
    let serviceRoutes = null;
    try { serviceRoutes = require('../routes/service'); } catch (_) {}
    if (serviceRoutes && typeof serviceRoutes.reminderSweep === 'function') {
      const reminderTick = async () => {
        try {
          const r = await serviceRoutes.reminderSweep({ pool, emailSvc });
          if (r.due) console.log(`[cron] Service WO reminders: ${r.sent}/${r.due} sent for tomorrow`);
          if (r.sent && io) io.emit('service:updated');
        } catch (e) {
          console.warn('[cron] Service WO reminder sweep failed:', e.message);
        }
      };
      if (cron) {
        cron.schedule('0 7 * * *', reminderTick, { timezone: 'America/New_York' });
        console.log('[cron] Registered: Service Work Order day-before reminders at 07:00 ET');
      } else {
        let lastReminderDay = '';
        setInterval(() => {
          const now = new Date();
          if (now.getHours() === 7 && now.getMinutes() < 30) {
            const tag = now.toISOString().slice(0, 10);
            if (lastReminderDay !== tag) { lastReminderDay = tag; reminderTick(); }
          }
        }, 20 * 60 * 1000);
        console.log('[cron] node-cron not installed — Service WO reminders via 20m setInterval fallback');
      }
    }
  }

  const tickAtNineAmWeekdays = async () => {
    if (!emailSvc || !emailSvc.ENABLED) return;
    try {
      const [users] = await pool.query('SELECT email FROM users WHERE active = 1 AND email IS NOT NULL');
      for (const u of users) {
        const [items] = await pool.query(`
          SELECT id, name, end_date FROM tasks
          WHERE assignee = (SELECT name FROM users WHERE email = ?) AND COALESCE(progress, 0) < 100
          ORDER BY end_date ASC LIMIT 25
        `, [u.email]);
        if (items.length > 0) {
          await emailSvc.sendDigest({ pool, to: u.email, items });
        }
      }
    } catch (e) {
      console.warn('[cron] digest tick failed:', e.message);
    }
  };

  if (cron) {
    cron.schedule('0 9 * * 1-5', tickAtNineAmWeekdays, { timezone: 'America/New_York' });
    console.log('[cron] Registered: weekday digest at 09:00 ET');
  } else {
    let lastFired = '';
    setInterval(() => {
      const now = new Date();
      const day = now.getDay();
      if (day === 0 || day === 6) return;
      if (now.getHours() === 9 && now.getMinutes() < 30) {
        const tag = now.toISOString().slice(0, 10);
        if (lastFired !== tag) {
          lastFired = tag;
          tickAtNineAmWeekdays();
        }
      }
    }, 30 * 60 * 1000);
    console.log('[cron] node-cron not installed — using 30m setInterval fallback');
  }
}

module.exports = { start };
