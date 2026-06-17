/**
 * SDC Scheduler DB — DXT (Claude Desktop) stdio MCP server.
 *
 * Self-contained, READ-ONLY. Claude Desktop launches this over stdio and injects
 * the MySQL connection via env (mapped from the extension's user_config). Same
 * read-only guarantees as the HTTP server:
 *   - only SELECT / WITH / EXPLAIN / SHOW / DESCRIBE
 *   - every query runs inside START TRANSACTION READ ONLY … ROLLBACK
 *   - single statement only; results row-capped
 */
import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');

const DB_NAME = process.env.MYSQL_DATABASE || 'sdc_scheduler';
const ROW_CAP_DEFAULT = 1000;
const ROW_CAP_MAX = 5000;

const pool = mysql.createPool({
  host:               process.env.MYSQL_HOST     || 'localhost',
  port:               Number(process.env.MYSQL_PORT) || 3306,
  user:               process.env.MYSQL_USER     || 'root',
  password:           process.env.MYSQL_PASSWORD || '',
  database:           DB_NAME,
  waitForConnections: true,
  connectionLimit:    5,
  timezone:           'Z',
  decimalNumbers:     true,
});

function assertReadOnly(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) throw new Error('Empty query.');
  if (s.includes(';')) throw new Error('Multiple statements are not allowed — send a single read-only query.');
  if (!/^(select|with|explain|show|describe|desc)\b/i.test(s)) {
    throw new Error('Only read-only queries are allowed (SELECT, WITH, EXPLAIN, SHOW, DESCRIBE).');
  }
  return s;
}

async function runReadOnly(sql, limit) {
  const cap = Math.min(Math.max(1, Number(limit) || ROW_CAP_DEFAULT), ROW_CAP_MAX);
  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    const [rows, fields] = await conn.query(sql);
    await conn.query('ROLLBACK');
    const arr = Array.isArray(rows) ? rows : [rows];
    const truncated = arr.length > cap;
    return { rowCount: arr.length, truncated, rows: truncated ? arr.slice(0, cap) : arr, columns: Array.isArray(fields) ? fields.map(f => f.name) : undefined };
  } finally { try { await conn.query('ROLLBACK'); } catch (_) {} conn.release(); }
}

const ok = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const fail = (m) => ({ content: [{ type: 'text', text: 'Error: ' + m }], isError: true });

const server = new McpServer({ name: 'sdc-scheduler-db', version: '1.0.0' });

server.registerTool('list_tables', {
  title: 'List tables',
  description: 'List all tables in the SDC Scheduler database with their approximate row counts.',
  inputSchema: {},
}, async () => {
  try {
    const r = await runReadOnly(`SELECT table_name AS tableName, table_rows AS approxRows FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`, 500);
    return ok({ database: DB_NAME, tables: r.rows });
  } catch (e) { return fail(e.message); }
});

server.registerTool('describe_table', {
  title: 'Describe table',
  description: 'Show the columns (name, type, nullability, key, default) for one table.',
  inputSchema: { table: z.string().describe('Table name, e.g. "tasks", "projects", "users", "vendor_pos"') },
}, async ({ table }) => {
  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    const [cols] = await conn.execute(
      `SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_key AS keyType, column_default AS \`default\`, extra
       FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`, [table]);
    await conn.query('ROLLBACK');
    if (!cols.length) return fail(`Table "${table}" not found in this database.`);
    return ok({ table, columns: cols });
  } catch (e) { return fail(e.message); }
  finally { try { await conn.query('ROLLBACK'); } catch (_) {} conn.release(); }
});

server.registerTool('run_select', {
  title: 'Run a read-only query',
  description: 'Run a single read-only SQL query (SELECT/WITH/EXPLAIN/SHOW/DESCRIBE) and return rows as JSON. Writes and DDL are rejected. Results are capped (default 1000 rows).',
  inputSchema: {
    sql: z.string().describe('A single read-only SQL statement. No trailing semicolon needed.'),
    limit: z.number().int().positive().max(ROW_CAP_MAX).optional().describe(`Max rows (default ${ROW_CAP_DEFAULT}, max ${ROW_CAP_MAX}).`),
  },
}, async ({ sql, limit }) => {
  try {
    const r = await runReadOnly(assertReadOnly(sql), limit);
    return ok({ rowCount: r.rowCount, ...(r.truncated ? { note: `Truncated to ${r.rows.length} of ${r.rowCount} rows.` } : {}), columns: r.columns, rows: r.rows });
  } catch (e) { return fail(e.message); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stdio servers must not write to stdout (it's the protocol channel); log to stderr.
console.error(`[sdc-db-dxt] read-only MCP server ready (db=${DB_NAME})`);
