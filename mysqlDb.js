/**
 * mysqlDb.js — MySQL connection pool for the SDC Scheduler.
 *
 * Environment variables:
 *   MYSQL_HOST      (default: localhost)
 *   MYSQL_PORT      (default: 3306)
 *   MYSQL_USER      (default: root)
 *   MYSQL_PASSWORD
 *   MYSQL_DATABASE  (default: sdc_scheduler)
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

const pool = getPool();

module.exports = { pool, getPool, query, testConnection };
