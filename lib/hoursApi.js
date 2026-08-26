'use strict';
/**
 * hoursApi.js — per-section quoted / actual / ETC hours for the Job Hours page.
 *
 * ── Source of truth (2026-08-26) ────────────────────────────────────────────
 * Hours come from PAYLOCITY PUNCHES via the Reports App (sdc-etc-planner)
 * database, read over its /api/integration/jobs/:job/hours endpoint. Power BI is
 * NOT a valid hours source for this app, or for any SDC Tools app. Do not add
 * one back.
 *
 * This file used to spawn a Power BI MCP exe and run DAX itself. Two things were
 * wrong with that, and both are worth remembering before anyone reinstates it:
 *
 *  1. It was WRONG, not just fragile. The Reports App moved its own hours off
 *     Power BI on 2026-08-05 after measuring the PBI model running days behind
 *     the Paylocity workbook — July short 150.53h, August absent entirely. So
 *     this page was serving numbers that app had already rejected.
 *
 *  2. It could not stay up. The exe needs an interactive MSAL token that no
 *     service can renew. The token cache emptied on 2026-07-11 and Job Hours was
 *     dead for 46 days while the exe respawned every ~4 seconds — 46,956 error
 *     lines and 18,611 restarts in a single day, noticed only on 2026-08-26.
 *     That whole failure class is gone with the exe: there is no child process
 *     here any more, no token, nothing to wedge. The backoff/dormancy machinery
 *     written to contain that loop was deleted along with it.
 *
 * The Reports App owns the hard parts and this file deliberately does not
 * reimplement them: which of three eras a month's actuals come from, and the
 * raw-Paylocity-code fold onto fixed section columns. Fetch, cache, shape.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * getJobHours returns { fns, bgTotals, totals, jobIds } — unchanged from the
 * Power BI era so the page did not have to be rewritten:
 *   fns     [{ section, group, fn, billing, order, quoted, actual, etc }]
 *   bgTotals subtotals keyed on `billing`
 * `billing` now carries the Reports App's section GROUP (Management, Mechanical
 * Engineering, Controls Engineering, General Engineering, Engineering, Shop),
 * replacing Power BI's "Billing Group", which has no equivalent there. Keeping
 * the field name means bgTotals/BG_ORDER keep working; only the values changed.
 */
const path = require('path');
const fs = require('fs');
const plannerClient = require('./plannerClient');

const STALE_TTL  = 10 * 60 * 1000;      // serve from cache if < 10 min old
const DISK_TTL   = 24 * 60 * 60 * 1000; // (kept for parity with the old file)

// Persistent disk cache directory — survives server restarts.
//
// DELIBERATELY A NEW DIRECTORY, not the old '.pbi-cache' (2026-08-26). The cached
// payloads are shaped by whichever source wrote them, and the Power BI era's rows
// carry its "Section Function Group" values — PM, Invalid, Manufacturing — where
// this source emits the Reports App's section groups. Reusing the directory means
// every warm entry is served with the OLD grouping until it ages out, so the page
// silently shows pre-migration data with subtotal keys that no longer match
// BG_ORDER. Caught while testing the switch: a stubbed transport was never even
// called because '.pbi-cache' answered first.
//
// '.pbi-cache' can be deleted; nothing reads it now. Bump this name again if the
// row shape ever changes.
const CACHE_DIR = path.join(__dirname, '.hours-cache');
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

function _log(...args) { console.log('[hoursApi]', ...args); }

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

// A scheduler job field can name more than one ETO job ("1145 / 1146"), and the
// page shows their hours combined. Unchanged from the Power BI implementation.
function _parseJobIds(raw) {
  return String(raw).split(/[&,\/\s]+/).map(s => s.replace(/[^0-9a-zA-Z_-]/g, '')).filter(Boolean);
}

function _emptyTotals() { return { quoted: 0, actual: 0, etc: 0 }; }

/** Roll a flat fns list up into per-billing-group subtotals + a grand total. */
function _summarise(fns, ids) {
  const bgTotals = {};
  for (const r of fns) {
    if (!bgTotals[r.billing]) bgTotals[r.billing] = _emptyTotals();
    bgTotals[r.billing].quoted += r.quoted;
    bgTotals[r.billing].actual += r.actual;
    bgTotals[r.billing].etc    += r.etc;
  }
  const totals = fns.reduce((a, r) => {
    a.quoted += r.quoted; a.actual += r.actual; a.etc += r.etc; return a;
  }, _emptyTotals());
  return { fns, bgTotals, totals, jobIds: ids };
}

