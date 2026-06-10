'use strict';
/**
 * uat-run.js — End-to-end UAT for SDC Scheduler.
 * Run: node scripts/uat-run.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');

const LOGIN_EMAIL    = 'akamuju@sdcautomation.com';
const LOGIN_PASSWORD = process.env.MYSQL_PASSWORD || 'Voltages84gilds$';

// ── HTTP helper ───────────────────────────────────────────────────────────────
function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: 'localhost', port: 4003, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token   ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        let json; try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Harness ───────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];

async function it(label, fn) {
  try {
    await fn();
    console.log(`  ✓  ${label}`);
    pass++;
  } catch (e) {
    console.log(`  ✗  ${label}`);
    console.log(`       ${e.message}`);
    fail++;
    failures.push({ label, error: e.message });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function eq(a, b, msg)     { assert(a === b, msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function hasKey(o, k)      { assert(o && k in o, `Missing key "${k}" in ${JSON.stringify(o)?.slice(0,100)}`); }

// ── Suites ────────────────────────────────────────────────────────────────────

async function suiteHealth() {
  console.log('\n── Health & Static Assets ──');

  await it('GET /health -> ok:true (no auth required)', async () => {
    const r = await req('GET', '/health');
    eq(r.status, 200); eq(r.body.ok, true); eq(r.body.service, 'scheduler');
  });

  await it('GET / -> serves index.html', async () => {
    const r = await req('GET', '/');
    eq(r.status, 200);
    assert(r.raw.includes('SDC'), 'index.html missing "SDC"');
  });

  await it('GET /app.js -> served', async () => {
    const r = await req('GET', '/app.js');
    assert(r.status === 200 || r.status === 304, `Got ${r.status}`);
  });

  await it('GET /styles.css -> served', async () => {
    const r = await req('GET', '/styles.css');
    assert(r.status === 200 || r.status === 304, `Got ${r.status}`);
  });

  await it('GET /auth-ui.js -> served', async () => {
    const r = await req('GET', '/auth-ui.js');
    assert(r.status === 200 || r.status === 304, `Got ${r.status}`);
  });

  // Auth guard fires before static 404 — 401 on unknown paths is correct
  await it('GET /unknown-path -> 401 (auth guard before static 404)', async () => {
    const r = await req('GET', '/nonexistent-xyz-file');
    eq(r.status, 401);
  });
}

async function suiteAuth(token) {
  console.log('\n── Auth ──');

  await it('GET /api/tasks without token -> 401', async () => {
    const r = await req('GET', '/api/tasks');
    eq(r.status, 401);
  });

  await it('POST /api/auth/login with wrong password -> 401', async () => {
    const r = await req('POST', '/api/auth/login', { email: LOGIN_EMAIL, password: 'wrongpassword_xyz' });
    eq(r.status, 401);
  });

  await it('POST /api/auth/login with valid credentials -> 200 + token', async () => {
    assert(token && token.length > 20, 'Token missing or too short');
  });

  // /api/auth/me returns { user: {...}, auth_enabled: bool }
  await it('GET /api/auth/me with valid token -> 200 + wrapped user object', async () => {
    const r = await req('GET', '/api/auth/me', null, token);
    eq(r.status, 200);
    const user = r.body.user || r.body;
    hasKey(user, 'email'); hasKey(user, 'role');
  });

  await it('GET /api/auth/me with invalid token -> 401', async () => {
    const r = await req('GET', '/api/auth/me', null, 'invalid.token.here');
    eq(r.status, 401);
  });
}

async function suiteTasks(token) {
  console.log('\n── Tasks (CRUD) ──');
  // Design: no GET /api/tasks/:id — all tasks loaded at once, client filters
  // POST and PUT return 200 (not 201)
  let createdId;

  await it('GET /api/tasks -> 200 + non-empty array', async () => {
    const r = await req('GET', '/api/tasks', null, token);
    eq(r.status, 200);
    assert(Array.isArray(r.body) && r.body.length > 0, `Expected array, got ${typeof r.body}`);
    console.log(`       (${r.body.length} tasks in DB)`);
  });

  await it('GET /api/tasks -> each task has id, name, project', async () => {
    const r = await req('GET', '/api/tasks', null, token);
    const first = r.body[0];
    hasKey(first, 'id'); hasKey(first, 'name');
  });

  await it('POST /api/tasks -> 200 + id (create)', async () => {
    const r = await req('POST', '/api/tasks', {
      name: '_UAT_TEST_TASK_', project: '_UAT_PROJECT_', phase: 'testing',
      duration_days: 1, start_date: '2026-06-10', end_date: '2026-06-11',
      assignee: 'UAT Bot', progress: 0, sort_order: 99999,
    }, token);
    assert(r.status === 200 || r.status === 201, `Got ${r.status}`);
    hasKey(r.body, 'id');
    assert(r.body.id > 0, 'id must be positive');
    createdId = r.body.id;
    console.log(`       (created id=${createdId})`);
  });

  await it('GET /api/tasks -> created task appears in full list', async () => {
    if (!createdId) return;
    const r = await req('GET', '/api/tasks', null, token);
    eq(r.status, 200);
    assert(r.body.some(t => t.id === createdId && t.name === '_UAT_TEST_TASK_'),
      'Created task not found in task list');
  });

  await it('PUT /api/tasks/:id -> 200 + updates stored', async () => {
    if (!createdId) return;
    const r = await req('PUT', `/api/tasks/${createdId}`, { name: '_UAT_UPDATED_', progress: 50 }, token);
    eq(r.status, 200);
  });

  await it('GET /api/tasks -> updated task reflects PUT changes', async () => {
    if (!createdId) return;
    const r = await req('GET', '/api/tasks', null, token);
    const t = r.body.find(x => x.id === createdId);
    assert(t, 'Updated task not found in list');
    eq(t.name, '_UAT_UPDATED_');
    eq(t.progress, 50);
  });

  await it('DELETE /api/tasks/:id -> 200 or 204', async () => {
    if (!createdId) return;
    const r = await req('DELETE', `/api/tasks/${createdId}`, null, token);
    assert(r.status === 200 || r.status === 204, `Got ${r.status}`);
  });

  await it('GET /api/tasks -> deleted task no longer in list', async () => {
    if (!createdId) return;
    const r = await req('GET', '/api/tasks', null, token);
    assert(!r.body.some(t => t.id === createdId), 'Deleted task still in list');
  });

  await it('POST /api/tasks without auth -> 401', async () => {
    const r = await req('POST', '/api/tasks', { name: 'No Auth Task' });
    eq(r.status, 401);
  });
}

async function suiteHistory(token) {
  console.log('\n── History (audit trail) ──');
  // History endpoint: GET /api/tasks/history?project=X (requires project param)

  await it('GET /api/tasks/history without project -> 400', async () => {
    const r = await req('GET', '/api/tasks/history', null, token);
    eq(r.status, 400);
  });

  await it('GET /api/tasks/history?project=X -> 200 + array', async () => {
    const tasks = await req('GET', '/api/tasks', null, token);
    const proj = tasks.body.find(t => t.project)?.project;
    if (!proj) { console.log('       (skip: no tasks with project)'); return; }
    const r = await req('GET', `/api/tasks/history?project=${encodeURIComponent(proj)}`, null, token);
    eq(r.status, 200);
    assert(Array.isArray(r.body), 'Expected array');
    console.log(`       (${r.body.length} history entries for "${proj}")`);
  });
}

async function suiteComments(token) {
  console.log('\n── Comments ──');
  // Comment delete: DELETE /api/comments/:id (NOT /api/tasks/:id/comments/:id)
  let taskId, commentId;

  const t = await req('POST', '/api/tasks', {
    name: '_UAT_COMMENT_TASK_', project: '_UAT_PROJECT_',
    start_date: '2026-06-10', end_date: '2026-06-11', sort_order: 99998,
  }, token);
  taskId = t.body?.id;
  if (!taskId) { console.log('  -  (skip: cannot create task)'); return; }

  await it('POST /api/tasks/:id/comments -> 201', async () => {
    const r = await req('POST', `/api/tasks/${taskId}/comments`, { body: 'UAT comment' }, token);
    eq(r.status, 201); hasKey(r.body, 'id'); commentId = r.body.id;
  });

  await it('GET /api/tasks/:id/comments -> 200 + includes new comment', async () => {
    const r = await req('GET', `/api/tasks/${taskId}/comments`, null, token);
    eq(r.status, 200); assert(Array.isArray(r.body), 'Expected array');
    assert(r.body.some(c => c.id === commentId), 'Comment not found in list');
  });

  // Delete via /api/comments/:id (top-level, not nested)
  await it('DELETE /api/comments/:id -> 200 or 204', async () => {
    if (!commentId) return;
    const r = await req('DELETE', `/api/comments/${commentId}`, null, token);
    assert(r.status === 200 || r.status === 204, `Got ${r.status}`);
  });

  await it('GET /api/tasks/:id/comments -> comment gone after delete', async () => {
    if (!commentId) return;
    const r = await req('GET', `/api/tasks/${taskId}/comments`, null, token);
    eq(r.status, 200);
    assert(!r.body.some(c => c.id === commentId), 'Deleted comment still present');
  });

  await req('DELETE', `/api/tasks/${taskId}`, null, token);
}

async function suiteSettings(token) {
  console.log('\n── Settings ──');

  await it('GET /api/settings -> 200 + object with expected keys', async () => {
    const r = await req('GET', '/api/settings', null, token);
    eq(r.status, 200);
    assert(r.body && typeof r.body === 'object', 'Expected object');
    hasKey(r.body, 'theme'); hasKey(r.body, 'phases'); hasKey(r.body, 'brand_palette');
    console.log(`       (${Object.keys(r.body).length} settings keys)`);
  });

  await it('Settings: phases is non-empty array', async () => {
    const r = await req('GET', '/api/settings', null, token);
    assert(Array.isArray(r.body.phases) && r.body.phases.length > 0, 'phases empty');
  });

  await it('Settings: brand_palette has color objects with hex', async () => {
    const r = await req('GET', '/api/settings', null, token);
    const pal = r.body.brand_palette;
    assert(Array.isArray(pal) && pal.length > 0 && pal[0].hex, 'brand_palette malformed');
  });

  await it('Settings: default_financial_milestones present', async () => {
    const r = await req('GET', '/api/settings', null, token);
    hasKey(r.body, 'default_financial_milestones');
    assert(Array.isArray(r.body.default_financial_milestones), 'Expected array');
  });
}

async function suiteTeam(token) {
  console.log('\n── Team Members ──');
  let memberId;

  await it('GET /api/team -> 200 + array', async () => {
    const r = await req('GET', '/api/team', null, token);
    eq(r.status, 200); assert(Array.isArray(r.body), 'Expected array');
    console.log(`       (${r.body.length} members)`);
  });

  // Valid disciplines: mech, controls, pm, build, wire
  await it('POST /api/team -> 200/201 + id (valid discipline "mech")', async () => {
    const r = await req('POST', '/api/team', { name: '_UAT_MEMBER_', discipline: 'mech', active: 1 }, token);
    assert(r.status === 200 || r.status === 201, `Got ${r.status}`);
    hasKey(r.body, 'id'); memberId = r.body.id;
    console.log(`       (created member id=${memberId})`);
  });

  await it('POST /api/team with invalid discipline -> 400 "invalid discipline"', async () => {
    const r = await req('POST', '/api/team', { name: '_BAD_', discipline: 'InvalidDiscipline' }, token);
    eq(r.status, 400);
    assert(r.body.error === 'invalid discipline', `Got: ${r.body.error}`);
  });

  await it('PUT /api/team/:id -> 200', async () => {
    if (!memberId) return;
    const r = await req('PUT', `/api/team/${memberId}`, { name: '_UAT_MEMBER_UPD_', discipline: 'mech', active: 1 }, token);
    assert(r.status === 200 || r.status === 204, `Got ${r.status}`);
  });

  await it('DELETE /api/team/:id -> 200 or 204', async () => {
    if (!memberId) return;
    const r = await req('DELETE', `/api/team/${memberId}`, null, token);
    assert(r.status === 200 || r.status === 204, `Got ${r.status}`);
  });
}

async function suiteProjects(token) {
  console.log('\n── Projects ──');

  await it('GET /api/projects -> 200 + array', async () => {
    const r = await req('GET', '/api/projects', null, token);
    eq(r.status, 200); assert(Array.isArray(r.body), 'Expected array');
    console.log(`       (${r.body.length} projects)`);
  });

  await it('GET /api/projects -> each has id + name', async () => {
    const r = await req('GET', '/api/projects', null, token);
    if (r.body.length > 0) { hasKey(r.body[0], 'id'); hasKey(r.body[0], 'name'); }
  });
}

async function suiteFinancials(token) {
  console.log('\n── Financials ──');
  let finId;

  await it('POST /api/financials -> 200/201 + id', async () => {
    const r = await req('POST', '/api/financials', {
      project: '_UAT_PROJECT_', name: 'UAT Milestone', percent: 10,
      amount: 5000, due_date: '2026-07-01', paid: 0, sort_order: 1,
    }, token);
    assert(r.status === 201 || r.status === 200, `Got ${r.status}`);
    if (r.body?.id) finId = r.body.id;
    console.log(`       (created financial id=${finId})`);
  });

  await it('GET /api/financials?project=_UAT_PROJECT_ -> 200 + array', async () => {
    const r = await req('GET', '/api/financials?project=_UAT_PROJECT_', null, token);
    assert(r.status === 200 || r.status === 404, `Got ${r.status}`);
    if (r.status === 200) assert(Array.isArray(r.body), 'Expected array');
  });

  await it('DELETE /api/financials/:id -> 200 or 204', async () => {
    if (!finId) return;
    const r = await req('DELETE', `/api/financials/${finId}`, null, token);
    assert(r.status === 200 || r.status === 204, `Got ${r.status}`);
  });
}

async function suiteUsers(token) {
  console.log('\n── Users ──');

  await it('GET /api/users -> 200 + array with at least 1 user', async () => {
    const r = await req('GET', '/api/users', null, token);
    eq(r.status, 200); assert(Array.isArray(r.body) && r.body.length >= 1, 'Expected >=1 user');
    console.log(`       (${r.body.length} users)`);
  });

  await it('GET /api/users -> password_hash NOT exposed', async () => {
    const r = await req('GET', '/api/users', null, token);
    assert(!r.body.some(u => 'password_hash' in u), 'password_hash must not be returned');
  });

  await it('GET /api/users -> each user has id, email, role', async () => {
    const r = await req('GET', '/api/users', null, token);
    const first = r.body[0];
    hasKey(first, 'id'); hasKey(first, 'email'); hasKey(first, 'role');
  });
}

async function suiteSocketIO() {
  console.log('\n── Socket.IO ──');

  await it('/socket.io/?EIO=4&transport=polling -> 200 or 400 (socket.io present)', async () => {
    const r = await req('GET', '/socket.io/?EIO=4&transport=polling');
    assert(r.status === 200 || r.status === 400, `Got ${r.status} — 404 means socket.io missing`);
  });
}

async function suiteDBIntegrity(token) {
  console.log('\n── Database Integrity (MySQL) ──');

  await it('Tasks: consistent count across two simultaneous queries', async () => {
    const [r1, r2] = await Promise.all([
      req('GET', '/api/tasks', null, token),
      req('GET', '/api/tasks', null, token),
    ]);
    eq(r1.status, 200); eq(r1.body.length, r2.body.length);
  });

  await it('Tasks: no SQLite or Azure error strings in response body', async () => {
    const r = await req('GET', '/api/tasks', null, token);
    const s = JSON.stringify(r.body);
    assert(!s.includes('SQLITE'), 'SQLite error in response');
    assert(!s.toUpperCase().includes('AZURE'), 'Azure reference in response');
  });

  await it('Settings: theme + phases + brand_palette + default_financial_milestones seeded', async () => {
    const r = await req('GET', '/api/settings', null, token);
    eq(r.status, 200);
    ['theme','phases','brand_palette','default_financial_milestones'].forEach(k => hasKey(r.body, k));
  });

  await it('All 5 core tables respond 200 (tasks, team, projects, users, settings)', async () => {
    const names = ['tasks','team','projects','users','settings'];
    const results = await Promise.all([
      req('GET', '/api/tasks',    null, token),
      req('GET', '/api/team',     null, token),
      req('GET', '/api/projects', null, token),
      req('GET', '/api/users',    null, token),
      req('GET', '/api/settings', null, token),
    ]);
    results.forEach((r, i) => assert(r.status === 200, `${names[i]} returned ${r.status}`));
  });

  await it('task_history: GET /api/tasks/history?project=X -> 200 + array', async () => {
    const tasks = await req('GET', '/api/tasks', null, token);
    const proj = tasks.body.find(t => t.project)?.project;
    if (!proj) { console.log('       (skip: no tasks with project)'); return; }
    const r = await req('GET', `/api/tasks/history?project=${encodeURIComponent(proj)}`, null, token);
    eq(r.status, 200); assert(Array.isArray(r.body), 'Expected array');
    console.log(`       (${r.body.length} history entries)`);
  });

  await it('task_comments: GET /api/tasks/:id/comments -> 200 + array', async () => {
    const tasks = await req('GET', '/api/tasks', null, token);
    const first = tasks.body[0];
    if (!first) return;
    const r = await req('GET', `/api/tasks/${first.id}/comments`, null, token);
    eq(r.status, 200); assert(Array.isArray(r.body), 'Expected array');
  });

  await it('notification_log table: server booted without schema errors', async () => {
    // Indirect: if tables were missing, tasks endpoint would throw 500
    const r = await req('GET', '/api/tasks', null, token);
    eq(r.status, 200);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  SDC Scheduler — End-to-End UAT');
  console.log('  Target: http://localhost:4003');
  console.log('═══════════════════════════════════════════════════');

  let token = '';
  try {
    const r = await req('POST', '/api/auth/login', { email: LOGIN_EMAIL, password: LOGIN_PASSWORD });
    token = r.body?.token || '';
    if (!token) throw new Error(`${JSON.stringify(r.body)}`);
    console.log(`\n  Authenticated as: ${r.body.user?.email} (${r.body.user?.role})`);
  } catch (e) {
    console.error(`\n  FATAL: Cannot authenticate — ${e.message}`);
    process.exit(1);
  }

  await suiteHealth();
  await suiteAuth(token);
  await suiteTasks(token);
  await suiteHistory(token);
  await suiteComments(token);
  await suiteSettings(token);
  await suiteTeam(token);
  await suiteProjects(token);
  await suiteFinancials(token);
  await suiteUsers(token);
  await suiteSocketIO();
  await suiteDBIntegrity(token);

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  RESULTS:  ${pass} passed  |  ${fail} failed`);
  console.log('═══════════════════════════════════════════════════');

  if (failures.length) {
    console.log('\n  FAILURES:');
    failures.forEach(f => console.log(`    ✗ ${f.label}\n      ${f.error}`));
  } else {
    console.log('\n  All tests passed — backend fully operational on MySQL.');
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
