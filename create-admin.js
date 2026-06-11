'use strict';
/**
 * create-admin.js — CLI tool to create or update an admin user in MySQL.
 *
 * Usage:
 *   node create-admin.js [email] [password] [role]
 *
 * Defaults:
 *   email    = akamuju@sdcautomation.com
 *   password = sdc_secure_password
 *   role     = admin
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./mysqlDb');

async function main() {
  const email    = process.argv[2] || 'akamuju@sdcautomation.com';
  const password = process.argv[3] || 'sdc_secure_password';
  const role     = process.argv[4] || 'admin';

  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (email, name, password_hash, role)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role)`,
    [email, email.split('@')[0], hash, role]
  );
  console.log(`User ${email} (${role}) created/updated.`);
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
