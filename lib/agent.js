'use strict';
/**
 * agent.js — Anthropic Claude, READ-ONLY assistant for the SDC Scheduler.
 *
 * Tool-using loop: Claude decides when to call a tool, the server runs it, feeds
 * the result back, and Claude answers in plain English. Every tool is read-only:
 *   - run_select / list_tables / describe_table  → scheduler MySQL (SELECT-only,
 *     READ ONLY transaction, row-capped — same guards as the MCP server)
 *   - find_project / eto_readiness / eto_vendors / eto_partcost  → reads only
 * It cannot create, change, or delete anything.
 *
 * Env:
 *   ANTHROPIC_API_KEY  (required to activate the assistant)
 *   ANTHROPIC_MODEL    (default claude-sonnet-4-6)
 *   ANTHROPIC_MAX_TOKENS  (default 1024)
 * Degrades gracefully: clear error when the key isn't set.
 */
require('dotenv').config();

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { /* SDK optional */ }

const API_KEY    = process.env.ANTHROPIC_API_KEY || '';
const MODEL      = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS) || 1024;
const MAX_ITERS  = 8;       // tool round-trips before forcing a final answer
const ROW_CAP    = 200;     // keep tool results small enough for context
let _client = null;
function _getClient() {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env to activate the assistant.');
  if (!Anthropic) throw new Error('@anthropic-ai/sdk is not installed. Run: npm install @anthropic-ai/sdk');
  if (!_client) {
    const Ctor = Anthropic.Anthropic || Anthropic.default || Anthropic;
    _client = new Ctor({ apiKey: API_KEY });
  }
  return _client;
}

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

// Tools in Claude's format: { name, description, input_schema }.
const TOOLS = [
  { name: 'find_project', description: 'Resolve a project/job the user mentions (by number, partial name, or loose phrasing like "PROJECT1129" or "the Schneider job") to its exact schedule name + ETO job number, plus a quick task rollup (count, % complete, overdue). ALWAYS use this first when the user names a project or job — do NOT hand-write project-search SQL.', input_schema: { type: 'object', properties: { query: { type: 'string', description: "The user's project reference, e.g. '1129', 'PROJECT1129', 'Schneider'" } }, required: ['query'] } },
  { name: 'list_tables', description: 'List tables in the scheduler database with approximate row counts.', input_schema: { type: 'object', properties: {} } },
  { name: 'describe_table', description: 'Show the columns of a scheduler table.', input_schema: { type: 'object', properties: { table: { type: 'string', description: 'Table name, e.g. tasks' } }, required: ['table'] } },
  { name: 'run_select', description: 'Run a single read-only SQL query (SELECT/WITH/EXPLAIN/SHOW/DESCRIBE) against the scheduler database and return rows as JSON.', input_schema: { type: 'object', properties: { sql: { type: 'string', description: 'A single read-only SQL statement.' } }, required: ['sql'] } },
  { name: 'eto_readiness', description: 'Total ETO build readiness for a job: totals (parts, received, noPO, cost, pct), per-assembly summary, and the list of parts with no PO.', input_schema: { type: 'object', properties: { job: { type: 'integer', description: 'ETO job number, e.g. 1129' } }, required: ['job'] } },
  { name: 'eto_vendors', description: 'Total ETO purchase orders for a job, grouped by supplier with received progress and status.', input_schema: { type: 'object', properties: { job: { type: 'integer' } }, required: ['job'] } },
  { name: 'eto_partcost', description: 'Total ETO materials cost summary for a job: estimated, purchased, received, paid, left to pay, ETC.', input_schema: { type: 'object', properties: { job: { type: 'integer' } }, required: ['job'] } },
];

// ── read-only SQL (mirror of the MCP guards) ─────────────────────────────────
// Identifiers that must NEVER come back from a chatbot query, even though they
// could plausibly appear in a SELECT (`SELECT password_hash FROM users` etc.).
// Hashes are bcrypted, but they shouldn't be exposed via a chat tool.
const FORBIDDEN_IDENT = /\b(password_hash|password|api_key|secret|auth_token|access_token|refresh_token|jwt_secret|reset_token|session_token|csrf_token)\b/i;
function assertReadOnly(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) throw new Error('Empty query.');
  if (s.includes(';')) throw new Error('Only one statement allowed.');
  if (!/^(select|with|explain|show|describe|desc)\b/i.test(s)) throw new Error('Only read-only queries are allowed.');
  // `SELECT *` could pull password_hash by accident — disallow on tables that hold secrets.
  if (/\bselect\s+\*\s+from\s+users\b/i.test(s)) throw new Error('SELECT * is not allowed on `users` (use explicit columns; password_hash is blocked).');
  const m = s.match(FORBIDDEN_IDENT);
  if (m) throw new Error(`Query references a sensitive column ("${m[0]}") — blocked.`);
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

