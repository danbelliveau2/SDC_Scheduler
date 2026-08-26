/**
 * hoursApi.js — Power BI semantic model bridge (read-only).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// __dirname = SDC_Scheduler/lib — exe is two levels up in sibling SDC-PowerBI-DEV folder
const DEFAULT_EXE = path.join(
  __dirname, '..', '..', 'SDC-PowerBI-DEV',
  'mcp-server', 'publish', 'win-x64', 'sdc-powerbi-mcp.exe'
);
const EXE = process.env.PBI_MCP_EXE || DEFAULT_EXE;
const STALE_TTL  = 10 * 60 * 1000;  // serve fresh if < 10 min old
const DISK_TTL   = 24 * 60 * 60 * 1000; // re-query if disk file > 24 h old

// Timeouts: interactive user requests give up fast; background warmup/cron can wait longer.
const INTERACTIVE_TIMEOUT = 30_000;
const BG_TIMEOUT          = 120_000;
// After this many CONSECUTIVE timeouts we treat the exe as wedged (e.g. it can't
// acquire a Power BI token under the service account, so every query hangs) —
// kill it for a fresh restart and fast-fail new requests until a probe succeeds.
const MAX_TIMEOUTS = 2;

// ── Respawn control (2026-08-26) ────────────────────────────────────────────
// The exe used to be respawned unconditionally 5s after every exit, forever.
// Combined with _consecErrors never being reset on respawn, that produced a
// permanent tight loop the moment the Power BI token went bad: measured 46,956
// 'DAX isError' lines and 18,611 exe restarts in one day — roughly one spawn
// every 4 seconds, sustained for the 46 days since the token cache emptied on
// 2026-07-11. Nobody noticed, because a loop that logs is indistinguishable
// from a service that is merely busy.
//
// The cause of a token expiring is not something this file can fix (MSAL needs
// an interactive `sdc-powerbi-mcp login`). What it CAN do is stop pretending a
// retry will help. After MAX_SPAWN_FAILURES consecutive failed boots it goes
// DORMANT: no more respawns, _unhealthyMsg stays set so requests fast-fail with
// a useful message, and a slow probe re-checks occasionally so the service heals
// itself as soon as someone does log in.
const SPAWN_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000]; // 5s, 15s, 1m, 5m
const MAX_SPAWN_FAILURES = 4;      // then stop and go dormant
const DORMANT_PROBE_MS = 20 * 60 * 1000; // re-check every 20 min while dormant

// Persistent disk cache directory — survives server restarts
const CACHE_DIR = path.join(__dirname, '.pbi-cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function _diskPath(key) { return path.join(CACHE_DIR, key.replace(/[^a-z0-9_-]/gi, '_') + '.json'); }

function _diskRead(key) {
  try {
    const p = _diskPath(key);
    if (!fs.existsSync(p)) return null;
    const { ts, data } = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ts, data };
  } catch (_) { return null; }
}

function _diskWrite(key, data) {
  try { fs.writeFileSync(_diskPath(key), JSON.stringify({ ts: Date.now(), data })); } catch (_) {}
}

const _memCache = {}; // in-memory: { ts, data }

let _proc = null;
let _buf = '';
let _ready = false;
let _pending = new Map();
let _nextId = 10;
let _consecErrors = 0;
let _consecTimeouts = 0;
let _unhealthyMsg = null; // non-null string => exe is wedged; fast-fail interactive requests
let _keepaliveTimer = null; // 20-min PBI dataset ping; one per live _proc, cleared on exit
// Respawn state. _spawnTimer is the single source of truth for "a respawn is
// already scheduled" — without it, _runDax spawning on !_proc raced the pending
// timer and stacked exes (two full spawn/fail cycles inside one second).
let _spawnFailures = 0;
let _spawnTimer = null;
let _dormant = false;
let _lastBootOk = null;

function _log(...args) { console.log('[hoursApi]', ...args); }
function _err(...args) { console.error('[hoursApi]', ...args); }

function _send(obj) {
  const p = _proc;
  // Don't write to a dead/killed child. After a kill() the 'exit' handler may not
  // have fired yet (so _proc is still set) but the pipe is already broken — writing
  // to it throws/emits EPIPE|EOF. Guard on the stream state and swallow any error so
  // a broken PBI pipe can NEVER take down the whole scheduler process.
  if (!p || !p.stdin || !p.stdin.writable || p.stdin.destroyed) return;
  try {
    p.stdin.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    _err('stdin write failed (ignored):', e.message);
  }
}

function _startProc() {
  if (_proc) return;
  // A respawn already queued, or we've given up — either way, do not spawn.
  // This guard is what stops _runDax's `if (!_proc) _startProc()` from racing
  // the pending backoff timer and stacking exes.
  if (_spawnTimer || _dormant) return;
  _log('spawning PBI exe...');

  // A fresh boot deserves a fresh verdict: without this the error counter kept
  // climbing across restarts, so once it passed 3 every future warmup failure
  // killed the new exe instantly and the loop could never break out.
  _consecErrors = 0;
  _consecTimeouts = 0;

  _proc = spawn(EXE, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    // Without this the exe opens a console window on the desktop of whichever
    // session the server runs in. It went unnoticed while PM2 lived in session 0
    // (no desktop to draw on); once PM2 was moved back to an interactive logon
    // — which the ETC app's DPAPI token cache requires — the window started
    // popping up in front of whoever is logged on. stdio is fully piped here,
    // so the console was never doing anything useful.
    windowsHide: true,
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
        // Warmup — verify the token is valid right after boot so the first user
        // request is fast (and so an unhealthy flag clears as soon as auth is fixed).
        _runDax('EVALUATE ROW("ok", 1)', INTERACTIVE_TIMEOUT).then(() => _log('warmup ping OK')).catch(e => _log('warmup ping failed:', e.message));
        // Keep the Power BI dataset hot — ping every 20 min to prevent capacity eviction.
        // Cleared on 'exit' below so a wedged-exe restart loop can't stack intervals.
        clearInterval(_keepaliveTimer);
        _keepaliveTimer = setInterval(() => { if (_ready) _runDax('EVALUATE ROW("ok", 1)', INTERACTIVE_TIMEOUT).catch(() => {}); }, 20 * 60 * 1000);
      } else if (msg.id && _pending.has(msg.id)) {
        const { resolve, reject, timer } = _pending.get(msg.id);
        _pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) {
          _err('DAX error:', msg.error.message);
          if (++_consecErrors >= 3) { _err('3 consecutive DAX errors — restarting PBI exe'); _proc?.kill(); }
          return reject(new Error(msg.error.message));
        }
        if (msg.result?.isError) {
          _err('DAX isError:', msg.result?.content?.[0]?.text);
          if (++_consecErrors >= 3) { _err('3 consecutive DAX errors — restarting PBI exe'); _proc?.kill(); }
          return reject(new Error(msg.result?.content?.[0]?.text || 'DAX error'));
        }
        // A successful result means the exe is healthy again — clear all failure state.
        _consecErrors = 0; _consecTimeouts = 0;
        // This boot works — reset the respawn streak and leave dormancy behind.
        _lastBootOk = true; _spawnFailures = 0; _dormant = false;
        if (_unhealthyMsg) { _log('PBI recovered — clearing unhealthy flag'); _unhealthyMsg = null; }
        const text = msg.result?.content?.[0]?.text || '[]';
        _log('got DAX result, length:', text.length);
        try { resolve(JSON.parse(text)); }
        catch (_) { reject(new Error('PBI: bad JSON — ' + text.slice(0, 200))); }
      }
    }
  });

  // EPIPE/EOF on a broken stdin pipe is emitted ASYNCHRONOUSLY as an 'error' event.
  // Without this listener Node escalates it to an uncaught exception and the whole
  // scheduler exits (this was the cause of the sdc-scheduler crash-loop / "Process 6
  // not found" on `pm2 restart all`). Swallow it — the 'exit' handler does recovery.
  _proc.stdin.on('error', err => {
    _err('stdin pipe error (ignored):', err.message);
  });

  _proc.stderr.on('data', d => {
    // Log ALL stderr so we can diagnose hangs
    _log('exe stderr:', d.toString().trim().slice(0, 400));
  });

  _proc.on('error', err => {
    _err('spawn error:', err.message);
    clearInterval(_keepaliveTimer); _keepaliveTimer = null;
    _proc = null; _ready = false; _buf = '';
    for (const { reject, timer } of _pending.values()) { clearTimeout(timer); reject(new Error('PBI spawn error: ' + err.message)); }
    _pending.clear();
  });

  _proc.on('exit', code => {
    for (const { reject, timer } of _pending.values()) { clearTimeout(timer); reject(new Error('PBI process exited')); }
    _pending.clear();
    clearInterval(_keepaliveTimer); _keepaliveTimer = null;
    _proc = null; _ready = false; _buf = '';

    // A boot that produced at least one good query counts as healthy, so a
    // long-running exe that dies once starts again from the short backoff
    // instead of inheriting an old failure streak.
    if (_lastBootOk) { _spawnFailures = 0; _lastBootOk = null; }
    else _spawnFailures++;

    if (_spawnFailures >= MAX_SPAWN_FAILURES) {
      // Give up actively retrying. This is the whole point of the change: a
      // token this process cannot renew will not be fixed by spawning again,
      // and hammering it buried the real error under ~47k log lines a day.
      if (!_dormant) {
        _dormant = true;
        _unhealthyMsg = _unhealthyMsg ||
          'Power BI hours are unavailable — the sign-in on the server has expired. ' +
          'Run `sdc-powerbi-mcp login` with PBI_CACHE_PATH set to refresh it.';
        // ONE line per state change, not one per attempt.
        _err(`exe failed ${_spawnFailures} consecutive boots — going dormant. ` +
             `Fix: set PBI_CACHE_PATH=<path> && sdc-powerbi-mcp login. ` +
             `Will re-probe every ${DORMANT_PROBE_MS / 60000} min.`);
        _spawnTimer = setTimeout(() => {
          // Leave dormancy just long enough for one honest attempt. If it fails
          // the exit handler lands back here and we wait another interval.
          _spawnTimer = null; _dormant = false; _spawnFailures = MAX_SPAWN_FAILURES - 1;
          _log('dormant probe — retrying PBI exe');
          _startProc();
        }, DORMANT_PROBE_MS);
        _spawnTimer.unref?.();
      }
      return;
    }

    const wait = SPAWN_BACKOFF_MS[Math.min(_spawnFailures, SPAWN_BACKOFF_MS.length - 1)];
    _log(`exe exited (code ${code}); retry ${_spawnFailures}/${MAX_SPAWN_FAILURES} in ${wait / 1000}s`);
    _spawnTimer = setTimeout(() => { _spawnTimer = null; _startProc(); }, wait);
    _spawnTimer.unref?.();
  });

  _log('sending initialize...');
  _send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sdc-scheduler', version: '1.0' },
  }});
}

function _runDax(dax, timeoutMs = BG_TIMEOUT) {
  return new Promise((resolve, reject) => {
    // Dormant means we already know the exe cannot serve this. Queuing the
    // query would park the caller for the full 30s/120s timeout and then fail
    // anyway, so answer now with something a human can act on. The dormant
    // probe is what brings the service back, not this request.
    if (_dormant) return reject(new Error(_unhealthyMsg || 'Power BI is unavailable.'));
    if (!_proc) _startProc();
    const id = _nextId++;
    _log(`queuing DAX query id=${id}, ready=${_ready}`);

    const timer = setTimeout(() => {
      _pending.delete(id);
      const secs = Math.round(timeoutMs / 1000);
      _err(`query id=${id} timed out after ${secs}s`);
      // A timeout is just as fatal as an error response, but the original code
      // never counted it — so a wedged exe (e.g. can't get a token) was hammered
      // with 120s queries forever and never restarted. Count it and, past the
      // threshold, mark unhealthy + kill for a clean restart.
      if (++_consecTimeouts >= MAX_TIMEOUTS) {
        _unhealthyMsg = 'Power BI hours are temporarily unavailable — the sign-in on the server needs to be refreshed.';
        _err(`${_consecTimeouts} consecutive timeouts — marking PBI unhealthy and restarting exe`);
        _consecTimeouts = 0;
        try { _proc?.kill(); } catch (_) {}
      }
      reject(new Error('PBI query timed out after ' + secs + 's — check server console for exe stderr'));
    }, timeoutMs);

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

function _cacheGet(key) {
  // 1. memory hit (freshest)
  const mem = _memCache[key];
  if (mem && Date.now() - mem.ts < STALE_TTL) return { data: mem.data, stale: false };
  // 2. disk hit — serve immediately; stale only if older than STALE_TTL
  const disk = _diskRead(key);
  if (disk) {
    _memCache[key] = disk; // promote to memory
    const stale = Date.now() - disk.ts > STALE_TTL;
    return { data: disk.data, stale };
  }
  return null;
}

function _cacheSet(key, data) {
  _memCache[key] = { ts: Date.now(), data };
  _diskWrite(key, data);
  // Evict oldest entries if memory cache grows too large
  const keys = Object.keys(_memCache);
  if (keys.length > 200) {
    keys.sort((a, b) => _memCache[a].ts - _memCache[b].ts).slice(0, keys.length - 200).forEach(k => delete _memCache[k]);
  }
}

async function getJobHours(jobId) {
  const ids = _parseJobIds(jobId);
  if (!ids.length) throw new Error('No valid job ID provided');

  const key = 'job_' + ids.slice().sort().join('_');
  const hit = _cacheGet(key);
  if (hit && !hit.stale) return hit.data;
  if (hit && hit.stale) {
    _fetchJobHours(ids, key).catch(() => {});
    return hit.data;
  }

  // No cache + exe is wedged → fail fast with a clear message instead of making
  // the user wait out a full query timeout for something that won't return.
  if (_unhealthyMsg) throw new Error(_unhealthyMsg);

  // No combined cache — try merging individual entries warmed by getJobHoursBatch
  if (ids.length > 1) {
    const parts = ids.map(id => _cacheGet('job_' + id)).filter(Boolean);
    if (parts.length === ids.length) {
      const allFns = parts.flatMap(p => p.data.fns);
      const bgTotals = {};
      for (const r of allFns) {
        if (!bgTotals[r.billing]) bgTotals[r.billing] = { quoted: 0, actual: 0, etc: 0 };
        bgTotals[r.billing].quoted += r.quoted;
        bgTotals[r.billing].actual += r.actual;
        bgTotals[r.billing].etc   += r.etc;
      }
      const totals = allFns.reduce((a, r) => { a.quoted += r.quoted; a.actual += r.actual; a.etc += r.etc; return a; }, { quoted: 0, actual: 0, etc: 0 });
      const merged = { fns: allFns, bgTotals, totals, jobIds: ids };
      _cacheSet(key, merged);
      const allFresh = parts.every(p => !p.stale);
      if (!allFresh) _fetchJobHours(ids, key).catch(() => {});
      return merged;
    }
  }

  // No cache at all — fetch fresh and wait
  return _fetchJobHours(ids, key);
}

async function _fetchJobHours(ids, key) {
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

  const rows = await _runDax(dax, INTERACTIVE_TIMEOUT);
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
  _cacheSet(key, data);
  return data;
}

async function getJobsList() {
  const key = 'jobs_list';
  const hit = _cacheGet(key);
  if (hit && !hit.stale) return hit.data;
  if (hit && hit.stale) {
    _fetchJobsList(key).catch(() => {});
    return hit.data;
  }
  if (_unhealthyMsg) throw new Error(_unhealthyMsg);
  return _fetchJobsList(key);
}

async function _fetchJobsList(key) {
  const dax = [
    `EVALUATE`,
    `SUMMARIZECOLUMNS(`,
    `  'Job'[Job Id],`,
    `  'Job'[Job Name],`,
    `  'Job'[Job Status]`,
    `)`,
    `ORDER BY 'Job'[Job Status], 'Job'[Job Name]`,
  ].join('\n');

  const rows = await _runDax(dax, INTERACTIVE_TIMEOUT);
  const jobs = rows.map(r => ({
    id:     _col(r, 'Job Id')     || '',
    name:   _col(r, 'Job Name')   || '',
    status: _col(r, 'Job Status') || '',
  })).filter(j => j.id);
  _cacheSet(key, jobs);
  return jobs;
}

// Fetch hours for ALL jobs in one DAX query. Returns a map: jobId → {fns, bgTotals, totals}.
// Use this for bulk cache warming — far faster than N sequential per-job calls.
async function getJobHoursBatch() {
  const dax = [
    `EVALUATE`,
    `SUMMARIZECOLUMNS(`,
    `  'Job'[Job Id],`,
    `  'Function Hierarchy'[Section Name],`,
    `  'Function Hierarchy'[Section Function Group],`,
    `  'Function Hierarchy'[Section Function Name],`,
    `  'Function Hierarchy'[Billing Group],`,
    `  'Function Hierarchy'[Section Function Order],`,
    `  'Function Hierarchy'[Section Order],`,
    `  FILTER(ALL('Function Hierarchy'), 'Function Hierarchy'[Is Total] = FALSE),`,
    `  "HoursQuoted", [Hours Quoted],`,
    `  "HoursActual", [Hours Actual],`,
    `  "HoursETC", [Hours Estimated to Complete]`,
    `)`,
    `ORDER BY [Job Id], [Section Order], [Section Function Order]`,
  ].join('\n');

  const rows = await _runDax(dax);
  const byJob = {};
  for (const r of rows) {
    const jobId = _col(r, 'Job Id') || '';
    if (!jobId) continue;
    if (!byJob[jobId]) byJob[jobId] = [];
    byJob[jobId].push(r);
  }

  const results = {};
  for (const [jobId, jobRows] of Object.entries(byJob)) {
    const fns = jobRows.map(r => ({
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
    const data = { fns, bgTotals, totals, jobIds: [jobId] };
    const key = 'job_' + jobId;
    _cacheSet(key, data);
    results[jobId] = data;
  }
  return results;
}

// Returns { ok, error, dormant, spawnFailures } — used by the status endpoint to
// proactively catch token expiry. `dormant` is the one worth alerting on: it
// means the exe has stopped being retried and only a human re-login will fix it.
// This outage ran 46 days undetected; anything watching /api/status can now see
// it on the first check.
async function checkStatus() {
  if (_dormant) {
    return { ok: false, dormant: true, spawnFailures: _spawnFailures,
             error: _unhealthyMsg || 'Power BI is unavailable (dormant after repeated boot failures).' };
  }
  // Already known-wedged → answer instantly; the warmup/keepalive pings handle recovery.
  if (_unhealthyMsg) return { ok: false, dormant: false, spawnFailures: _spawnFailures, error: _unhealthyMsg };
  try {
    await _runDax('EVALUATE ROW("ok", 1)', INTERACTIVE_TIMEOUT);
    return { ok: true, dormant: false, spawnFailures: 0 };
  } catch (e) {
    return { ok: false, dormant: _dormant, spawnFailures: _spawnFailures, error: e.message };
  }
}

const ENABLED = fs.existsSync(EXE);
if (ENABLED) _startProc();

module.exports = { getJobHours, getJobsList, checkStatus, ENABLED };
