'use strict';
// uat-cleanup.js — remove all rows created by UAT runs (_UAT_* projects, test users, probe settings)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool } = require('../mysqlDb');
(async () => {
  const [r1] = await pool.query("DELETE FROM tasks WHERE project LIKE '\\_UAT\\_%'");
  const [r2] = await pool.query("DELETE FROM users WHERE email LIKE 'uat-sec-%@sdc-test.com' OR email = 'uat-dup-check@sdc-test.com'");
  const [r3] = await pool.query("DELETE FROM settings WHERE `key` = 'uat_probe_key' OR `key` LIKE 'project\\_quote:\\_UAT\\_%'");
  console.log('cleaned — tasks:', r1.affectedRows, '| users:', r2.affectedRows, '| settings:', r3.affectedRows);
  await pool.end();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