/** Reachability for the UI's setup hint. No key → tells the user to set it. */
async function status() {
  return {
    provider: 'anthropic',
    model: MODEL,
    reachable: !!API_KEY,
    hasModel: !!API_KEY,
    ...(API_KEY ? {} : { setup: 'Set ANTHROPIC_API_KEY in .env to activate the assistant.' }),
  };
}

// Collect plain-text chunks from Claude's `content` array (used after the
// final no-more-tools turn, where we expect only text blocks).
function _textOf(content) {
  if (!Array.isArray(content)) return String(content || '').trim();
  return content.filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
}

// Anthropic prompt caching: marking the system prompt + the last tool definition
// with cache_control caches them on the first call; follow-up calls within ~5
// minutes read those tokens at ~10% the price (and faster TTFT). Free, opt-in,
// huge win for a chatbot that hits the same system prompt every turn.
function _systemForCache() {
  return [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
}
function _toolsForCache() {
  // Cache the whole tool list by tagging the last one (cache breakpoints are
  // sticky to the end of the prior chunk).
  const arr = TOOLS.map(t => ({ ...t }));
  arr[arr.length - 1] = { ...arr[arr.length - 1], cache_control: { type: 'ephemeral' } };
  return arr;
}

// Build the Claude messages array from an optional client-supplied history.
// History items are the same shape Claude returns: { role, content }. We accept
// either string or Claude content-block arrays and pass them through.
function _buildMessages(history, context, question) {
  const msgs = Array.isArray(history) ? history.filter(h => h && h.role && h.content != null) : [];
  const userText = (context ? 'Context for this question: ' + context + '\n\n' : '') + String(question);
  msgs.push({ role: 'user', content: userText });
  return msgs;
}

/**
 * Run the read-only assistant (non-streaming).
 * `history` (optional) is an array of prior {role, content} turns for multi-turn.
 * Returns { answer, tools, history, usage }. `history` is the updated array
 * the client should send next turn for continuity.
 */
async function ask({ pool, etoDb, question, context, history }) {
  if (!question || !String(question).trim()) throw new Error('Ask a question.');
  const client = _getClient();
  const messages = _buildMessages(history, context, question);
  try {

  const toolLog = [];
  let lastAssistantText = '';
  let cumUsage = null;
  for (let i = 0; i < MAX_ITERS; i++) {
    const resp = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: _systemForCache(), tools: _toolsForCache(),
      messages,
    });
    if (resp.usage) cumUsage = _sumUsage(cumUsage, resp.usage);
    messages.push({ role: 'assistant', content: resp.content });
    const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
    const textNow = _textOf(resp.content);
    if (textNow) lastAssistantText = textNow;

    if (!toolUses.length || resp.stop_reason !== 'tool_use') {
      return { answer: textNow || lastAssistantText || '(no answer)', tools: toolLog, history: messages, usage: cumUsage };
    }
    const toolResults = [];
    for (const tu of toolUses) {
      let result;
      try { result = await execTool(tu.name, tu.input || {}, pool, etoDb); }
      catch (e) { result = { error: e.message }; }
      toolLog.push({ name: tu.name, args: tu.input || {}, ok: !(result && result.error) });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result).slice(0, 16000),
        ...(result && result.error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  const final = await client.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS, system: _systemForCache(), messages,
  });
  if (final.usage) cumUsage = _sumUsage(cumUsage, final.usage);
  return { answer: _textOf(final.content) || lastAssistantText || '(no answer — try rephrasing)', tools: toolLog, history: messages, usage: cumUsage };
  } catch (e) {
    const msg = e.status ? `API error ${e.status}: ${e.message}` : (e.message || 'Unknown error from Claude');
    throw new Error(msg);
  }
}

