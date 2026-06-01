'use strict';
require('dotenv').config();
const nodemailer = require('nodemailer');

const SMTP_CONFIGURED = !!(process.env.SMTP_HOST && process.env.SMTP_USER);

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return _transporter;
}

const FROM = process.env.SMTP_FROM || 'SDC Scheduler <noreply@sdc-automation.com>';

async function sendEmail({ to, subject, html, text }) {
  if (!SMTP_CONFIGURED) {
    console.log(`[Email] SMTP not configured — skipping: "${subject}" → ${to}`);
    return { skipped: true };
  }
  try {
    const info = await getTransporter().sendMail({ from: FROM, to, subject, html, text });
    console.log(`[Email] Sent "${subject}" → ${to}`);
    return info;
  } catch (err) {
    console.error(`[Email] Failed "${subject}" → ${to}: ${err.message}`);
    return { error: err.message };
  }
}

// ── Shared design tokens ──────────────────────────────────────────────────────
const C = {
  navy:    '#061d39',
  blue:    '#1574c4',
  blueLight: '#e8f2fb',
  green:   '#16a34a',
  greenLight: '#dcfce7',
  amber:   '#d97706',
  amberLight: '#fef3c7',
  red:     '#dc2626',
  redLight: '#fee2e2',
  slate:   '#334155',
  muted:   '#64748b',
  border:  '#e2e8f0',
  bg:      '#f8fafc',
  white:   '#ffffff',
  text:    '#0f172a',
};

// ── Base HTML shell ───────────────────────────────────────────────────────────
function shell({ preheader = '', body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="x-apple-disable-message-reformatting"/>
  <title>SDC Automation Scheduler</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">

${preheader ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#eef2f7;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>` : ''}

<!-- Outer wrapper -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef2f7;padding:32px 16px;">
<tr><td align="center">

  <!-- Email card — max 600px -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">

    <!-- ── Header ── -->
    <tr>
      <td style="background:${C.navy};border-radius:12px 12px 0 0;padding:20px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              <span style="display:inline-block;width:4px;height:28px;background:${C.blue};border-radius:2px;vertical-align:middle;margin-right:10px;"></span>
              <span style="color:${C.white};font-size:18px;font-weight:700;letter-spacing:-0.3px;vertical-align:middle;">SDC Automation Scheduler</span>
            </td>
            <td align="right">
              <span style="color:#aacee8;font-size:12px;letter-spacing:0.5px;text-transform:uppercase;">Notification</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ── Body ── -->
    <tr>
      <td style="background:${C.white};padding:32px 32px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};">
        ${body}
      </td>
    </tr>

    <!-- ── Footer ── -->
    <tr>
      <td style="background:${C.bg};border:1px solid ${C.border};border-top:none;border-radius:0 0 12px 12px;padding:16px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.6;">
                You are receiving this notification because you are a member of
                <strong style="color:#64748b;">SDC Automation</strong>.
                Notifications are sent for task assignments, @mentions, and upcoming deadlines.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

  </table>
</td></tr>
</table>

</body>
</html>`;
}

// ── Reusable components ───────────────────────────────────────────────────────

function ctaButton(label, url = '#') {
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
      <tr>
        <td style="background:${C.blue};border-radius:8px;">
          <a href="${url}" style="display:inline-block;padding:12px 28px;color:${C.white};font-size:14px;font-weight:600;text-decoration:none;letter-spacing:0.1px;">${label}</a>
        </td>
      </tr>
    </table>`;
}

function taskCard({ name, project, assignedBy, startDate, endDate, progress, priority }) {
  const progressBar = progress != null ? `
    <tr>
      <td style="padding:10px 16px 12px;">
        <div style="font-size:11px;color:${C.muted};margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px;">Progress</div>
        <div style="background:#e2e8f0;border-radius:20px;height:6px;overflow:hidden;">
          <div style="background:${progress >= 100 ? C.green : C.blue};width:${Math.min(100,progress||0)}%;height:100%;border-radius:20px;"></div>
        </div>
        <div style="font-size:12px;color:${C.muted};margin-top:4px;">${progress||0}% complete</div>
      </td>
    </tr>` : '';

  const dateRow = (startDate || endDate) ? `
    <tr>
      <td style="padding:0 16px 12px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            ${startDate ? `<td style="width:50%;">
              <div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Start Date</div>
              <div style="font-size:13px;font-weight:600;color:${C.slate};">${startDate}</div>
            </td>` : ''}
            ${endDate ? `<td style="width:50%;">
              <div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Due Date</div>
              <div style="font-size:13px;font-weight:600;color:${C.slate};">${endDate}</div>
            </td>` : ''}
          </tr>
        </table>
      </td>
    </tr>` : '';

  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
      style="border:1.5px solid ${C.border};border-radius:10px;overflow:hidden;margin:20px 0;">

      <!-- Card header bar -->
      <tr>
        <td style="background:${C.blueLight};padding:10px 16px;border-bottom:1px solid ${C.border};">
          <span style="font-size:11px;color:${C.blue};font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">📋 Task Details</span>
        </td>
      </tr>

      <!-- Task name -->
      <tr>
        <td style="padding:14px 16px 4px;">
          <div style="font-size:17px;font-weight:700;color:${C.text};line-height:1.35;">${esc(name)}</div>
        </td>
      </tr>

      <!-- Project -->
      <tr>
        <td style="padding:4px 16px 12px;">
          <span style="display:inline-block;background:${C.navy};color:${C.white};font-size:11px;
                       font-weight:600;padding:3px 10px;border-radius:20px;letter-spacing:0.3px;">
            ${esc(project)}
          </span>
          ${assignedBy ? `<span style="font-size:12px;color:${C.muted};margin-left:8px;">Assigned by <strong>${esc(assignedBy)}</strong></span>` : ''}
        </td>
      </tr>

      <!-- Divider -->
      <tr><td style="border-top:1px solid ${C.border};"></td></tr>

      ${dateRow}
      ${progressBar}
    </table>`;
}

function greeting(name) {
  return `<p style="margin:0 0 20px;font-size:16px;color:${C.text};">Hi <strong>${esc(name)}</strong>,</p>`;
}

function divider() {
  return `<div style="border-top:1px solid ${C.border};margin:24px 0;"></div>`;
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 1. Task Assignment Email ──────────────────────────────────────────────────
async function sendTaskAssignmentEmail({ toEmail, toName, taskName, project, assignedBy, startDate, endDate }) {
  const subject = `Task assigned to you — ${taskName}`;

  const body = `
    ${greeting(toName)}

    <p style="margin:0 0 4px;font-size:15px;color:${C.slate};">
      <strong style="color:${C.text};">${esc(assignedBy)}</strong> assigned you a new task.
      You are now responsible for delivering this work on time.
    </p>

    ${taskCard({ name: taskName, project, assignedBy, startDate, endDate, progress: 0 })}

    <p style="margin:0;font-size:13px;color:${C.muted};line-height:1.6;">
      Open the scheduler to review your task, update your progress, and coordinate
      with your team. Use the comments section on the task to ask questions or share updates.
    </p>

    ${ctaButton('Open My Tasks', 'http://localhost:4003')}

    ${divider()}
    <p style="margin:0;font-size:12px;color:${C.muted};">
      Assigned by <strong>${esc(assignedBy)}</strong> &nbsp;·&nbsp; Project: <strong>${esc(project)}</strong>
    </p>
  `;

  await sendEmail({
    to: toEmail,
    subject: `[SDC Scheduler] ${subject}`,
    html: shell({ preheader: `${assignedBy} assigned you: ${taskName} in ${project}`, body }),
    text: `${assignedBy} assigned you "${taskName}" in project ${project}.\nStart: ${startDate || 'TBD'}  Due: ${endDate || 'TBD'}\nOpen: http://localhost:4003`,
  });
}

