'use strict';
/**
 * One-time migration for the shared-account project (2026-08-13).
 *
 *   node scripts/link-etc-users.js            # dry run, prints the plan
 *   node scripts/link-etc-users.js --apply    # writes it, prints temp passwords
 *
 * Two things, in order:
 *   1. Links every Scheduler user to their existing Reports account by email
 *      (sets users.reports_user_id) — the 12 people who already have both
 *      today. Nothing is created here; both rows already exist.
 *   2. Creates a new Scheduler user, linked, for each Reports-only person —
 *      a generated temp password (same word-list style as _genTempPassword
 *      in routes/users.js), role='viewer' (the lowest tier; an admin
 *      elevates from Setup > Users same as any new hire), active mirrors
 *      their Reports row.
 *
 * Two Reports-only emails are skipped rather than linked — they read as
 * accidental duplicates of an already-linked account (akamujuu@ vs the real
 * akamuju@, and a personal-gmail test pair), not distinct real people. Listed
 * explicitly below rather than silently dropped; review/delete them on the
 * Reports side if that's right, or tell me if one of them IS real and should
 * be created instead.
 *
 * Uses the existing `root` connection (lib/mysqlDb.js's config), schema-
 * qualifying sdc_etc_planner.User inline — same as backfill-employee-id.js,
 * for the same reason (root already reaches both schemas on this server, so
 * this migration step doesn't depend on the narrower-scoped
 * sdc_scheduler_shared credential routes/auth.js uses at runtime).
 *
 * Companion to sdc-etc-planner/scripts/link-scheduler-users.ts, which does
 * the reverse (creates Reports accounts for Scheduler-only people). The two
 * scripts can run in either order.
 */
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');

// Skipped, not linked — see the file header.
const SKIP_EMAILS = new Set(['akamujuu@sdcautomation.com', 'abhikamuju01@gmail.com']);

const WORDS = ['blue', 'lime', 'gear', 'bolt', 'fast', 'spark', 'steel', 'motor', 'shaft', 'cam', 'weld', 'panel'];
function genTempPassword() {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${Math.floor(10 + Math.random() * 89)}`;
}

function nameFromEmail(email) {
  const local = String(email).trim().split('@')[0] || '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const title = (s) => (s.length > 0 ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
  return (parts.length > 0 ? parts : [local]).map(title).join(' ').trim() || 'New User';
}

function randomAvatarColor() {
  const colors = ['#1574c4', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#dc2626', '#9333ea', '#0d9488'];
  return colors[Math.floor(Math.random() * colors.length)];
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'sdc_scheduler',
  });

  const [schedulerUsers] = await conn.query('SELECT id, email, name, active, reports_user_id FROM users');
  const [reportsUsers] = await conn.query('SELECT id, email, name, active FROM sdc_etc_planner.User');

  const schedulerByEmail = new Map(schedulerUsers.map((u) => [String(u.email).trim().toLowerCase(), u]));

  const toLink = [];
  const toCreate = [];
  const skipped = [];

  for (const r of reportsUsers) {
    const email = String(r.email).trim().toLowerCase();
    const existing = schedulerByEmail.get(email);
    if (existing) {
      if (existing.reports_user_id == null) toLink.push({ schedulerId: existing.id, email, reportsId: r.id });
      continue;
    }
    if (SKIP_EMAILS.has(email)) { skipped.push(email); continue; }
    toCreate.push({ email, name: r.name, active: Boolean(r.active), reportsId: r.id });
  }

  console.log(`${reportsUsers.length} Reports users, ${schedulerUsers.length} Scheduler users.\n`);
  console.log(`${toLink.length} already-existing Scheduler account(s) to link:`);
  for (const l of toLink) console.log(`  ${l.email} -> Reports User#${l.reportsId}`);
  console.log(`\n${toCreate.length} new Scheduler account(s) to create:`);
  for (const c of toCreate) console.log(`  ${c.email} (${c.name}), active=${c.active}`);
  console.log(`\n${skipped.length} skipped (see file header — likely duplicates): ${skipped.join(', ') || '(none)'}`);

  if (!APPLY) {
    console.log('\nDry run only — pass --apply to write these changes.');
    await conn.end();
    return;
  }

  for (const l of toLink) {
    await conn.query('UPDATE users SET reports_user_id = ? WHERE id = ?', [l.reportsId, l.schedulerId]);
  }

  console.log('\nCreating Scheduler accounts — temp passwords below, hand these out directly:\n');
  for (const c of toCreate) {
    const tempPassword = genTempPassword();
    const hash = await bcrypt.hash(tempPassword, 12);
    const [ins] = await conn.query(
      `INSERT INTO users (email, name, password_hash, role, avatar_color, active, reports_user_id) VALUES (?, ?, ?, 'viewer', ?, ?, ?)`,
      [c.email, c.name, hash, randomAvatarColor(), c.active ? 1 : 0, c.reportsId],
    );
    console.log(`  ${c.email}  ->  ${tempPassword}   (Scheduler users id ${ins.insertId})`);
  }

  console.log(`\nWrote ${toLink.length} link(s), created ${toCreate.length} account(s).`);
  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
