/**
 * sdc-db-server.mjs — read-only MCP server for the SDC Scheduler database.
 *
 * Exposes the scheduler MySQL database (and the read-only Total ETO bridge) to
 * MCP clients over Streamable HTTP. READ-ONLY by design:
 *   - only SELECT / WITH / EXPLAIN / SHOW / DESCRIBE are accepted
 *   - every query runs inside a `START TRANSACTION READ ONLY` … `ROLLBACK`
 *   - mysql2 runs single statements only (no stacked `;` statements)
 *   - results are row-capped
 * So an MCP client (or a bad prompt) cannot mutate or wipe data.
 *
 * Network-exposed → a bearer token is REQUIRED. Set MCP_TOKEN in .env; the
 * server refuses to start without it. Clients send  Authorization: Bearer <token>.
 *
 * Env:
 *   MCP_TOKEN   (required)  shared secret clients must present
 *   MCP_PORT    (default 4100)
 *   MCP_HOST    (default 0.0.0.0)
 *   plus the usual MYSQL_* and ETO_* vars (reused from the app).
 *
 * Run:  node mcp/sdc-db-server.mjs      (or: npm run mcp)
 */
import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const require = createRequire(import.meta.url);
require('dotenv').config();                 // load .env before the pool is built
const express = require('express');
const mysql = require('mysql2/promise');
let etoDb = null;
try { etoDb = require('../etoDb'); } catch (_) { /* ETO bridge optional */ }

// Dedicated pool so the MCP server targets the PRODUCTION database (sdc_scheduler)
// regardless of which DB the app's .env (MYSQL_DATABASE) points at on this box —
// e.g. the dev app server uses sdc_scheduler_dev, but this MCP reads production.
// Override any field with MCP_MYSQL_*; host/user/password fall back to the app's
// MYSQL_* so you usually only set MCP_MYSQL_DATABASE (or nothing — it defaults to
// the production database name).
const MCP_DB = process.env.MCP_MYSQL_DATABASE || 'sdc_scheduler';
const pool = mysql.createPool({
  host:               process.env.MCP_MYSQL_HOST     || process.env.MYSQL_HOST     || 'localhost',
  port:               Number(process.env.MCP_MYSQL_PORT || process.env.MYSQL_PORT) || 3306,
  user:               process.env.MCP_MYSQL_USER     || process.env.MYSQL_USER     || 'root',
  password:           process.env.MCP_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || '',
  database:           MCP_DB,
  waitForConnections: true,
  connectionLimit:    5,
  timezone:           'Z',
  decimalNumbers:     true,
});

const MCP_TOKEN = process.env.MCP_TOKEN || '';
const MCP_PORT  = Number(process.env.MCP_PORT) || 4100;
const MCP_HOST  = process.env.MCP_HOST || '0.0.0.0';
const ROW_CAP_DEFAULT = 1000;
const ROW_CAP_MAX = 5000;

if (!MCP_TOKEN) {
  console.error('[mcp] Refusing to start: MCP_TOKEN is not set. This server exposes the database over the network, so a bearer token is required. Set MCP_TOKEN in .env.');
  process.exit(1);
}

// ── read-only query helpers ──────────────────────────────────────────────────
function assertReadOnly(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) throw new Error('Empty query.');
  if (s.includes(';')) throw new Error('Multiple statements are not allowed — send a single read-only query.');
  if (!/^(select|with|explain|show|describe|desc)\b/i.test(s)) {
    throw new Error('Only read-only queries are allowed (SELECT, WITH, EXPLAIN, SHOW, DESCRIBE).');
  }
  return s;
}

// Run a query inside a READ ONLY transaction so writes are impossible even if a
// statement somehow tried. Returns { rows, fields, truncated, rowCount }.
async function runReadOnly(sql, limit) {
  const cap = Math.min(Math.max(1, Number(limit) || ROW_CAP_DEFAULT), ROW_CAP_MAX);
  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    const [rows, fields] = await conn.query(sql);
    await conn.query('ROLLBACK');
    const arr = Array.isArray(rows) ? rows : [rows];
    const truncated = arr.length > cap;
    return {
      rowCount: arr.length,
      truncated,
      rows: truncated ? arr.slice(0, cap) : arr,
      columns: Array.isArray(fields) ? fields.map(f => f.name) : undefined,
    };
  } finally {
    try { await conn.query('ROLLBACK'); } catch (_) {}
    conn.release();
  }
}

const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: 'Error: ' + msg }], isError: true });