// ── 2. @Mention Email ─────────────────────────────────────────────────────────
async function sendMentionEmail({ toEmail, toName, authorName, taskName, project, commentBody }) {
  const subject = `${authorName} mentioned you in a comment`;
  const safeComment = esc(commentBody);

  const body = `
    ${greeting(toName)}

    <p style="margin:0 0 20px;font-size:15px;color:${C.slate};">
      <strong style="color:${C.text};">${esc(authorName)}</strong> mentioned you in a comment
      on task <strong style="color:${C.text};">${esc(taskName)}</strong>.
    </p>

    <!-- Comment bubble -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
      style="border:1.5px solid ${C.border};border-radius:10px;overflow:hidden;margin:0 0 20px;">
      <tr>
        <td style="background:${C.bg};padding:10px 16px;border-bottom:1px solid ${C.border};">
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="width:32px;height:32px;background:${C.blue};border-radius:50%;text-align:center;vertical-align:middle;">
                <span style="color:${C.white};font-size:13px;font-weight:700;">${esc(authorName).charAt(0).toUpperCase()}</span>
              </td>
              <td style="padding-left:10px;">
                <div style="font-size:13px;font-weight:700;color:${C.text};">${esc(authorName)}</div>
                <div style="font-size:11px;color:${C.muted};">in <strong>${esc(project)}</strong> · ${esc(taskName)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:16px;background:${C.white};">
          <p style="margin:0;font-size:14px;color:${C.slate};line-height:1.65;font-style:italic;">
            &ldquo;${safeComment}&rdquo;
          </p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 4px;font-size:13px;color:${C.muted};">
      Reply in the scheduler to keep the conversation on the task where everyone can see it.
    </p>

    ${ctaButton('View Comment & Reply', 'http://localhost:4003')}

    ${divider()}
    <p style="margin:0;font-size:12px;color:${C.muted};">
      Task: <strong>${esc(taskName)}</strong> &nbsp;·&nbsp; Project: <strong>${esc(project)}</strong>
    </p>
  `;

  await sendEmail({
    to: toEmail,
    subject: `[SDC Scheduler] ${subject}`,
    html: shell({ preheader: `${authorName} mentioned you: "${commentBody.slice(0,80)}"`, body }),
    text: `${authorName} mentioned you on "${taskName}" in ${project}:\n\n"${commentBody}"\n\nReply at: http://localhost:4003`,
  });
}

