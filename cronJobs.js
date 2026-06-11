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

function start({ pool, emailSvc }) {
  if (!pool) return;
  let cron;
  try { cron = require('node-cron'); }
  catch (_) { cron = null; }

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
