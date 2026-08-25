'use strict';
/**
 * serviceNotify.js — Work Order delivery for the Service module (R2 §8, §9).
 *
 * Two things get sent to an assigned employee:
 *   • sendWorkOrder()         — when the Work Order is generated (§8, required)
 *   • sendWorkOrderReminder() — the day before a future Task Date (§9)
 *
 * DEDUPE. Both go through emailService's _sendOnce path via notification_log's
 * UNIQUE reference_key, which is exactly the "prevent duplicate reminder
 * notifications" requirement in §9 — a reminder key is per (work order, date),
 * so a cron tick that runs twice, or a server that restarts mid-sweep, cannot
 * double-send. The work_orders table ALSO stamps notified_at / reminder_sent_at;
 * that is the belt to this suspenders, and it is what the UI reads. Neither
 * alone is trusted.
 *
 * TEAMS (§8, "preferred if technically available"). SDC has no Graph client in
 * this codebase, so Teams here is an Incoming Webhook: set TEAMS_WEBHOOK_URL and
 * every Work Order notification also posts a card to that channel. Unset (the
 * default) makes it a silent no-op. This deliberately does NOT block or fail the
 * email path — §8 says Teams must not hold up the implementation.
 *
 * Every function is fire-and-forget: a Work Order that saved must never be
 * rolled back because SMTP was down. Failures are logged and the *_sent_at
 * stamp is simply left null, so the next reminder sweep retries it.
 */

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || '';

const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const URGENCY_LABELS = {
  machine_down:    'MACHINE DOWN',
  urgent_running:  'Urgent — machine running',
  schedule:        'Not urgent — schedule',
  quote_mod:       'Modification quote requested',
};

function urgencyLabel(u) { return URGENCY_LABELS[u] || u || '—'; }

/**
 * Shared body for both the initial notification and the reminder — an employee
 * should not have to cross-reference two differently-shaped emails for the same
 * job. `wo` is a work order row already joined to its parent request (see
 * routes/service.js's woWithParent()).
 */
function workOrderLines(wo) {
  return [
    ['Service Request', wo.request_no],
    ['Work Order',      wo.wo_no],
    ['Date',            wo.task_date || 'TBD'],
    ['Customer',        wo.company_name],
    ['Job / Machine',   [wo.job_number, wo.machine_serial].filter(Boolean).join(' / ') || '—'],
    // Worth its own line rather than a footnote: on a non-SDC machine the
    // technician has no build history, no drawings and no spares to draw on,
    // and that changes what they take with them.
    ['Machine',         wo.machine_type === 'non_sdc' ? 'NOT an SDC machine' : wo.machine_type === 'sdc' ? 'SDC-built' : ''],
    ['Urgency',         urgencyLabel(wo.urgency)],
    ['On-site/Remote',  wo.location_type === 'onsite' ? 'ON-SITE' : wo.location_type === 'remote' ? 'Remote' : '—'],
    ['Location',        wo.onsite_address],
    ['Budgeted hours',  wo.budgeted_hours != null ? String(wo.budgeted_hours) : '—'],
    ['PPE required',    wo.ppe_requirements],
    ['Requestor',       [wo.requestor_name, wo.requestor_phone, wo.requestor_email].filter(Boolean).join(' · ')],
    ['SDC contact',     [wo.sdc_contact_name, wo.sdc_contact_phone, wo.sdc_contact_email].filter(Boolean).join(' · ')],
  ].filter(([, v]) => v != null && String(v).trim() !== '');
}

function renderHtml(heading, wo, noteHtml) {
  const rows = workOrderLines(wo).map(([k, v]) =>
    `<tr><td style="padding:3px 10px 3px 0;color:#64748b;white-space:nowrap;vertical-align:top">${esc(k)}</td>
         <td style="padding:3px 0;color:#0f172a"><strong>${esc(v)}</strong></td></tr>`).join('');
  const down = wo.urgency === 'machine_down'
    ? `<p style="margin:0 0 12px;padding:8px 10px;background:#fee2e2;border-left:4px solid #dc2626;color:#7f1d1d;font-weight:700">MACHINE DOWN — customer is not running.</p>`
    : '';
  return `
    <div style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#0f172a">
      <h2 style="margin:0 0 4px;font-size:17px">${esc(heading)}</h2>
      ${noteHtml || ''}
      ${down}
      <table style="border-collapse:collapse;margin:10px 0 14px">${rows}</table>
      <p style="margin:0 0 6px;color:#64748b">Task description</p>
      <div style="padding:8px 10px;background:#f1f5f9;border-radius:4px;white-space:pre-wrap">${esc(wo.task_description) || '—'}</div>
      <p style="margin:16px 0 0">
        <a href="${APP_URL}/?view=service&wo=${wo.id}"
           style="background:#1574c4;color:#fff;padding:9px 16px;border-radius:4px;text-decoration:none;font-weight:600">
          Open Work Order
        </a>
      </p>
      <p style="margin:10px 0 0;color:#94a3b8;font-size:12px">
        Mark it complete from that screen when the work is done — that is what generates the Service Report.
      </p>
    </div>`;
}

