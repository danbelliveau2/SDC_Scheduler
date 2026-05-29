'use strict';
/**
 * cronJobs.js — Phase 7 scheduled background work.
 *
 * Currently registers a single weekday-9am digest that emails each active user
 * a list of their open tasks. No-ops when emailService.ENABLED is false.
 *
 * start({ db, emailSvc }) is called once from server.js. Safe to call without
 * node-cron installed — falls back to a 30-min setInterval that checks the
 * clock and fires once per qualifying window.
 */

function start({ db, emailSvc }) {
  if (!db) return;
  let cron;
  try { cron = require('node-cron'); }
  catch (_) { cron = null; }

  const tickAtNineAmWeekdays = async () => {
    if (!emailSvc || !emailSvc.ENABLED) return; // SMTP not configured
    try {
      const users = db.prepare('SELECT email FROM users WHERE active = 1 AND email IS NOT NULL').all();
      for (const u of users) {
        // Open tasks where the user is the assignee. Limit to 25 so the
        // email body stays readable.
        const items = db.prepare(`
          SELECT id, name, end_date FROM tasks
          WHERE assignee = (SELECT name FROM users WHERE email = ?) AND COALESCE(progress, 0) < 100
          ORDER BY end_date ASC LIMIT 25
        `).all(u.email);
        if (items.length > 0) {
          await emailSvc.sendDigest({ db, to: u.email, items });
        }
      }
    } catch (e) {
      console.warn('[cron] digest tick failed:', e.message);
    }
  };

  if (cron) {
    // Every weekday at 09:00 local time.
    cron.schedule('0 9 * * 1-5', tickAtNineAmWeekdays, { timezone: 'America/New_York' });
    console.log('[cron] Registered: weekday digest at 09:00 ET');
  } else {
    // Fallback: poll every 30 min, fire only when the local clock just
    // crossed into 9 a.m. on a weekday. Coarser but no extra dep needed.
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