/**
 * Fetch one job's rows from the Reports App and map them onto the page's shape.
 *
 * The endpoint returns section CODE ("10-211"), the section's display name, its
 * group, and its phase. The page renders a three-level pivot — section > group >
 * function — so `phase` becomes the top level (the nearest equivalent of Power
 * BI's "Section Name"), and the code is appended to the function label so a row
 * is still identifiable when two phases share a function name.
 */
async function _fetchOneJob(id) {
  const res = await plannerClient.getJobHoursBySection(id);
  if (res === null) return null; // no such job in the Reports App — see _fetchJobHours
  const rows = Array.isArray(res && res.rows) ? res.rows : [];
  return rows.map(r => ({
    section: r.phase || 'Other',
    group:   r.group || 'Other',
    fn:      r.fn || r.section,
    // Deliberately the group, not a billing code — see the header. Keeping the
    // key name is what let the page survive the source change untouched.
    billing: r.group || 'Other',
    order:   Number.isFinite(r.order) ? r.order : 0,
    quoted:  Number(r.quoted) || 0,
    actual:  Number(r.actual) || 0,
    etc:     Number(r.etc) || 0,
    code:    r.section,
  }));
}

async function _fetchJobHours(ids, key) {
  // One request per job, in parallel. A real FAILURE (transport, 500) still
  // rejects the whole read — quietly dropping one job of a "1145 / 1146" pair is
  // worse than saying it failed.
  //
  // An id the Reports App has never heard of is different, and is usually not a
  // job at all: a scheduler job field can read "2025 SERVICE" or "NOT DEFINED",
  // and _parseJobIds splits on whitespace, so "SERVICE" and "DEFINED" arrive here
  // as ids. Those are skipped. But if NOTHING matched, that is reported rather
  // than returned as a tidy set of zeros, which would read as "this job has no
  // hours booked" when the truth is "we could not find this job".
  const perJob = await Promise.all(ids.map(id => _fetchOneJob(id)));
  const matched = ids.filter((_, i) => perJob[i] !== null);
  if (!matched.length) {
    throw new Error(`No job matching "${ids.join(' / ')}" exists in the Reports App.`);
  }
  const data = _summarise(perJob.filter(Boolean).flat(), matched);
  _cacheSet(key, data);
  return data;
}

async function getJobHours(jobId) {
  const ids = _parseJobIds(jobId);
  if (!ids.length) throw new Error('No valid job ID provided');

  const key = 'job_' + ids.slice().sort().join('_');
  const hit = _cacheGet(key);
  if (hit && !hit.stale) return hit.data;
  if (hit && hit.stale) {
    // Serve stale immediately, refresh behind it.
    _fetchJobHours(ids, key).catch(() => {});
    return hit.data;
  }

  // No combined cache — try merging individual per-job entries.
  if (ids.length > 1) {
    const parts = ids.map(id => _cacheGet('job_' + id)).filter(Boolean);
    if (parts.length === ids.length) {
      const merged = _summarise(parts.flatMap(p => p.data.fns), ids);
      _cacheSet(key, merged);
      if (!parts.every(p => !p.stale)) _fetchJobHours(ids, key).catch(() => {});
      return merged;
    }
  }

  return _fetchJobHours(ids, key);
}

/** Job picker list. Same { id, name, status } shape the page already expects. */
async function getJobsList() {
  const key = 'jobs_list';
  const hit = _cacheGet(key);
  if (hit && !hit.stale) return hit.data;
  try {
    const jobs = (await plannerClient.getJobs())
      .map(j => ({ id: j.jobId || '', name: j.jobName || '', status: j.status || '' }))
      .filter(j => j.id);
    _cacheSet(key, jobs);
    return jobs;
  } catch (e) {
    // A cached list, even a stale one, beats an empty picker.
    if (hit) { _log('jobs list fetch failed, serving stale cache:', e.message); return hit.data; }
    throw e;
  }
}

/** Returns { ok, error } — used by the status endpoint. */
async function checkStatus() {
  if (!plannerClient.CONFIGURED) {
    return { ok: false, error: 'Job Hours is not configured — set the Reports App URL and shared token.' };
  }
  try {
    await plannerClient.ping();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Reports App unreachable: ${e.message}` };
  }
}

// Enabled when the Reports App link is configured. Previously this tested for the
// Power BI exe on disk; there is no exe any more.
const ENABLED = plannerClient.CONFIGURED;

module.exports = { getJobHours, getJobsList, checkStatus, ENABLED };