function renderText(heading, wo) {
  const lines = workOrderLines(wo).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `${heading}\n\n${lines}\n\nTask description:\n${wo.task_description || '—'}\n\n${APP_URL}/?view=service&wo=${wo.id}`;
}

// ── Teams (optional, never blocking) ─────────────────────────────────────────
async function postToTeams(heading, wo) {
  if (!TEAMS_WEBHOOK_URL) return { sent: false, reason: 'teams_disabled' };
  try {
    const facts = workOrderLines(wo).map(([k, v]) => ({ name: k, value: String(v) }));
    const card = {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      themeColor: wo.urgency === 'machine_down' ? 'DC2626' : '1574C4',
      summary: heading,
      title: heading,
      sections: [{ facts, text: String(wo.task_description || '').slice(0, 1500) }],
      potentialAction: [{
        '@type': 'OpenUri',
        name: 'Open Work Order',
        targets: [{ os: 'default', uri: `${APP_URL}/?view=service&wo=${wo.id}` }],
      }],
    };
    // Node 18+ global fetch. Timeout so a hung webhook can't wedge the caller.
    const res = await fetch(TEAMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`webhook returned ${res.status}`);
    return { sent: true };
  } catch (e) {
    console.warn('[service] Teams post failed (non-fatal):', e.message);
    return { sent: false, reason: e.message };
  }
}

/**
 * sendWorkOrder — §8. Fires once when a Work Order is generated. Callers pass
 * `resend: true` to deliberately re-deliver (the "Resend" button), which salts
 * the reference key so the dedupe check doesn't swallow an intentional resend.
 */
// server.js substitutes a stub emailSvc if lib/emailService.js fails to load,
// so never assume _sendOnce is there — Teams (or nothing) still works.
const canEmail = (emailSvc) => !!(emailSvc && typeof emailSvc._sendOnce === 'function');

async function sendWorkOrder({ pool, emailSvc, wo, resend = false }) {
  const heading = `Service Work Order ${wo.wo_no} — ${wo.company_name || 'SDC customer'}`;
  const results = {};
  if (wo.employee_email && canEmail(emailSvc)) {
    results.email = await emailSvc._sendOnce(pool, {
      to: wo.employee_email,
      subject: `[SDC Service] ${wo.wo_no} — ${wo.task_date || 'date TBD'} — ${wo.company_name || ''}`.trim(),
      html: renderHtml(heading, wo, `<p style="margin:0 0 10px">You have been assigned this Service Work Order.</p>`),
      text: renderText(heading, wo),
      referenceKey: `service-wo:${wo.id}${resend ? ':resend:' + Date.now() : ''}`,
      type: 'service_work_order',
    });
  } else {
    results.email = { sent: false, reason: wo.employee_email ? 'email_unavailable' : 'no_employee_email' };
  }
  results.teams = await postToTeams(heading, wo);
  return results;
}

/**
 * sendWorkOrderReminder — §9. One reminder, the day before the Task Date. The
 * reference key carries the task_date so a WO that gets RESCHEDULED to a new
 * future date correctly earns a fresh reminder instead of being suppressed as a
 * duplicate of the one already sent for the old date.
 */
async function sendWorkOrderReminder({ pool, emailSvc, wo }) {
  const heading = `Reminder: Service Work Order ${wo.wo_no} is tomorrow`;
  const note = `<p style="margin:0 0 10px">This Work Order is scheduled for <strong>tomorrow, ${esc(wo.task_date)}</strong>.</p>`;
  const results = {};
  if (wo.employee_email && canEmail(emailSvc)) {
    results.email = await emailSvc._sendOnce(pool, {
      to: wo.employee_email,
      subject: `[SDC Service] Tomorrow: ${wo.wo_no} — ${wo.company_name || ''}`.trim(),
      html: renderHtml(heading, wo, note),
      text: renderText(heading, wo),
      referenceKey: `service-wo-reminder:${wo.id}:${wo.task_date}`,
      type: 'service_wo_reminder',
    });
  } else {
    results.email = { sent: false, reason: wo.employee_email ? 'email_unavailable' : 'no_employee_email' };
  }
  results.teams = await postToTeams(heading, wo);
  return results;
}

module.exports = { sendWorkOrder, sendWorkOrderReminder, urgencyLabel, TEAMS_ENABLED: !!TEAMS_WEBHOOK_URL };
