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

async function _sendOnce(db, { to, subject, html, text, referenceKey, type }) {
  if (!ENABLED) {
    // Log-only mode — write the row to notification_log so the audit trail
    // still records the event even when SMTP isn't configured.
    try {
      db.prepare(`
        INSERT OR IGNORE INTO notification_log (user_email, type, reference_key)
        VALUES (?, ?, ?)
      `).run(to, type, referenceKey);
    } catch (_) {}
    return { sent: false, reason: 'smtp_disabled' };
  }
  // Dedupe — skip if we already sent this exact (user, key) pair.
  try {
    const existing = db.prepare('SELECT id FROM notification_log WHERE reference_key = ? AND user_email = ?').get(referenceKey, to);
    if (existing) return { sent: false, reason: 'duplicate' };
  } catch (_) {}

  const t = _getTransport();
  if (!t) return { sent: false, reason: 'no_transport' };
  try {
    await t.sendMail({ from: FROM, to, subject, html, text });
    try {
      db.prepare(`
        INSERT INTO notification_log (user_email, type, reference_key)
        VALUES (?, ?, ?)
      `).run(to, type, referenceKey);
    } catch (_) {}
    return { sent: true };
  } catch (e) {
    console.warn('[email] send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

async function sendMentionEmail({ db, to, taskId, taskName, project, commentBody, authorName }) {
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
  return _sendOnce(db, { to, subject, html, text, referenceKey: refKey, type: 'mention' });
}

async function sendDigest({ db, to, items }) {
  if (!to || !Array.isArray(items) || items.length === 0) return;
  const lines = items.map(i => `• ${i.name} — due ${i.end_date || i.due_date || 'tbd'}`).join('\n');
  const html  = `
    <p>Your open items in SDC Scheduler:</p>
    <ul>${items.map(i => `<li>${(i.name || '').replace(/[<>]/g, '')} — due ${i.end_date || i.due_date || 'tbd'}</li>`).join('')}</ul>
  `;
  const refKey = `digest:${to}:${new Date().toISOString().slice(0, 10)}`;
  return _sendOnce(db, {
    to,
    subject: `[SDC Scheduler] Your ${items.length} open item${items.length > 1 ? 's' : ''}`,
    html,
    text: `Your open items:\n\n${lines}`,
    referenceKey: refKey,
    type: 'digest',
  });
}

module.exports = { ENABLED, sendMentionEmail, sendDigest };
