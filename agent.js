'use strict';
/**
 * agent.js — local-Ollama, READ-ONLY assistant for the SDC Scheduler.
 *
 * A small tool-using loop: the model (default llama3.1) decides when to call a
 * tool, the server runs it, feeds the result back, and the model answers in
 * plain English. Every tool is read-only:
 *   - run_select / list_tables / describe_table  → scheduler MySQL (SELECT-only,
 *     READ ONLY transaction, row-capped — same guards as the MCP server)
 *   - eto_readiness / eto_vendors / eto_partcost  → Total ETO (read-only bridge)
 * It cannot create, change, or delete anything.
 *
 * Env: OLLAMA_HOST (default http://localhost:11434), OLLAMA_MODEL (default llama3.1).
 * Degrades gracefully: clear errors when Ollama is unreachable or the model isn't pulled.
 */
require('dotenv').config();

const OLLAMA_HOST  = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const MAX_ITERS    = 5;       // tool round-trips before we force a final answer
const ROW_CAP      = 200;     // keep tool results small enough for the model's context

const SYSTEM_PROMPT = `You are the SDC Scheduler assistant for a manufacturing project-scheduling app. Answer the user's question using ONLY data you fetch with the tools provided. You are STRICTLY READ-ONLY — never say you created, changed, or deleted anything.

The scheduler MySQL database has tables including:
- projects: schedules (name, job_number, workspace, status)
- tasks: schedule line items (name, project, phase, department, assignee, start_date, end_date, duration_days, progress, predecessors, is_milestone). The "project" column is the schedule/tab name.
- vendor_pos: purchase orders synced from ETO (po, job, vendor, eta, complete, partial)
- users, team, shop_parts
Use list_tables / describe_table / run_select for these (MySQL syntax).

PROJECT / JOB NAMING — important:
- Project names follow "<jobnumber>_<name>", e.g. "1129_Schneider_Electric_Cartoner". The leading digits ARE the Total ETO job number.
- Users refer to a project loosely — "1129", "project 1129", "PROJECT1129", "the Schneider job".
- ALWAYS call find_project FIRST with the user's words. It fuzzy-matches and returns the exact schedule name, the ETO job number, and a task rollup (count, % complete, overdue). Use its returned job_number for the eto_* tools. Do NOT hand-write project-search SQL or UNIONs.
- Do NOT conclude something "doesn't exist" until find_project returns zero matches.

Build-readiness, BOM parts, no-PO parts, vendor PO status, and materials cost are NOT in the scheduler database — they live in Total ETO. Use eto_readiness(job), eto_vendors(job), eto_partcost(job). "job" is the numeric ETO job number.

When asked to "explain", "summarize", or "tell me about" a project/job: find_project alone gives a solid summary (name, status, task count, % complete, overdue) — answer from it. Only call the slower eto_* tools when the user specifically asks about parts, no-PO items, purchase orders, build readiness, or cost. Fewer tool calls = faster.

CRITICAL output rules:
- To use a tool, use the tool-calling mechanism — NEVER write a tool call, JSON, or "I will now call …" in your reply.
- Your reply to the user is plain prose only. Once you have enough data, just answer.
- Be concise, show the key numbers, and round. If a tool errors or genuinely returns nothing after a reasonable search, say so plainly rather than guessing.`;

const TOOLS = [
  { type: 'function', function: { name: 'find_project', description: 'Resolve a project/job the user mentions (by number, partial name, or loose phrasing like "PROJECT1129" or "the Schneider job") to its exact schedule name + ETO job number, plus a quick task rollup (count, % complete, overdue). ALWAYS use this first when the user names a project or job — do NOT hand-write project-search SQL.', parameters: { type: 'object', properties: { query: { type: 'string', description: "The user's project reference, e.g. '1129', 'PROJECT1129', 'Schneider'" } }, required: ['query'] } } },
  { type: 'function', function: { name: 'list_tables', description: 'List tables in the scheduler database with approximate row counts.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'describe_table', description: 'Show the columns of a scheduler table.', parameters: { type: 'object', properties: { table: { type: 'string', description: 'Table name, e.g. tasks' } }, required: ['table'] } } },
  { type: 'function', function: { name: 'run_select', description: 'Run a single read-only SQL query (SELECT/WITH/EXPLAIN/SHOW/DESCRIBE) against the scheduler database and return rows as JSON.', parameters: { type: 'object', properties: { sql: { type: 'string', description: 'A single read-only SQL statement.' } }, required: ['sql'] } } },
  { type: 'function', function: { name: 'eto_readiness', description: 'Total ETO build readiness for a job: totals (parts, received, noPO, cost, pct), per-assembly summary, and the list of parts with no PO.', parameters: { type: 'object', properties: { job: { type: 'integer', description: 'ETO job number, e.g. 1129' } }, required: ['job'] } } },
  { type: 'function', function: { name: 'eto_vendors', description: 'Total ETO purchase orders for a job, grouped by supplier with received progress and status.', parameters: { type: 'object', properties: { job: { type: 'integer' } }, required: ['job'] } } },
  { type: 'function', function: { name: 'eto_partcost', description: 'Total ETO materials cost summary for a job: estimated, purchased, received, paid, left to pay, ETC.', parameters: { type: 'object', properties: { job: { type: 'integer' } }, required: ['job'] } } },
];

// ── read-only SQL (mirror of the MCP guards) ─────────────────────────────────
function assertReadOnly(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) throw new Error('Empty query.');
  if (s.includes(';')) throw new Error('Only one statement allowed.');
  if (!/^(select|with|explain|show|describe|desc)\b/i.test(s)) throw new Error('Only read-only queries are allowed.');
  return s;
}
async function runReadOnly(pool, sql) {
  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    const [rows] = await conn.query(sql);
    await conn.query('ROLLBACK');
    const arr = Array.isArray(rows) ? rows : [rows];
    return arr.length > ROW_CAP ? { truncatedTo: ROW_CAP, rowCount: arr.length, rows: arr.slice(0, ROW_CAP) } : { rowCount: arr.length, rows: arr };
  } finally { try { await conn.query('ROLLBACK'); } catch (_) {} conn.release(); }
}