// ── build a fresh MCP server (stateless: one per request) ────────────────────
function buildServer() {
  const server = new McpServer({ name: 'sdc-scheduler-db', version: '1.0.0' });

  server.registerTool('list_tables', {
    title: 'List tables',
    description: 'List all tables in the SDC Scheduler database with their approximate row counts.',
    inputSchema: {},
  }, async () => {
    try {
      const r = await runReadOnly(
        `SELECT table_name AS tableName, table_rows AS approxRows
         FROM information_schema.tables
         WHERE table_schema = DATABASE() ORDER BY table_name`, 500);
      return ok({ database: MCP_DB, tables: r.rows });
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('describe_table', {
    title: 'Describe table',
    description: 'Show the columns (name, type, nullability, key, default) for one table.',
    inputSchema: { table: z.string().describe('Table name, e.g. "tasks", "projects", "users", "vendor_pos"') },
  }, async ({ table }) => {
    try {
      const conn = await pool.getConnection();
      try {
        await conn.query('START TRANSACTION READ ONLY');
        const [cols] = await conn.execute(
          `SELECT column_name AS name, column_type AS type, is_nullable AS nullable,
                  column_key AS keyType, column_default AS \`default\`, extra
           FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ?
           ORDER BY ordinal_position`, [table]);
        await conn.query('ROLLBACK');
        if (!cols.length) return fail(`Table "${table}" not found in this database.`);
        return ok({ table, columns: cols });
      } finally { try { await conn.query('ROLLBACK'); } catch (_) {} conn.release(); }
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('run_select', {
    title: 'Run a read-only query',
    description: 'Run a single read-only SQL query (SELECT/WITH/EXPLAIN/SHOW/DESCRIBE) against the scheduler database and return the rows as JSON. Writes and DDL are rejected. Results are capped (default 1000 rows).',
    inputSchema: {
      sql: z.string().describe('A single read-only SQL statement. No trailing semicolon needed.'),
      limit: z.number().int().positive().max(ROW_CAP_MAX).optional().describe(`Max rows to return (default ${ROW_CAP_DEFAULT}, max ${ROW_CAP_MAX}).`),
    },
  }, async ({ sql, limit }) => {
    try {
      const safe = assertReadOnly(sql);
      const r = await runReadOnly(safe, limit);
      return ok({
        rowCount: r.rowCount,
        ...(r.truncated ? { note: `Result truncated to ${r.rows.length} of ${r.rowCount} rows. Add a tighter WHERE/LIMIT or raise the limit (max ${ROW_CAP_MAX}).` } : {}),
        columns: r.columns,
        rows: r.rows,
      });
    } catch (e) { return fail(e.message); }
  });

  // ── Total ETO (read-only ERP bridge) — optional, only if configured ──────────
  const etoOn = etoDb && etoDb.CONFIGURED;
  const jobShape = { job: z.coerce.number().int().positive().describe('Total ETO job / ProjectID, e.g. 1129') };

  server.registerTool('eto_status', {
    title: 'Total ETO status',
    description: 'Whether the Total ETO ERP bridge is configured and reachable from this server.',
    inputSchema: {},
  }, async () => {
    if (!etoOn) return ok({ configured: false, connected: false });
    try { await etoDb.ping(); return ok({ configured: true, connected: true }); }
    catch (e) { return ok({ configured: true, connected: false, error: e.message }); }
  });

  if (etoOn) {
    server.registerTool('eto_project', {
      title: 'ETO project info', description: 'Look up a Total ETO project name/ID by job number.', inputSchema: jobShape,
    }, async ({ job }) => { try { const d = await etoDb.getProjectInfo(job); return d ? ok(d) : fail(`Job ${job} not found in Total ETO.`); } catch (e) { return fail(e.message); } });

    server.registerTool('eto_readiness', {
      title: 'ETO build readiness', description: 'BOM build-readiness for a job: specs/assemblies with received/ordered/no-PO rollups, flat parts list, and totals.', inputSchema: jobShape,
    }, async ({ job }) => { try { const d = await etoDb.getReadiness(job); return d ? ok({ job: d.job, totals: d.totals, specCount: (d.specs || []).length, partCount: (d.partsList || []).length, specs: d.specs }) : fail(`No ETO specs for job ${job}.`); } catch (e) { return fail(e.message); } });

    server.registerTool('eto_vendors', {
      title: 'ETO vendor status', description: 'Purchase orders for a job grouped by supplier, with received progress and status.', inputSchema: jobShape,
    }, async ({ job }) => { try { return ok(await etoDb.getVendorStatus(job)); } catch (e) { return fail(e.message); } });

    server.registerTool('eto_partcost', {
      title: 'ETO part cost', description: 'Materials cost summary for a job: estimated / purchased / received / paid / left-to-pay / ETC.', inputSchema: jobShape,
    }, async ({ job }) => { try { return ok(await etoDb.getPartCost(job)); } catch (e) { return fail(e.message); } });
  }

  return server;
}

// ── HTTP (Streamable HTTP transport) ─────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

// Public liveness probe (no auth) so deploys/monitors can check it's up.
app.get('/health', async (_req, res) => {
  let db = false;
  try { const c = await pool.getConnection(); await c.query('SELECT 1'); c.release(); db = true; } catch (_) {}
  res.json({ ok: true, server: 'sdc-scheduler-db-mcp', database: MCP_DB, db, eto: !!(etoDb && etoDb.CONFIGURED) });
});

// Bearer-token gate for the MCP endpoint.
function requireToken(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers['x-mcp-token'] || '');
  if (tok !== MCP_TOKEN) {
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized — send Authorization: Bearer <MCP_TOKEN>.' }, id: null });
  }
  next();
}

// Stateless: a fresh server+transport per request. Simple and safe for read-only.
app.post('/mcp', requireToken, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { try { transport.close(); } catch (_) {} try { server.close(); } catch (_) {} });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error: ' + e.message }, id: null });
  }
});

// Stateless mode doesn't use long-lived GET/DELETE streams.
const methodNotAllowed = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.listen(MCP_PORT, MCP_HOST, () => {
  console.log(`[mcp] SDC Scheduler DB MCP server (read-only) on http://${MCP_HOST}:${MCP_PORT}/mcp`);
  console.log(`[mcp] Database: ${MCP_DB} · Auth: bearer token required · Total ETO bridge: ${etoDb && etoDb.CONFIGURED ? 'configured' : 'off'}.`);
});

process.on('uncaughtException', (e) => console.error('[mcp] uncaughtException:', e.message));
process.on('unhandledRejection', (e) => console.error('[mcp] unhandledRejection:', e && e.message));
