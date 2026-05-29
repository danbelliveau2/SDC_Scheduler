#!/usr/bin/env node
'use strict';
/**
 * create-admin.js — Seed or update an admin user in the SDC Scheduler database.
 *
 * Usage:
 *   node create-admin.js --email dan@sdcautomation.com --name "Dan Belliveau" --password "yourpass"
 *   node create-admin.js --email someone@example.com --name "Someone" --password "pw" --role editor
 *
 * Run this once after setting AUTH_ENABLED=true in .env to create the first
 * login. Idempotent — re-running with the same email updates name/password/
 * role on the existing row.
 */

const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const email    = get('--email');
const name     = get('--name');
const password = get('--password');
const role     = get('--role') || 'admin';

if (!email || !name || !password) {
  console.error('Usage: node create-admin.js --email <email> --name "<full name>" --password "<password>" [--role admin|editor|viewer]');
  process.exit(1);
}

if (!['admin', 'editor', 'viewer'].includes(role)) {
  console.error('Invalid role. Must be admin, editor, or viewer.');
  process.exit(1);
}

const bcrypt = require('bcryptjs');
const db     = require('./db');

const hash = bcrypt.hashSync(password, 12);

db.prepare(`
  INSERT INTO users (email, name, password_hash, role, active)
  VALUES (?, ?, ?, ?, 1)
  ON CONFLICT(email) DO UPDATE SET
    name          = excluded.name,
    password_hash = excluded.password_hash,
    role          = excluded.role,
    active        = 1
`).run(email, name, hash, role);

console.log(`User "${name}" <${email}> upserted with role "${role}".`);
console.log('Set AUTH_ENABLED=true in .env, then restart the server to require login.');