// Compact ETO summaries so a big BOM doesn't blow the model's context window.
async function etoReadinessSummary(etoDb, job) {
  const d = await etoDb.getReadiness(job);
  if (!d) return { error: `No ETO specs for job ${job}.` };
  const assemblies = (d.specs || []).flatMap(s => s.assemblies.map(a => ({ pn: a.pn, desc: a.desc, pct: a.stats ? a.stats.pct : null, noPO: a.stats ? a.stats.noPO : null })));
  const noPoParts = (d.partsList || []).filter(p => p.status === 'noPO' && !p.hold).slice(0, 100).map(p => ({ pn: p.pn, desc: p.desc, assembly: p.parentPN, qty: p.qty }));
  return { job: d.job, totals: d.totals, assemblies, noPoParts };
}
async function etoVendorsSummary(etoDb, job) {
  const d = await etoDb.getVendorStatus(job);
  return { job, vendors: (d.vendors || []).map(v => ({ name: v.name, status: v.status, pct: v.pct, poCount: v.poCount, itemCount: v.itemCount })) };
}

// Fuzzy project/job resolver — handles "1129", "PROJECT1129", "Schneider", etc.
// Searches the projects table AND task-tab names, returns canonical names + job
// number + a task rollup. Saves the model from writing brittle lookup SQL.
async function findProject(pool, query) {
  const q = String(query || '');
  const num = (q.match(/\d{2,}/) || [])[0] || null;        // job number if present
  const kw = q.replace(/[^a-z0-9]+/gi, ' ').trim();
  const like = num ? `%${num}%` : `%${kw}%`;
  const [prows] = await pool.query('SELECT name, job_number, status, workspace FROM projects WHERE name LIKE ? OR (job_number IS NOT NULL AND job_number LIKE ?) LIMIT 25', [like, num ? `%${num}%` : like]);
  const [trows] = await pool.query('SELECT DISTINCT project AS name FROM tasks WHERE project LIKE ? LIMIT 25', [like]);
  const names = [...new Set([...prows.map(r => r.name), ...trows.map(r => r.name)])].slice(0, 10);
  const matches = [];
  for (const name of names) {
    const [[agg]] = await pool.query('SELECT COUNT(*) AS taskCount, ROUND(AVG(progress)) AS pctComplete, SUM(end_date < CURDATE() AND COALESCE(progress,0) < 100) AS overdue FROM tasks WHERE project = ?', [name]);
    const prow = prows.find(p => p.name === name);
    matches.push({ name, job_number: prow ? prow.job_number : null, status: prow ? prow.status : null, taskCount: agg.taskCount, pctComplete: agg.pctComplete, overdue: Number(agg.overdue) || 0 });
  }
  return { query, jobNumber: num, matchCount: matches.length, matches };
}

