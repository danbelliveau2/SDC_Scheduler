/**
 * hoursApi.js — Power BI semantic model bridge (read-only).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEFAULT_EXE = path.join(
  'D:\\AI Projects\\Centrailized library\\SDC-PowerBI-DEV',
  'mcp-server\\publish\\win-x64-new\\sdc-powerbi-mcp.exe'
);
const EXE = process.env.PBI_MCP_EXE || DEFAULT_EXE;
const CACHE_TTL = 5 * 60 * 1000;
const _cache = {};

let _proc = null;
let _buf = '';
let _ready = false;
let _pending = new Map();
let _nextId = 10;

function _log(...args) { console.log('[hoursApi]', ...args); }
function _err(...args) { console.error('[hoursApi]', ...args); }

function _send(obj) {
  if (!_proc) return;
  _proc.stdin.write(JSON.stringify(obj) + '\n');
}

function _startProc() {
  if (_proc) return;
  _log('spawning PBI exe...');

  _proc = spawn(EXE, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  _proc.stdout.on('data', chunk => {
    _buf += chunk.toString();
    const lines = _buf.split('\n');
    _buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }

      if (msg.id === 1 && msg.result && !_ready) {
        _log('handshake complete, exe ready');
        _send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        _ready = true;
        // Flush queued calls
        for (const [id, entry] of _pending) {
          if (entry.dax) {
            _log(`flushing queued query id=${id}`);
            _send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'run_dax', arguments: { dax: entry.dax } } });
          }
        }
        // Warmup — verify token is valid right after boot so the first user request is fast.
        _runDax('EVALUATE ROW("ok", 1)').then(() => _log('warmup ping OK')).catch(e => _log('warmup ping failed:', e.message));
      } else if (msg.id && _pending.has(msg.id)) {
        const { resolve, reject, timer } = _pending.get(msg.id);
        _pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) { _err('DAX error:', msg.error.message); return reject(new Error(msg.error.message)); }
        if (msg.result?.isError) { _err('DAX isError:', msg.result?.content?.[0]?.text); return reject(new Error(msg.result?.content?.[0]?.text || 'DAX error')); }
        const text = msg.result?.content?.[0]?.text || '[]';
        _log('got DAX result, length:', text.length);
        try { resolve(JSON.parse(text)); }
        catch (_) { reject(new Error('PBI: bad JSON — ' + text.slice(0, 200))); }
      }
    }
  });

  _proc.stderr.on('data', d => {
    // Log ALL stderr so we can diagnose hangs
    _log('exe stderr:', d.toString().trim().slice(0, 400));
  });

  _proc.on('error', err => {
    _err('spawn error:', err.message);
    _proc = null; _ready = false; _buf = '';
    for (const { reject, timer } of _pending.values()) { clearTimeout(timer); reject(new Error('PBI spawn error: ' + err.message)); }
    _pending.clear();
  });

  _proc.on('exit', code => {
    _log('exe exited, code:', code);
    for (const { reject, timer } of _pending.values()) { clearTimeout(timer); reject(new Error('PBI process exited')); }
    _pending.clear();
    _proc = null; _ready = false; _buf = '';
    // Restart after 5s
    setTimeout(_startProc, 5000);
  });

  _log('sending initialize...');
  _send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sdc-scheduler', version: '1.0' },
  }});
}

function _runDax(dax) {
  return new Promise((resolve, reject) => {
    if (!_proc) _startProc();
    const id = _nextId++;
    _log(`queuing DAX query id=${id}, ready=${_ready}`);

    const timer = setTimeout(() => {
      _pending.delete(id);
      _err(`query id=${id} timed out after 60s`);
      reject(new Error('PBI query timed out after 60s — check server console for exe stderr'));
    }, 60_000);

    _pending.set(id, { resolve, reject, timer, dax });

    if (_ready) {
      _log(`sending DAX query id=${id} immediately`);
      _send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'run_dax', arguments: { dax } } });
    }
  });
}

function _col(row, name) {
  for (const k of Object.keys(row)) {
    if (k === name || k.endsWith(`[${name}]`)) return row[k];
  }
  return null;
}

// Parse a job_number string like "1130" or "1130&1143" into a list of IDs.
function _parseJobIds(raw) {
  return String(raw).split(/[&,\/\s]+/).map(s => s.replace(/[^0-9a-zA-Z_-]/g, '')).filter(Boolean);
}

async function getJobHours(jobId) {
  const ids = _parseJobIds(jobId);
  if (!ids.length) throw new Error('No valid job ID provided');

  // Sorted join so "1130&1143" and "1143&1130" share the same cache entry.
  const key = ids.slice().sort().join('_');
  const hit = _cache[key];
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  // Single ID uses =, multiple IDs use IN {…} — PBI dataset covers all jobs.
  const jobFilter = ids.length === 1
    ? `'Job'[Job Id] = "${ids[0]}"`
    : `'Job'[Job Id] IN {${ids.map(id => `"${id}"`).join(', ')}}`;

  const dax = [
    `EVALUATE`,
    `CALCULATETABLE(`,
    `  SUMMARIZECOLUMNS(`,
    `    'Function Hierarchy'[Section Name],`,
    `    'Function Hierarchy'[Section Function Group],`,
    `    'Function Hierarchy'[Section Function Name],`,
    `    'Function Hierarchy'[Billing Group],`,
    `    'Function Hierarchy'[Section Function Order],`,
    `    'Function Hierarchy'[Section Order],`,
    `    "HoursQuoted", [Hours Quoted],`,
    `    "HoursActual", [Hours Actual],`,
    `    "HoursETC", [Hours Estimated to Complete]`,
    `  ),`,
    `  'Function Hierarchy'[Is Total] = FALSE,`,
    `  ${jobFilter}`,
    `)`,
    `ORDER BY [Section Order], [Section Function Order]`,
  ].join('\n');

  const rows = await _runDax(dax);

  const fns = rows.map(r => ({
    section: _col(r, 'Section Name')           || '',
    group:   _col(r, 'Section Function Group') || '',
    fn:      _col(r, 'Section Function Name')  || '',
    billing: _col(r, 'Billing Group')          || 'Other',
    order:   _col(r, 'Section Function Order') || 0,
    quoted:  _col(r, 'HoursQuoted')            || 0,
    actual:  _col(r, 'HoursActual')            || 0,
    etc:     _col(r, 'HoursETC')               || 0,
  })).filter(r => r.fn);

  const bgTotals = {};
  for (const r of fns) {
    if (!bgTotals[r.billing]) bgTotals[r.billing] = { quoted: 0, actual: 0, etc: 0 };
    bgTotals[r.billing].quoted += r.quoted;
    bgTotals[r.billing].actual += r.actual;
    bgTotals[r.billing].etc   += r.etc;
  }
  const totals = fns.reduce((a, r) => { a.quoted += r.quoted; a.actual += r.actual; a.etc += r.etc; return a; }, { quoted: 0, actual: 0, etc: 0 });

  const data = { fns, bgTotals, totals, jobIds: ids };
  _cache[key] = { ts: Date.now(), data };
  return data;
}

// Returns { ok, error } — used by the status endpoint to proactively catch token expiry.
async function checkStatus() {
  try {
    await _runDax('EVALUATE ROW("ok", 1)');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const ENABLED = fs.existsSync(EXE);
if (ENABLED) _startProc();

module.exports = { getJobHours, checkStatus, ENABLED };
