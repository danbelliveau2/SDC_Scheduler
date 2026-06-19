'use strict';
/**
 * emailService.js — Phase 7 mention + digest emails.
 *
 * Disabled when SMTP_HOST is empty (default). When configured, sends:
 *   • sendMentionEmail({ to, taskName, project, commentBody, authorName })
 *     — fires when a @mention lands in a new comment
 *   • sendDigest({ to, items })
 *     — daily/weekly summary of pending actions for a user
 *
 * Idempotency: every send checks notification_log first to avoid double-
 * delivery on the same (user_email, reference_key) pair.
 *
 * Errors are swallowed: a flaky SMTP server should never break the schedule
 * API. Failed sends just leave the notification_log row absent so the next
 * trigger can retry.
 */
require('dotenv').config();
const SMTP_HOST = process.env.SMTP_HOST || '';
const ENABLED   = !!SMTP_HOST;

let _transport = null;
function _getTransport() {
  if (!ENABLED) return null;
  if (_transport) return _transport;
  try {
    const nodemailer = require('nodemailer');
    _transport = nodemailer.createTransport({
      host:   SMTP_HOST,
      port:   Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE !== 'false',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  } catch (e) {
    console.warn('[email] nodemailer not installed:', e.message);
  }
  return _transport;
}

const FROM = process.env.SMTP_FROM || 'SDC Scheduler <noreply@sdc.local>';

// `pool` is the mysql2/promise pool. Dedup + log-only writes go through it
// (the old SQLite db.prepare API was a migration leftover that silently broke
// every send under MySQL). Tolerant of a missing pool so callers can't crash.
async function _sendOnce(pool, { to, subject, html, text, referenceKey, type }) {
  const logIgnore = async () => {
    if (!pool) return;
    try {
      await pool.query('INSERT IGNORE INTO notification_log (user_email, type, reference_key) VALUES (?, ?, ?)', [to, type, referenceKey]);
    } catch (_) {}
  };
  if (!ENABLED) {
    // Log-only mode — record the event even when SMTP isn't configured.
    await logIgnore();
    return { sent: false, reason: 'smtp_disabled' };
  }
  // Dedupe — skip if we already sent this exact (user, key) pair.
  if (pool) {
    try {
      const [rows] = await pool.query('SELECT id FROM notification_log WHERE reference_key = ? AND user_email = ?', [referenceKey, to]);
      if (rows.length) return { sent: false, reason: 'duplicate' };
    } catch (_) {}
  }

  const t = _getTransport();
  if (!t) return { sent: false, reason: 'no_transport' };
  try {
    await t.sendMail({ from: FROM, to, subject, html, text });
    await logIgnore();
    return { sent: true };
  } catch (e) {
    console.warn('[email] send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

async function sendMentionEmail({ pool, to, taskId, taskName, project, commentBody, authorName }) {
  if (!to) return;
  const safeName = (s) => String(s || '').replace(/[<>]/g, '');
  const url     = process.env.APP_URL || 'http://localhost:3000';
  const subject = `[SDC Scheduler] ${safeName(authorName)} mentioned you on "${safeName(taskName)}"`;
  const html    = `
    <p><strong>${safeName(authorName)}</strong> mentioned you in a comment on
       <strong>${safeName(taskName)}</strong> (${safeName(project)}).</p>
    <blockquote style="border-left:3px solid #1574c4;padding-left:8px;color:#334155;">
      ${safeName(commentBody).replace(/\n/g, '<br>')}
    </blockquote>
    <p><a href="${url}">Open scheduler</a></p>
  `;
  const text = `${safeName(authorName)} mentioned you on "${safeName(taskName)}":\n\n${safeName(commentBody)}\n\n${url}`;
  const refKey = `mention:${taskId}:${Date.now()}`;
  return _sendOnce(pool, { to, subject, html, text, referenceKey: refKey, type: 'mention' });
}

async function sendDigest({ pool, to, items }) {
  if (!to || !Array.isArray(items) || items.length === 0) return;
  const lines = items.map(i => `• ${i.name} — due ${i.end_date || i.due_date || 'tbd'}`).join('\n');
  const html  = `
    <p>Your open items in SDC Scheduler:</p>
    <ul>${items.map(i => `<li>${(i.name || '').replace(/[<>]/g, '')} — due ${i.end_date || i.due_date || 'tbd'}</li>`).join('')}</ul>
  `;
  const refKey = `digest:${to}:${new Date().toISOString().slice(0, 10)}`;
  return _sendOnce(pool, {
    to,
    subject: `[SDC Scheduler] Your ${items.length} open item${items.length > 1 ? 's' : ''}`,
    html,
    text: `Your open items:\n\n${lines}`,
    referenceKey: refKey,
    type: 'digest',
  });
}

/**
 * sendAlert — fire-and-forget ops alert (backup failed, DB unreachable, etc.).
 * Deliberately bypasses notification_log/dedupe so it has no DB dependency and
 * works even if the DB is the thing that's down. No-op when SMTP is disabled.
 */
async function sendAlert({ to, subject, text }) {
  if (!ENABLED || !to) return { sent: false, reason: 'disabled' };
  const t = _getTransport();
  if (!t) return { sent: false, reason: 'no_transport' };
  try {
    await t.sendMail({ from: FROM, to, subject, text, html: `<pre style="font:13px monospace">${String(text || '').replace(/[<>]/g, '')}</pre>` });
    return { sent: true };
  } catch (e) {
    console.warn('[email] alert failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

module.exports = { ENABLED, sendMentionEmail, sendDigest, sendAlert };