async function execTool(name, args, pool, etoDb) {
  args = args || {};
  switch (name) {
    case 'find_project':
      return findProject(pool, args.query);
    case 'list_tables':
      return runReadOnly(pool, "SELECT table_name AS tableName, table_rows AS approxRows FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name");
    case 'describe_table': {
      const conn = await pool.getConnection();
      try {
        await conn.query('START TRANSACTION READ ONLY');
        const [cols] = await conn.execute('SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_key AS keyType FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position', [String(args.table || '')]);
        await conn.query('ROLLBACK');
        return cols.length ? { table: args.table, columns: cols } : { error: `Table "${args.table}" not found.` };
      } finally { try { await conn.query('ROLLBACK'); } catch (_) {} conn.release(); }
    }
    case 'run_select':
      return runReadOnly(pool, assertReadOnly(args.sql));
    case 'eto_readiness':
      if (!etoDb || !etoDb.CONFIGURED) return { error: 'Total ETO is not configured on this server.' };
      return etoReadinessSummary(etoDb, parseInt(args.job, 10));
    case 'eto_vendors':
      if (!etoDb || !etoDb.CONFIGURED) return { error: 'Total ETO is not configured on this server.' };
      return etoVendorsSummary(etoDb, parseInt(args.job, 10));
    case 'eto_partcost':
      if (!etoDb || !etoDb.CONFIGURED) return { error: 'Total ETO is not configured on this server.' };
      return etoDb.getPartCost(parseInt(args.job, 10));
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function _chat(messages, useTools) {
  // Cap each model turn so a hung/cold Ollama can't wedge the request forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.OLLAMA_TIMEOUT_MS) || 120000);
  let res;
  try {
    res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false, ...(useTools ? { tools: TOOLS } : {}), options: { temperature: 0.2 } }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The model took too long to respond (timed out). Try a simpler question or a smaller model.');
    throw new Error(`Could not reach Ollama at ${OLLAMA_HOST}: ${e.message}`);
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    if (res.status === 404 || /not found|try pulling/i.test(t)) throw new Error(`Model "${OLLAMA_MODEL}" isn't installed. Run: ollama pull ${OLLAMA_MODEL}`);
    throw new Error(`Ollama error (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.message || {};
}

/** Reachability + whether the configured model is pulled. */
async function status() {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { method: 'GET' });
    if (!r.ok) return { reachable: false, model: OLLAMA_MODEL, host: OLLAMA_HOST };
    const data = await r.json();
    const models = (data.models || []).map(m => m.name);
    const hasModel = models.some(n => n === OLLAMA_MODEL || n.startsWith(OLLAMA_MODEL + ':'));
    return { reachable: true, host: OLLAMA_HOST, model: OLLAMA_MODEL, hasModel, models };
  } catch (e) {
    return { reachable: false, host: OLLAMA_HOST, model: OLLAMA_MODEL, error: e.message };
  }
}

const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name));

// Find top-level balanced {...} JSON objects in text → [{ obj, start, end }].
function _jsonObjects(text) {
  const out = [];
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { if (--depth === 0) { try { out.push({ obj: JSON.parse(s.slice(i, j + 1)), start: i, end: j + 1 }); } catch (_) {} i = j; break; } }
    }
  }
  return out;
}
// Small models sometimes EMIT a tool call as text instead of using the tool
// mechanism. Recover those so we run them instead of showing raw JSON.
function _salvageToolCalls(content) {
  const calls = [];
  for (const { obj } of _jsonObjects(content)) {
    const name = obj.name || (obj.function && obj.function.name);
    const args = obj.parameters || obj.arguments || (obj.function && (obj.function.parameters || obj.function.arguments)) || {};
    if (name && TOOL_NAMES.has(name)) calls.push({ function: { name, arguments: args } });
  }
  return calls;
}
// Strip any leaked tool-call JSON + "I'll now call …" narration from the answer.
function _cleanAnswer(content) {
  let s = String(content || '');
  for (const { obj, start, end } of _jsonObjects(s).reverse()) {
    const name = obj.name || (obj.function && obj.function.name);
    if (name && TOOL_NAMES.has(name)) s = s.slice(0, start) + s.slice(end);
  }
  s = s.replace(/^[^\n]*\b(I('| wi)ll now (call|use)|let me (call|use)|now (call|calling)|to (get|gather) (more )?(info|information|data)[^\n]*tools?)[^\n]*$/gim, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** Run the read-only assistant. Returns { answer, tools:[{name,args,ok}] }. */
async function ask({ pool, etoDb, question, context }) {
  if (!question || !String(question).trim()) throw new Error('Ask a question.');
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (context) messages.push({ role: 'system', content: 'Context for this question: ' + context });
  messages.push({ role: 'user', content: String(question) });

  const toolLog = [];
  for (let i = 0; i < MAX_ITERS; i++) {
    const msg = await _chat(messages, true);
    messages.push(msg);
    let calls = msg.tool_calls || [];
    if (!calls.length) {
      // Model may have written the tool call as text — recover and run it.
      const salvaged = _salvageToolCalls(msg.content || '');
      if (salvaged.length) calls = salvaged;
      else { const answer = _cleanAnswer(msg.content) || '(no answer)'; return { answer, tools: toolLog }; }
    }
    for (const tc of calls) {
      const fn = tc.function || {};
      let args = fn.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }
      let result;
      try { result = await execTool(fn.name, args, pool, etoDb); }
      catch (e) { result = { error: e.message }; }
      toolLog.push({ name: fn.name, args, ok: !(result && result.error) });
      messages.push({ role: 'tool', tool_name: fn.name, content: JSON.stringify(result).slice(0, 8000) });
    }
  }
  // Ran out of tool turns — get a final answer with the data already gathered.
  const final = await _chat([...messages, { role: 'user', content: 'Answer now in plain prose for the user using the data gathered above. Do not call tools or output JSON.' }], false);
  return { answer: _cleanAnswer(final.content) || '(no answer — try rephrasing)', tools: toolLog };
}

module.exports = { ask, status, OLLAMA_MODEL, OLLAMA_HOST };
