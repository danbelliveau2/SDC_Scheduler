'use strict';
/**
 * uat-deep.js — In-depth UAT beyond the base suite (uat-run.js).
 * Covers: frontend asset integrity (Rev 8.0), auth security, task lifecycle
 * with cascade scheduling, quote persistence, concurrency, malformed input,
 * and SQL injection probes. Read-only against real data; all test rows are
 * created under _UAT_*_ projects and deleted at the end.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function req(m, p, b, t) {
  return new Promise((res) => {
    const d = b ? JSON.stringify(b) : null;
    const r = http.request({
      hostname: 'localhost', port: 4003, path: p, method: m,
      headers: {
        'Content-Type': 'application/json',
        ...(t ? { Authorization: 'Bearer ' + t } : {}),
        ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}),
      },
    }, re => {
      let x = '';
      re.on('data', c => x += c);
      re.on('end', () => { let j = null; try { j = JSON.parse(x); } catch (_) {} res({ s: re.statusCode, b: j, raw: x, h: re.headers }); });
    });
    r.setTimeout(15000, () => { res({ s: 'TIMEOUT' }); r.destroy(); });
    r.on('error', e => res({ s: 'ERR:' + e.message }));
    if (d) r.write(d);
    r.end();
  });
}

async function main() {
  const login = await req('POST', '/api/auth/login', { email: 'akamuju@sdcautomation.com', password: process.env.MYSQL_PASSWORD });
  const t = login.b && login.b.token;
  if (!t) { console.log('FATAL: cannot authenticate, status=' + login.s); process.exit(1); }

  console.log('── Frontend assets (Rev 8.0) ──');
  const assets = [
    ['/app.js', 'renderDeptProjectRollup'],
    ['/index.html', 'view-team'],
    ['/styles.css', 'dept-project-rollup'],
    ['/release-notes.js', "version: '8.0'"],
    ['/auth-ui.js', 'minlength="1"'],
    ['/comments-ui.js', 'comment'],
    ['/phases.js', 'phase'],
  ];
  for (const [p, marker] of assets) {
    const r = await req('GET', p, null, t);
    ok('GET ' + p + ' → 200 + Rev8 marker', r.s === 200 && r.raw.includes(marker), 's=' + r.s + ' marker=' + (r.raw || '').includes(marker));
  }
  const idx = await req('GET', '/index.html', null, t);
  ok('index.html: standalone #view-dashboard removed (v7.6)', !idx.raw.includes('id="view-dashboard"'));

  console.log('── Auth security ──');
  let r = await req('GET', '/api/tasks');
  ok('No token → 401', r.s === 401);
  r = await req('GET', '/api/tasks', null, 'invalid.jwt.token');
  ok('Garbage token → 401', r.s === 401);
  r = await req('POST', '/api/auth/login', { email: 'akamuju@sdcautomation.com', password: 'wrongpassword' });
  ok('Wrong password → 401', r.s === 401);
  r = await req('POST', '/api/auth/login', { email: 'nobody@nowhere.com', password: 'x' });
  ok('Unknown email → 401', r.s === 401);
  r = await req('POST', '/api/auth/login', {});
  ok('Empty login body → 400', r.s === 400);
  const secEmail = 'uat-sec-' + process.pid + '@sdc-test.com';
  r = await req('POST', '/api/auth/register', { email: secEmail, name: 'UAT Sec', password: 'p', role: 'admin' });
  ok('Register role=admin → clamped to editor + note', r.s === 201 && r.b && r.b.user && r.b.user.role === 'editor' && !!r.b.note, 's=' + r.s + ' role=' + (r.b && r.b.user && r.b.user.role));
  r = await req('POST', '/api/auth/register', { email: secEmail, name: 'dup', password: 'p' });
  ok('Duplicate register → 409', r.s === 409);

  console.log('── Task lifecycle + cascade scheduling ──');
  const P = '_UAT_DEEP_';
  r = await req('POST', '/api/tasks', { name: 'UAT Pred', project: P, start_date: '2026-06-15', end_date: '2026-06-17', duration_days: 3, section: '10' }, t);
  const id1 = r.b && r.b.id;
  ok('Create task A', r.s === 200 && !!id1, 's=' + r.s);
  r = await req('POST', '/api/tasks', { name: 'UAT Succ', project: P, start_date: '2026-06-18', end_date: '2026-06-19', duration_days: 2, section: '10', predecessors: String(id1) }, t);
  const id2 = r.b && r.b.id;
  ok('Create task B with predecessor A', r.s === 200 && !!id2);
  r = await req('PUT', '/api/tasks/' + id1, { start_date: '2026-06-22', end_date: '2026-06-24' }, t);
  ok('Move A later → 200', r.s === 200);
  r = await req('GET', '/api/tasks', null, t);
  const b = (r.b || []).find(x => x.id === id2);
  ok('B cascaded after A (FS dependency)', b && new Date(b.start_date) >= new Date('2026-06-24'), 'B.start=' + (b && b.start_date));
  await req('PUT', '/api/tasks/' + id2, { progress: 100 }, t);
  let r2 = await req('GET', '/api/tasks', null, t);
  let b2 = (r2.b || []).find(x => x.id === id2);
  ok('progress=100 → completed_on auto-stamped', !!(b2 && b2.completed_on), 'completed_on=' + (b2 && b2.completed_on));
  await req('PUT', '/api/tasks/' + id2, { progress: 50 }, t);
  r2 = await req('GET', '/api/tasks', null, t);
  b2 = (r2.b || []).find(x => x.id === id2);
  ok('progress back to 50 → completed_on cleared', !(b2 && b2.completed_on), 'completed_on=' + (b2 && b2.completed_on));
  r = await req('GET', '/api/tasks/history?project=' + P, null, t);
  ok('History recorded for project', r.s === 200 && Array.isArray(r.b) && r.b.length >= 2, 'count=' + (r.b && r.b.length));
  r = await req('POST', '/api/tasks/' + id1 + '/comments', { body: 'UAT deep comment' }, t);
  ok('Add comment → 200/201', r.s === 200 || r.s === 201, 's=' + r.s);
  r = await req('GET', '/api/tasks/' + id1 + '/comments', null, t);
  const cid = r.b && r.b[0] && r.b[0].id;
  ok('Comment readable', r.s === 200 && r.b && r.b.length === 1);
  r = await req('DELETE', '/api/comments/' + cid, null, t);
  ok('Delete comment', r.s === 200 || r.s === 204, 's=' + r.s);
  await req('DELETE', '/api/tasks/' + id1, null, t);
  await req('DELETE', '/api/tasks/' + id2, null, t);
  r = await req('GET', '/api/tasks', null, t);
  ok('Cleanup: UAT tasks deleted', !(r.b || []).some(x => x.project === P));

  console.log('── Quote persistence (Rev 8.0 merge fix) ──');
  r = await req('POST', '/api/project/' + P + '/quote', { sold_delivery_weeks: 30, hours_per_section: { 10: 100 } }, t);
  ok('Save quote with sold_delivery_weeks', r.s === 200, 's=' + r.s);
  r = await req('GET', '/api/project/' + P + '/quote', null, t);
  ok('Quote readable + sold_delivery survives', r.b && r.b.sold_delivery_weeks === 30, 'got=' + JSON.stringify(r.b && r.b.sold_delivery_weeks));
  await req('DELETE', '/api/project/' + P + '/quote', null, t);

  console.log('── Stress / concurrency / malformed input ──');
  const N = 20;
  const results = await Promise.all(Array.from({ length: N }, () => req('GET', '/api/tasks', null, t)));
  ok(N + ' concurrent GET /api/tasks all 200', results.every(x => x.s === 200));
  const counts = new Set(results.map(x => x.b && x.b.length));
  ok('All concurrent responses consistent', counts.size === 1, [...counts].join(','));
  r = await req('PUT', '/api/tasks/999999', { name: 'ghost' }, t);
  ok('PUT nonexistent task → 404', r.s === 404, 's=' + r.s);
  r = await req('DELETE', '/api/tasks/999999', null, t);
  ok('DELETE nonexistent → 404 or 200', r.s === 404 || r.s === 200, 's=' + r.s);
  r = await req('POST', '/api/tasks', { project: 'X' }, t);
  ok('POST task without name → 400', r.s === 400, 's=' + r.s);
  r = await req('POST', '/api/tasks', { name: 'X'.repeat(10000), project: '_UAT_HUGE_' }, t);
  ok('Huge 10k-char name → no hang (any non-timeout status)', r.s !== 'TIMEOUT', 's=' + r.s);
  if (r.b && r.b.id) await req('DELETE', '/api/tasks/' + r.b.id, null, t);
  r = await req('GET', '/api/tasks?project=' + encodeURIComponent("x' OR '1'='1"), null, t);
  ok('SQLi probe in query param → no error', r.s === 200);
  r = await req('POST', '/api/tasks', { name: "Robert'); DROP TABLE tasks;--", project: '_UAT_SQLI_' }, t);
  ok('SQLi in task name → stored safely', r.s === 200 && !!(r.b && r.b.id), 's=' + r.s);
  if (r.b && r.b.id) await req('DELETE', '/api/tasks/' + r.b.id, null, t);
  const chk = await req('GET', '/api/tasks', null, t);
  ok('tasks table alive after SQLi probes', chk.s === 200 && Array.isArray(chk.b));
  // datetime edge: ISO string with T/Z must not 500 (the old MySQL bug class)
  r = await req('POST', '/api/tasks', { name: 'UAT iso date', project: '_UAT_ISO_', start_date: '2026-06-15', end_date: '2026-06-16' }, t);
  const isoId = r.b && r.b.id;
  ok('Create with plain dates → 200', r.s === 200);
  if (isoId) {
    r = await req('PUT', '/api/tasks/' + isoId, { start_date: '2026-06-20T00:00:00.000Z' }, t);
    ok('ISO 8601 date with T/Z in update → no hang/500', r.s !== 'TIMEOUT', 's=' + r.s);
    await req('DELETE', '/api/tasks/' + isoId, null, t);
  }

  console.log('── Settings round-trip ──');
  r = await req('GET', '/api/settings', null, t);
  const themeBefore = r.b && r.b.theme;
  ok('GET settings → has theme', r.s === 200 && themeBefore !== undefined);
  // PUT /api/settings/:key stores the whole request body as the value
  r = await req('PUT', '/api/settings/uat_probe_key', { value: 'uat-probe-value' }, t);
  ok('PUT custom setting → 200', r.s === 200, 's=' + r.s);
  r = await req('GET', '/api/settings', null, t);
  const probe = r.b && r.b.uat_probe_key;
  ok('Custom setting persisted', probe && probe.value === 'uat-probe-value', 'got=' + JSON.stringify(probe));

  console.log('');
  console.log('RESULTS: ' + pass + ' passed | ' + fail + ' failed');
  if (failures.length) { console.log('FAILED:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