// Accumulate usage counters across multiple Claude calls in one /ask request.
function _sumUsage(a, b) {
  const out = a || { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  out.input_tokens += b.input_tokens || 0;
  out.output_tokens += b.output_tokens || 0;
  out.cache_creation_input_tokens += b.cache_creation_input_tokens || 0;
  out.cache_read_input_tokens += b.cache_read_input_tokens || 0;
  return out;
}

/**
 * Streaming variant — calls onEvent({type,...}) as text deltas / tool calls / done
 * arrive, so the UI can render the answer word-by-word. Same read-only guarantees.
 *   onEvent({type:'text_delta', text})
 *   onEvent({type:'tool_start', name, args})
 *   onEvent({type:'tool_done',  name, ok})
 *   onEvent({type:'done', tools, usage, history})
 *   onEvent({type:'error', error})
 */
async function askStream({ pool, etoDb, question, context, history, onEvent }) {
  if (!question || !String(question).trim()) { onEvent({ type: 'error', error: 'Ask a question.' }); return; }
  let client;
  try { client = _getClient(); }
  catch (e) { onEvent({ type: 'error', error: e.message }); return; }
  const messages = _buildMessages(history, context, question);
  const toolLog = [];
  let cumUsage = null;

  try {
    for (let i = 0; i < MAX_ITERS; i++) {
      const stream = client.messages.stream({
        model: MODEL, max_tokens: MAX_TOKENS,
        system: _systemForCache(), tools: _toolsForCache(),
        messages,
      });
      stream.on('text', (delta) => { if (delta) onEvent({ type: 'text_delta', text: delta }); });
      const final = await stream.finalMessage();
      if (final.usage) cumUsage = _sumUsage(cumUsage, final.usage);
      messages.push({ role: 'assistant', content: final.content });
      const toolUses = (final.content || []).filter(b => b.type === 'tool_use');
      if (!toolUses.length || final.stop_reason !== 'tool_use') {
        onEvent({ type: 'done', tools: toolLog, usage: cumUsage, history: messages });
        return;
      }
      const toolResults = [];
      for (const tu of toolUses) {
        onEvent({ type: 'tool_start', name: tu.name, args: tu.input || {} });
        let result;
        try { result = await execTool(tu.name, tu.input || {}, pool, etoDb); }
        catch (e) { result = { error: e.message }; }
        toolLog.push({ name: tu.name, args: tu.input || {}, ok: !(result && result.error) });
        onEvent({ type: 'tool_done', name: tu.name, ok: !(result && result.error) });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result).slice(0, 16000),
          ...(result && result.error ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    onEvent({ type: 'done', tools: toolLog, usage: cumUsage, history: messages });
  } catch (e) {
    // 401 = bad key. 429 = rate limit. Surface a clear message.
    const msg = (e && e.status === 401) ? 'The ANTHROPIC_API_KEY was rejected. Check the key in .env and restart.'
      : (e && e.status === 429) ? 'Rate-limited by Anthropic — wait a moment and try again.'
      : (e && e.message) || String(e);
    onEvent({ type: 'error', error: msg });
  }
}

// ── Vision: read an SDC "Project Budget" table image into structured hours ───
// Used by the Project Release panel to auto-fill the quoted-hours grid from the
// budget picture embedded in the release .docx. Returns a flat object of
// numbers (or null where a cell is blank/unreadable) — never invents values.
const BUDGET_EXTRACT_PROMPT = `This image is an SDC "Project Budget" table. It has a "Design and Build" section with columns ME, CE (Design and Drawings, Software), General Engineering (HMI, Robot, Vision, Database and Device), and Shop (Mechanical Build, Electrical Build); a "Testing" section with Eng (ME & CE) and Shop (MB & EB); a "Teardown and Install" section with Eng (ME & CE) and Shop (MB & EB); and a "Parts Cost" column.

Read the number in each cell. Return ONLY a JSON object (no prose, no code fence) with these exact keys, using whole numbers for hours and a number for parts_cost (strip $ and commas). If a cell is blank, dashed, or you cannot read it confidently, use null — never guess:
{"me":,"ce_design_drawings":,"ce_software":,"hmi":,"robot":,"vision":,"database_device":,"mechanical_build":,"electrical_build":,"testing_eng":,"testing_shop":,"teardown_install_eng":,"teardown_install_shop":,"parts_cost":}`;

async function extractBudgetImage({ image, mediaType } = {}) {
  if (!image) throw new Error('No image provided.');
  const client = _getClient();
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/png', data: image } },
        { type: 'text', text: BUDGET_EXTRACT_PROMPT },
      ],
    }],
  });
  const text = (msg.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Vision response had no JSON.');
  let budget;
  try { budget = JSON.parse(m[0]); } catch (e) { throw new Error('Could not parse vision JSON.'); }
  return { budget };
}

module.exports = { ask, askStream, status, MODEL, extractBudgetImage };
