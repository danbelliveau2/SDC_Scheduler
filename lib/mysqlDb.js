/**
 * mysqlDb.js — MySQL connection pools for the SDC Scheduler.
 *
 * Environment variables:
 *   MYSQL_HOST      (default: localhost)
 *   MYSQL_PORT      (default: 3306)
 *   MYSQL_USER      (default: root)
 *   MYSQL_PASSWORD
 *   MYSQL_DATABASE  (default: sdc_scheduler)
 *
 *   ETC_SHARED_DATABASE_URL   (mysql://sdc_scheduler_shared:...@127.0.0.1:3306/sdc_etc_planner)
 *     Read/write access to ETC Planner's `Employee` table only — the shared
 *     source of truth for the 7 delivery-team groupings (2026-08-13). A
 *     dedicated, least-privilege user, not the `root` credential above (which
 *     has full access to this app's own database, unrelated to ETC's).
 *     Unset by default: everything using `getEtcPool()` fails soft until this
 *     is deliberately configured, same pattern ETC's own scheduler-db.ts uses
 *     in the reverse direction.
 */

const mysql = require('mysql2/promise');

let _pool = null;

function getPool() {
  if (!_pool) {
    _pool = mysql.createPool({
      host:               process.env.MYSQL_HOST     || 'localhost',
      port:               Number(process.env.MYSQL_PORT) || 3306,
      user:               process.env.MYSQL_USER     || 'root',
      password:           process.env.MYSQL_PASSWORD || '',
      database:           process.env.MYSQL_DATABASE || 'sdc_scheduler',
      waitForConnections: true,
      connectionLimit:    10,
      timezone:           'Z',
      decimalNumbers:     true,
    });
  }
  return _pool;
}

async function query(sql, params = []) {
  const pool = getPool();
  return pool.execute(sql, params);
}

async function testConnection() {
  const [rows] = await query('SELECT VERSION() AS v');
  return rows[0].v;
}

let _etcPool = null;

function isEtcSharedConfigured() {
  return Boolean(process.env.ETC_SHARED_DATABASE_URL);
}

function getEtcPool() {
  if (!isEtcSharedConfigured()) {
    throw new Error('ETC_SHARED_DATABASE_URL is not set — the shared Employee table is not reachable.');
  }
  if (!_etcPool) {
    _etcPool = mysql.createPool({
      uri:                process.env.ETC_SHARED_DATABASE_URL,
      waitForConnections: true,
      connectionLimit:    5,
      timezone:           'Z',
      decimalNumbers:     true,
    });
  }
  return _etcPool;
}

async function etcQuery(sql, params = []) {
  const pool = getEtcPool();
  return pool.execute(sql, params);
}

const pool = getPool();

module.exports = { pool, getPool, query, testConnection, isEtcSharedConfigured, getEtcPool, etcQuery };