// ── 3. Due-Date Digest Email ──────────────────────────────────────────────────
async function sendDueSoonDigest({ toEmail, toName, tasks }) {
  const today     = new Date().toISOString().slice(0, 10);
  const taskCount = tasks.length;
  const subject   = `${taskCount} task${taskCount > 1 ? 's' : ''} due in the next 3 days`;

  const overdueCount = tasks.filter(t => t.end_date < today).length;
  const dueTodayCount = tasks.filter(t => t.end_date === today).length;

  // Summary chips
  const chips = [
    dueTodayCount  > 0 ? `<span style="background:${C.redLight};color:${C.red};font-size:12px;font-weight:700;padding:4px 12px;border-radius:20px;margin-right:8px;">🔴 ${dueTodayCount} due today</span>` : '',
    overdueCount   > 0 ? `<span style="background:${C.redLight};color:${C.red};font-size:12px;font-weight:700;padding:4px 12px;border-radius:20px;margin-right:8px;">⚠️ ${overdueCount} overdue</span>` : '',
  ].filter(Boolean).join('');

  // Task rows
  const taskRows = tasks.map(t => {
    const isToday    = t.end_date === today;
    const isOverdue  = t.end_date < today;
    const dotColor   = isOverdue || isToday ? C.red : t.progress >= 75 ? C.green : C.amber;
    const dueBadgeBg = isOverdue ? C.redLight   : isToday ? C.redLight   : C.amberLight;
    const dueBadgeFg = isOverdue ? C.red        : isToday ? C.red        : C.amber;
    const dueLabel   = isOverdue ? 'Overdue'    : isToday ? 'Due Today'  : t.end_date;

    return `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid ${C.border};vertical-align:top;">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                         background:${dotColor};margin-top:5px;flex-shrink:0;"></span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:14px;font-weight:600;color:${C.text};margin-bottom:3px;">${esc(t.name)}</div>
              <div style="font-size:12px;color:${C.muted};">${esc(t.project)}</div>
            </div>
          </div>
        </td>
        <td style="padding:14px 16px;border-bottom:1px solid ${C.border};vertical-align:top;white-space:nowrap;">
          <span style="display:inline-block;background:${dueBadgeBg};color:${dueBadgeFg};
                       font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;">
            ${dueLabel}
          </span>
        </td>
        <td style="padding:14px 16px;border-bottom:1px solid ${C.border};vertical-align:top;">
          <div style="background:#e2e8f0;border-radius:20px;height:5px;width:80px;overflow:hidden;margin-bottom:3px;">
            <div style="background:${t.progress >= 100 ? C.green : C.blue};width:${Math.min(100,t.progress||0)}%;height:100%;border-radius:20px;"></div>
          </div>
          <div style="font-size:11px;color:${C.muted};">${t.progress || 0}%</div>
        </td>
      </tr>`;
  }).join('');

  const body = `
    ${greeting(toName)}

    <p style="margin:0 0 20px;font-size:15px;color:${C.slate};">
      You have <strong style="color:${C.text};">${taskCount} task${taskCount > 1 ? 's' : ''}</strong>
      requiring your attention in the next <strong>3 business days</strong>.
      ${chips ? `<br/><span style="display:inline-block;margin-top:10px;">${chips}</span>` : ''}
    </p>

    <!-- Tasks table -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
      style="border:1.5px solid ${C.border};border-radius:10px;overflow:hidden;margin:0 0 24px;">

      <!-- Table header -->
      <tr style="background:${C.bg};">
        <td style="padding:10px 16px;border-bottom:1px solid ${C.border};">
          <span style="font-size:11px;color:${C.muted};font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">Task</span>
        </td>
        <td style="padding:10px 16px;border-bottom:1px solid ${C.border};">
          <span style="font-size:11px;color:${C.muted};font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">Due</span>
        </td>
        <td style="padding:10px 16px;border-bottom:1px solid ${C.border};">
          <span style="font-size:11px;color:${C.muted};font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">Progress</span>
        </td>
      </tr>

      ${taskRows}
    </table>

    <p style="margin:0 0 4px;font-size:13px;color:${C.muted};line-height:1.6;">
      Update your task progress in the scheduler to keep your project manager informed.
      Tasks marked complete will be removed from future digests.
    </p>

    ${ctaButton('Open My Schedule', 'http://localhost:4003')}

    ${divider()}
    <p style="margin:0;font-size:12px;color:${C.muted};">
      This digest is sent every weekday morning at 8am for tasks due within 3 business days.
    </p>
  `;

  await sendEmail({
    to: toEmail,
    subject: `[SDC Scheduler] ${subject}`,
    html: shell({ preheader: `You have ${taskCount} task${taskCount > 1 ? 's' : ''} due soon — check your schedule`, body }),
    text: tasks.map(t => `• ${t.name} (${t.project}) — Due: ${t.end_date} — ${t.progress}% complete`).join('\n'),
  });
}

module.exports = {
  sendEmail,
  sendTaskAssignmentEmail,
  sendMentionEmail,
  sendDueSoonDigest,
  SMTP_CONFIGURED,
};
