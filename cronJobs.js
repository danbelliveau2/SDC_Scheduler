'use strict';
const cron = require('node-cron');

// Add N business days to an ISO date string
function addBizDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  let rem = Math.abs(n);
  const dir = n >= 0 ? 1 : -1;
  while (rem > 0) {
    d.setUTCDate(d.getUTCDate() + dir);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) rem--;
  }
  return d.toISOString().slice(0, 10);
}

async function runDueDateNotifications(db, emailService) {
  const today = new Date().toISOString().slice(0, 10);
  const horizon = addBizDays(today, 3);

  // Tasks due within 3 business days, incomplete, with an assignee
  const tasks = db.prepare(`
    SELECT id, name, project, end_date, assignee, progress
    FROM   tasks
    WHERE  assignee IS NOT NULL
      AND  end_date  IS NOT NULL
      AND  progress  < 100
      AND  end_date >= ?
      AND  end_date <= ?
    ORDER  BY end_date ASC
  `).all(today, horizon);

  if (tasks.length === 0) {
    console.log('[Cron] Due-date check: no upcoming tasks.');
    return;
  }

  // Group by assignee
  const byAssignee = {};
  for (const t of tasks) {
    (byAssignee[t.assignee] = byAssignee[t.assignee] || []).push(t);
  }

  for (const [assigneeName, assigneeTasks] of Object.entries(byAssignee)) {
    const user = db.prepare('SELECT email FROM users WHERE name = ? AND active = 1').get(assigneeName);
    if (!user) continue;

    // Dedup: only send once per assignee per calendar day
    const key = `due_soon:${assigneeName}:${today}`;
    const already = db.prepare('SELECT 1 FROM notification_log WHERE reference_key = ?').get(key);
    if (already) continue;

    try {
      await emailService.sendDueSoonDigest({
        toEmail: user.email,
        toName:  assigneeName,
        tasks:   assigneeTasks,
      });
      db.prepare(
        `INSERT OR IGNORE INTO notification_log (user_email, type, reference_key) VALUES (?, 'due_soon', ?)`
      ).run(user.email, key);
    } catch (err) {
      console.error(`[Cron] Failed to notify ${user.email}:`, err.message);
    }
  }

  console.log(`[Cron] Due-date notifications done — ${tasks.length} tasks, ${Object.keys(byAssignee).length} assignees.`);
}

function startCronJobs(db, emailService) {
  // Daily at 8:00 AM local server time, Mon–Fri
  cron.schedule('0 8 * * 1-5', () => {
    console.log('[Cron] Running daily due-date notifications…');
    runDueDateNotifications(db, emailService)
      .catch(err => console.error('[Cron] Error:', err.message));
  });
  console.log('[Cron] Due-date notification job scheduled — daily 8am Mon–Fri.');
}

module.exports = { startCronJobs, runDueDateNotifications };
