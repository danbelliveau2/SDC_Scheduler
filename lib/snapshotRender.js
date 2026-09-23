'use strict';
/**
 * snapshotRender.js — static customer snapshot pages.
 *
 * The LIVE customer share link (server.js's SHARE_GET_PATHS block) opens the
 * real app against the live API, scoped read-only to one project by a
 * header token. That's the right tool for a customer who wants to keep a tab
 * open and watch a schedule move. It is the wrong tool for "send someone a
 * link today" while AUTH_ENABLED defaults off and nothing rate-limits the
 * API (see the suite audit, V-2 / V-6): a live link is still a link into the
 * running app.
 *
 * A snapshot sidesteps that entirely. This module renders one project's
 * tasks to a single self-contained HTML file — no JS, no API calls, no DB
 * query at view time — written to disk under PUBLIC_SNAPSHOT_DIR. The route
 * that serves it (server.js) is a plain file read, registered before
 * requireAuth, so it never depends on the app's auth posture at all. The
 * only thing gating access is knowing the token in the URL.
 *
 * Regeneration (on demand via the API, or nightly via lib/cronJobs.js)
 * overwrites the same file — same token, same URL, fresh content.
 */
const fs = require('fs');
const path = require('path');

const PUBLIC_SNAPSHOT_DIR = path.join(__dirname, '..', 'public-snapshots');

function snapshotPath(token) {
  // Tokens are server-generated hex (see routes/projects.js) — this guard
  // just keeps a malformed value from ever becoming a path.
  const safe = String(token || '').replace(/[^a-f0-9]/gi, '');
  if (!safe) return null;
  return path.join(PUBLIC_SNAPSHOT_DIR, `${safe}.html`);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(s) {
  const d = parseDate(s);
  if (!d) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Renders one project's tasks to a static HTML string. Pure function — no I/O. */
function renderSnapshotHtml({ projectName, tasks, generatedAt }) {
  const rows = tasks.filter(t => t.start_date || t.end_date);
  const starts = rows.map(t => parseDate(t.start_date)).filter(Boolean);
  const ends = rows.map(t => parseDate(t.end_date || t.start_date)).filter(Boolean);
  const rangeStart = starts.length ? new Date(Math.min(...starts)) : null;
  const rangeEnd = ends.length ? new Date(Math.max(...ends)) : null;
  const rangeMs = rangeStart && rangeEnd ? Math.max(1, rangeEnd - rangeStart) : 1;

  const barCell = (t) => {
    const s = parseDate(t.start_date);
    const e = parseDate(t.end_date || t.start_date);
    if (!s || !e || !rangeStart) return '';
    const left = Math.max(0, Math.min(100, ((s - rangeStart) / rangeMs) * 100));
    const width = Math.max(1, Math.min(100 - left, ((e - s) / rangeMs) * 100));
    const pct = Math.max(0, Math.min(100, Number(t.progress) || 0));
    const kind = t.is_milestone ? 'milestone' : 'task';
    return `<div class="bar-track">
      <div class="bar bar--${kind}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%">
        <div class="bar-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
  };

  const taskRows = rows
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map(t => `<tr>
      <td class="c-phase">${esc(t.phase || '')}</td>
      <td class="c-name">${t.is_milestone ? '◆ ' : ''}${esc(t.name)}</td>
      <td class="c-who">${esc(t.assignee || '')}</td>
      <td class="c-date">${fmtDate(t.start_date)}</td>
      <td class="c-date">${fmtDate(t.end_date)}</td>
      <td class="c-pct">${t.is_milestone ? '—' : `${Number(t.progress) || 0}%`}</td>
      <td class="c-bar">${barCell(t)}</td>
    </tr>`)
    .join('\n');

  const generated = new Date(generatedAt).toLocaleString('en-US', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York',
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(projectName)} — Schedule Snapshot</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    background: #f4f5f7; color: #1a1f29;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 20px 60px; }
  header {
    display: flex; justify-content: space-between; align-items: baseline;
    flex-wrap: wrap; gap: 8px 24px;
    border-bottom: 2px solid #1a1f29; padding-bottom: 14px; margin-bottom: 20px;
  }
  h1 { font-size: 1.5rem; margin: 0; font-weight: 700; }
  .meta { font-size: 0.8rem; color: #5b6472; }
  .meta b { color: #1a1f29; }
  table { width: 100%; border-collapse: collapse; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  thead th {
    text-align: left; font-size: 0.72rem; letter-spacing: 0.04em; text-transform: uppercase;
    color: #5b6472; padding: 10px 12px; border-bottom: 1px solid #e2e5ea; white-space: nowrap;
  }
  tbody td { padding: 8px 12px; border-bottom: 1px solid #eef0f3; font-size: 0.85rem; vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  .c-phase { color: #5b6472; font-size: 0.78rem; white-space: nowrap; }
  .c-name { font-weight: 500; }
  .c-who { color: #5b6472; white-space: nowrap; }
  .c-date { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .c-pct { text-align: right; font-variant-numeric: tabular-nums; color: #5b6472; }
  .c-bar { width: 220px; }
  .bar-track { position: relative; height: 14px; background: #eef0f3; border-radius: 3px; }
  .bar { position: absolute; top: 0; height: 100%; border-radius: 3px; background: #c7d0da; overflow: hidden; }
  .bar--milestone { background: #1a1f29; width: 10px !important; border-radius: 2px; transform: rotate(45deg); }
  .bar-fill { height: 100%; background: #2f6fed; }
  footer { margin-top: 24px; font-size: 0.75rem; color: #8891a0; }
  @media (max-width: 700px) {
    .c-bar { display: none; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>${esc(projectName)}</h1>
      <div class="meta">Snapshot as of <b>${esc(generated)} ET</b> — not a live view</div>
    </header>
    <table>
      <thead><tr>
        <th>Phase</th><th>Task</th><th>Assignee</th><th>Start</th><th>Finish</th><th>%</th><th>Timeline</th>
      </tr></thead>
      <tbody>
        ${taskRows || '<tr><td colspan="7" style="text-align:center;color:#8891a0;padding:24px;">No scheduled tasks yet.</td></tr>'}
      </tbody>
    </table>
    <footer>Prepared by Stevens Douglas Corporation. This page reflects the schedule at the time it was generated — ask your SDC contact for a refreshed link if it's been a while.</footer>
  </div>
</body>
</html>`;
}

/** Queries the project's tasks and writes the rendered snapshot to disk. Returns the file path. */
async function generateSnapshot(pool, { token, projectName }) {
  const file = snapshotPath(token);
  if (!file) throw new Error('invalid snapshot token');
  const [tasks] = await pool.query('SELECT * FROM tasks WHERE project = ? ORDER BY sort_order, id', [projectName]);
  const html = renderSnapshotHtml({ projectName, tasks, generatedAt: new Date() });
  fs.mkdirSync(PUBLIC_SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

function deleteSnapshotFile(token) {
  const file = snapshotPath(token);
  if (!file) return;
  try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
}

module.exports = { PUBLIC_SNAPSHOT_DIR, snapshotPath, renderSnapshotHtml, generateSnapshot, deleteSnapshotFile };
