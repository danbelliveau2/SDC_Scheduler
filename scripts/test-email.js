#!/usr/bin/env node
'use strict';
/**
 * test-email.js — prove SMTP actually works before anyone relies on it.
 *
 *   node scripts/test-email.js you@sdcautomation.com
 *
 * The Service module's Work Order delivery and day-before reminders are
 * fire-and-forget by design: if SMTP is misconfigured they fail quietly into a
 * log line, because a Work Order that saved must never be rolled back over a
 * mail server. That is the right behaviour in production and a terrible way to
 * find out your settings are wrong — hence this script, which is deliberately
 * loud about every failure mode.
 *
 * It reads the SAME env vars lib/emailService.js reads, so a pass here means
 * the app will send, not merely that some other mailer would.
 */
require('dotenv').config();

const to = process.argv[2];
if (!to) {
  console.error('\nUsage: node scripts/test-email.js <recipient@example.com>\n');
  process.exit(1);
}

const HOST   = process.env.SMTP_HOST || '';
const PORT   = Number(process.env.SMTP_PORT || 465);
const SECURE = process.env.SMTP_SECURE !== 'false';
const USER   = process.env.SMTP_USER || '';
const FROM   = process.env.SMTP_FROM || 'SDC Scheduler <noreply@sdc.local>';

console.log('\n── SMTP configuration as the app sees it ──');
console.log('  SMTP_HOST   :', HOST || '<UNSET — email is disabled, nothing will ever send>');
console.log('  SMTP_PORT   :', PORT);
console.log('  SMTP_SECURE :', SECURE, SECURE && PORT === 587
  ? '  <-- WARNING: port 587 normally needs SMTP_SECURE=false (STARTTLS)' : '');
console.log('  SMTP_USER   :', USER || '<none — sending unauthenticated (relay connector)>');
console.log('  SMTP_FROM   :', FROM);
console.log('  Recipient   :', to);

if (!HOST) {
  console.error('\nFAIL: SMTP_HOST is not set, so emailService runs in log-only mode.');
  console.error('Work Orders and reminders will be recorded but never delivered.\n');
  process.exit(1);
}

(async () => {
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) { console.error('\nFAIL: nodemailer is not installed —', e.message, '\n'); process.exit(1); }

  const transport = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: SECURE,
    auth: USER ? { user: USER, pass: process.env.SMTP_PASS } : undefined,
  });

  try {
    console.log('\n── Verifying connection ──');
    await transport.verify();
    console.log('  Connection and credentials OK.');
  } catch (e) {
    console.error('\nFAIL at connection/auth:', e.message);
    hint(e);
    process.exit(1);
  }

  try {
    console.log('\n── Sending test message ──');
    const info = await transport.sendMail({
      from: FROM,
      to,
      subject: '[SDC Scheduler] SMTP test',
      text: 'If you are reading this, the Scheduler can send email.\n\n'
          + 'That means Service Work Order notifications and day-before reminders will reach employees.',
      html: '<p>If you are reading this, the Scheduler can send email.</p>'
          + '<p>That means Service Work Order notifications and day-before reminders will reach employees.</p>',
    });
    console.log('  Accepted by server. messageId:', info.messageId);
    if (info.rejected && info.rejected.length) console.log('  REJECTED recipients:', info.rejected);
    console.log('\nPASS — check the inbox (and the junk folder).\n');
    process.exit(0);
  } catch (e) {
    console.error('\nFAIL at send:', e.message);
    hint(e);
    process.exit(1);
  }
})();

/** Turn the usual opaque SMTP errors into the thing to actually go and change. */
function hint(e) {
  const m = String(e && e.message || '').toLowerCase();
  if (m.includes('535') || m.includes('authentication unsuccessful') || m.includes('invalid login')) {
    console.error('\n  Authentication was refused. On Microsoft 365 this is usually SMTP AUTH being');
    console.error('  disabled tenant-wide (the default since 2022) rather than a wrong password.');
    console.error('  Options: have an M365 admin enable SMTP AUTH for this ONE mailbox, or set up an');
    console.error('  Exchange Online relay connector authorised by this server\'s public IP — the');
    console.error('  connector needs no username or password at all (leave SMTP_USER unset).');
  } else if (m.includes('self signed') || m.includes('certificate')) {
    console.error('\n  TLS certificate rejected — check SMTP_SECURE matches the port (465 = true, 587 = false).');
  } else if (m.includes('timeout') || m.includes('econnrefused') || m.includes('enotfound')) {
    console.error('\n  Could not reach the server. Check the hostname, and whether outbound SMTP is');
    console.error('  blocked by the firewall on this machine.');
  } else if (m.includes('5.7.') || m.includes('relay')) {
    console.error('\n  The server accepted the connection but refused to relay. The FROM address');
    console.error('  usually has to be a mailbox the account is allowed to send as.');
  }
}
