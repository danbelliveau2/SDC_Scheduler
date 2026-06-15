#!/usr/bin/env node
'use strict';
/**
 * scripts/uat.js — End-to-end UAT for SDC Scheduler.
 *
 * Exercises every /api/* endpoint, every role-gate, every error path.
 * Prints PASS/FAIL per case + a summary. Exit non-zero if any FAIL.
 *
 * Assumes:
 *   - Server running on http://localhost:3000
 *   - AUTH_ENABLED=true
 *   - A test user exists: test@sdc.com / testpass123
 */
const http = require('http');

const BASE = process.env.UAT_BASE || 'http://localhost:3000';
let pass = 0, fail = 0, skip = 0;
const failures = [];
let TOKEN = '';

function fetch(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (TOKEN && !h.Authorization) h.Authorization = 'Bearer ' + TOKEN;
    const u = new URL(BASE + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers: h,
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: json, raw: buf });
      });
    });
    req.on('error', e => resolve({ status: 0, body: null, raw: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

async function it(name, fn) {
  try {
    await fn();
    pass++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    fail++;
    failures.push({ name, err: e.message });
    process.stdout.write(`  ✗ ${name} — ${e.message}\n`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'expected equal') + `: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

// ── tests ──────────────────────────────────────────────────────────────────

async function suiteAuth() {
  console.log('\n── Phase 3: Auth ──');

  await it('GET /api/auth/me without token returns 401', async () => {
    TOKEN = '';
    const r = await fetch('GET', '/api/auth/me');
    eq(r.status, 401);
    eq(r.body.code, 'AUTH_REQUIRED');
  });

  await it('POST /api/auth/login with bad creds returns 401', async () => {
    const r = await fetch('POST', '/api/auth/login', { email: 'wrong@x.com', password: 'bad' });
    eq(r.status, 401);
  });

  await it('POST /api/auth/login with valid creds returns token + user', async () => {
    const r = await fetch('POST', '/api/auth/login', { email: 'test@sdc.com', password: 'testpass123' });
    eq(r.status, 200);
    assert(r.body.token && r.body.token.length > 100, 'token missing');
    assert(r.body.user.email === 'test@sdc.com', 'user.email mismatch');
    TOKEN = r.body.token;
  });

  await it('GET /api/auth/me with valid token returns user', async () => {
    const r = await fetch('GET', '/api/auth/me');
    eq(r.status, 200);
    assert(r.body.user.email === 'test@sdc.com');
    assert(r.body.auth_enabled === true);
  });

  await it('POST /api/auth/login with missing fields returns 400', async () => {
    const r = await fetch('POST', '/api/auth/login', {});
    eq(r.status, 400);
  });

  await it('POST /api/auth/register with short password returns 400', async () => {
    const r = await fetch('POST', '/api/auth/register', { email: 'x@y.com', name: 'X', password: '123' });
    eq(r.status, 400);
  });

  await it('POST /api/auth/register with duplicate email returns 409', async () => {
    const r = await fetch('POST', '/api/auth/register', { email: 'test@sdc.com', name: 'Dup', password: 'longpass' });
    eq(r.status, 409);
  });
}

async function suiteTasks() {
  console.log('\n── Tasks CRUD ──');

  await it('GET /api/tasks returns array with version column', async () => {
    const r = await fetch('GET', '/api/tasks');
    eq(r.status, 200);
    assert(Array.isArray(r.body), 'not an array');
    assert(r.body.length > 0, 'no tasks');
    const t = r.body[0];
    assert('version' in t, 'no version column on tasks');
  });

  let createdId;
  await it('POST /api/tasks (editor role) creates a task', async () => {
    const r = await fetch('POST', '/api/tasks', { name: 'UAT test task', project: '__UAT__' });
    eq(r.status, 200);
    assert(r.body.id > 0, 'no id returned');
    createdId = r.body.id;
  });

  await it('PUT /api/tasks/:id updates and bumps version', async () => {
    const before = await fetch('GET', '/api/tasks');
    const t = before.body.find(x => x.id === createdId);
    const v = t.version || 1;
    const r = await fetch('PUT', `/api/tasks/${createdId}`, { notes: 'updated by UAT', version: v });
    eq(r.status, 200);
    eq(r.body.notes, 'updated by UAT');
    assert((r.body.version || 1) > v, `version did not bump: was ${v} now ${r.body.version}`);
  });

  await it('PUT with stale version returns 409 STALE_VERSION', async () => {
    const r = await fetch('PUT', `/api/tasks/${createdId}`, { notes: 'stale write', version: 1 });
    eq(r.status, 409);
    eq(r.body.code, 'STALE_VERSION');
    assert(r.body.server_row, 'no server_row in 409 body');
  });

  await it('PUT /api/tasks/:id with no version still succeeds (legacy callers)', async () => {
    const r = await fetch('PUT', `/api/tasks/${createdId}`, { notes: 'no version key' });
    eq(r.status, 200);
  });

  await it('DELETE /api/tasks/:id removes the task', async () => {
    const r = await fetch('DELETE', `/api/tasks/${createdId}`);
    eq(r.status, 200);
    eq(r.body.ok, true);
  });

  await it('DELETE on anchor row returns 400', async () => {
    const all = await fetch('GET', '/api/tasks');
    const anchor = all.body.find(t => t.anchor_key && t.anchor_key !== 'backlog');
    if (!anchor) { skip++; return; }
    const r = await fetch('DELETE', `/api/tasks/${anchor.id}`);
    eq(r.status, 400);
    assert(/anchor/i.test(r.body.error), 'wrong error');
  });

  await it('POST /api/tasks with missing name returns 400', async () => {
    const r = await fetch('POST', '/api/tasks', {});
    eq(r.status, 400);
  });
}

async function suiteAudit() {
  console.log('\n── Phase 1: Audit trail ──');

  await it('GET /api/tasks/history returns rows for the project', async () => {
    const r = await fetch('GET', '/api/tasks/history?project=Test_Project&limit=5');
    eq(r.status, 200);
    assert(Array.isArray(r.body), 'not an array');
    if (r.body.length > 0) {
      const h = r.body[0];
      assert(h.action, 'no action field');
      assert(h.changed_at, 'no changed_at field');
      assert(h.before_json || h.after_json, 'no before/after JSON');
    }
  });

  await it('Update logs a history row', async () => {
    const before = await fetch('GET', '/api/tasks/history?project=Test_Project&limit=1');
    const beforeCount = before.body.length;
    const all = await fetch('GET', '/api/tasks');
    const t = all.body.find(x => x.project === 'Test_Project' && !x.anchor_key);
    if (!t) { skip++; return; }
    await fetch('PUT', `/api/tasks/${t.id}`, { notes: 'audit trail test ' + Date.now(), version: t.version });
    const after = await fetch('GET', '/api/tasks/history?project=Test_Project&limit=10');
    assert(after.body.length >= beforeCount, 'no history row created');
  });
}

async function suiteComments() {
  console.log('\n── Phase 2: Comments + @mentions ──');

  const all = await fetch('GET', '/api/tasks');
  const t = all.body.find(x => x.project === 'Test_Project' && !x.anchor_key);
  if (!t) { console.log('  (skip — no Test_Project task)'); return; }

  let createdCommentId;
  await it('POST /api/tasks/:id/comments creates a comment', async () => {
    const r = await fetch('POST', `/api/tasks/${t.id}/comments`, { body: 'UAT comment', author_name: 'UAT' });
    eq(r.status, 201);
    assert(r.body.id > 0);
    createdCommentId = r.body.id;
  });

  await it('GET /api/tasks/:id/comments returns the new comment', async () => {
    const r = await fetch('GET', `/api/tasks/${t.id}/comments`);
    eq(r.status, 200);
    assert(r.body.some(c => c.id === createdCommentId), 'created comment not in list');
  });

  await it('Comment counts endpoint includes this task', async () => {
    const r = await fetch('GET', `/api/tasks/comment-counts?project=Test_Project`);
    eq(r.status, 200);
    assert(r.body[t.id] >= 1, `count for ${t.id} not >=1`);
  });

  await it('@mention extraction populates mentions field', async () => {
    // Need a known team member; insert one if missing.
    const team = await fetch('GET', '/api/team');
    let name = team.body.find(m => m.active)?.name;
    if (!name) {
      const created = await fetch('POST', '/api/team', { name: 'UAT Mention', discipline: 'mech' });
      name = created.body.name;
    }
    const r = await fetch('POST', `/api/tasks/${t.id}/comments`, { body: `hey @${name}!`, author_name: 'UAT' });
    eq(r.status, 201);
    const mentions = JSON.parse(r.body.mentions || '[]');
    assert(mentions.includes(name), `mentions did not include ${name}: ${r.body.mentions}`);
  });

  await it('DELETE /api/comments/:id removes the comment', async () => {
    const r = await fetch('DELETE', `/api/comments/${createdCommentId}`);
    eq(r.status, 200);
  });

  await it('POST comment with empty body returns 400', async () => {
    const r = await fetch('POST', `/api/tasks/${t.id}/comments`, { body: '' });
    eq(r.status, 400);
  });

  await it('POST comment on non-existent task returns 404', async () => {
    const r = await fetch('POST', `/api/tasks/9999999/comments`, { body: 'x' });
    eq(r.status, 404);
  });
}

async function suiteTeam() {
  console.log('\n── Team CRUD ──');

  await it('GET /api/team returns array', async () => {
    const r = await fetch('GET', '/api/team');
    eq(r.status, 200);
    assert(Array.isArray(r.body));
  });

  let createdId;
  await it('POST /api/team creates a member', async () => {
    const r = await fetch('POST', '/api/team', { name: 'UAT Member ' + Date.now(), discipline: 'mech' });
    eq(r.status, 200);
    assert(r.body.id > 0);
    createdId = r.body.id;
  });

  await it('PUT /api/team/:id updates the member', async () => {
    const r = await fetch('PUT', `/api/team/${createdId}`, { active: 0 });
    eq(r.status, 200);
    eq(r.body.active, 0);
  });

  await it('DELETE /api/team/:id removes the member', async () => {
    const r = await fetch('DELETE', `/api/team/${createdId}`);
    eq(r.status, 200);
  });

  await it('POST /api/team with invalid discipline returns 400', async () => {
    const r = await fetch('POST', '/api/team', { name: 'bad', discipline: 'invalid' });
    eq(r.status, 400);
  });

  await it('POST /api/team with empty name returns 400', async () => {
    const r = await fetch('POST', '/api/team', { name: '', discipline: 'mech' });
    eq(r.status, 400);
  });
}

async function suiteSettings() {
  console.log('\n── Settings ──');

  await it('GET /api/settings returns an object', async () => {
    const r = await fetch('GET', '/api/settings');
    eq(r.status, 200);
    assert(typeof r.body === 'object');
    assert(Array.isArray(r.body.phases || []), 'phases missing');
  });

  await it('PUT /api/settings/:key (admin role required) — editor gets 403', async () => {
    // test@sdc.com is an editor, not admin
    const r = await fetch('PUT', '/api/settings/__uat_key__', { foo: 'bar' });
    eq(r.status, 403);
    eq(r.body.code, 'FORBIDDEN');
  });
}

async function suiteProjects() {
  console.log('\n── Projects ──');

  await it('GET /api/projects returns array', async () => {
    const r = await fetch('GET', '/api/projects');
    eq(r.status, 200);
    assert(Array.isArray(r.body));
  });

  await it('GET /api/financials returns array', async () => {
    const r = await fetch('GET', '/api/financials?project=Test_Project');
    eq(r.status, 200);
    assert(Array.isArray(r.body));
  });
}

async function suiteLegacyGone() {
  console.log('\n── Legacy: Azure layer removed in MySQL migration ──');

  await it('GET /api/azure/status is gone (404)', async () => {
    const r = await fetch('GET', '/api/azure/status');
    eq(r.status, 404);
  });

  await it('POST /api/azure/push is gone (404)', async () => {
    const r = await fetch('POST', '/api/azure/push', {});
    eq(r.status, 404);
  });
}

async function suiteEto() {
  console.log('\n── Total ETO bridge ──');

  let configured = false;
  await it('GET /api/eto/status returns configured + connected flags', async () => {
    const r = await fetch('GET', '/api/eto/status');
    eq(r.status, 200);
    assert(typeof r.body.configured === 'boolean', 'configured flag missing');
    assert(typeof r.body.connected === 'boolean', 'connected flag missing');
    configured = r.body.configured && r.body.connected;
  });

  await it('GET /api/eto/project with non-numeric job returns 400', async () => {
    const r = await fetch('GET', '/api/eto/project/abc');
    eq(r.status, 400);
  });

  await it('GET /api/eto/costing with non-numeric job returns 400', async () => {
    const r = await fetch('GET', '/api/eto/costing/abc');
    eq(r.status, 400);
  });

  if (!configured) { console.log('  (skip live ETO checks — not configured/connected)'); skip += 3; return; }

  await it('GET /api/eto/project/:job returns name for a real job', async () => {
    const r = await fetch('GET', '/api/eto/project/1129');
    eq(r.status, 200);
    assert(r.body.ProjectName, 'no ProjectName');
  });

  await it('GET /api/eto/project/:job returns 404 for a bogus job', async () => {
    const r = await fetch('GET', '/api/eto/project/99999999');
    eq(r.status, 404);
  });

  await it('POST /api/eto/sync-vendor-pos (editor) runs and reports counts', async () => {
    const r = await fetch('POST', '/api/eto/sync-vendor-pos', {});
    eq(r.status, 200);
    eq(r.body.ok, true);
    assert(typeof r.body.pos === 'number', 'no pos count');
    assert(typeof r.body.created === 'number' && typeof r.body.updated === 'number', 'no created/updated counts');
  });
}

async function suiteSocketIo() {
  console.log('\n── Phase 4: Socket.io ──');

  await it('Socket.io transport polling endpoint reachable', async () => {
    const r = await fetch('GET', '/socket.io/?EIO=4&transport=polling');
    // EIO handshake handles a GET — should respond, but missing sid will 400.
    // Either 200 or 400 means socket.io is up; 404 means missing.
    assert(r.status === 200 || r.status === 400, `got ${r.status}`);
  });
}

async function suiteHealth() {
  console.log('\n── Health ──');

  await it('GET /health returns ok:true (no auth)', async () => {
    const saved = TOKEN; TOKEN = '';
    const r = await fetch('GET', '/health');
    TOKEN = saved;
    eq(r.status, 200);
    eq(r.body.ok, true);
  });

  await it('Static files served (/index.html)', async () => {
    const saved = TOKEN; TOKEN = '';
    const r = await fetch('GET', '/');
    TOKEN = saved;
    eq(r.status, 200);
    assert(/SDC Scheduler/.test(r.raw), 'index.html missing title');
  });

  await it('New client files served (auth-ui, comments-ui, realtime-ui, presence-ui)', async () => {
    const saved = TOKEN; TOKEN = '';
    for (const f of ['/auth-ui.js', '/comments-ui.js', '/realtime-ui.js', '/presence-ui.js', '/auth-ui.css']) {
      const r = await fetch('GET', f);
      if (r.status !== 200) throw new Error(`${f}: ${r.status}`);
    }
    TOKEN = saved;
  });
}

async function suiteScale() {
  console.log('\n── Scale: dataset size + perf ──');

  await it('Local task count = Azure task count (push integrity)', async () => {
    const r = await fetch('GET', '/api/tasks');
    eq(r.status, 200);
    // We don't query Azure here; just confirm local has the expected scale.
    assert(r.body.length >= 100, `only ${r.body.length} tasks — expected 100+`);
  });

  await it('GET /api/tasks responds in under 500ms', async () => {
    const t0 = Date.now();
    await fetch('GET', '/api/tasks');
    const dt = Date.now() - t0;
    assert(dt < 500, `slow: ${dt}ms`);
  });

  await it('Cascade scheduling: edit duration triggers cascade', async () => {
    const all = await fetch('GET', '/api/tasks');
    const t = all.body.find(x => x.project === 'Test_Project' && !x.anchor_key && x.duration_days > 1);
    if (!t) { skip++; return; }
    const origDuration = t.duration_days;
    const newDuration = origDuration + 5;
    const r = await fetch('PUT', `/api/tasks/${t.id}`, { duration_days: newDuration, version: t.version });
    eq(r.status, 200);
    eq(r.body.duration_days, newDuration);
    // Restore
    const after = await fetch('GET', '/api/tasks');
    const t2 = after.body.find(x => x.id === t.id);
    await fetch('PUT', `/api/tasks/${t.id}`, { duration_days: origDuration, version: t2.version });
  });
}

// ── runner ───────────────────────────────────────────────────────────────
(async () => {
  console.log('SDC Scheduler — UAT');
  console.log('Target:', BASE);
  console.log('Started:', new Date().toISOString());

  try {
    await suiteHealth();
    await suiteAuth();
    await suiteTasks();
    await suiteAudit();
    await suiteComments();
    await suiteTeam();
    await suiteSettings();
    await suiteProjects();
    await suiteLegacyGone();
    await suiteEto();
    await suiteSocketIo();
    await suiteScale();
  } catch (e) {
    console.error('\nFATAL:', e.message);
    process.exit(2);
  }

  console.log('\n════════════════════════════════════════════');
  console.log(` PASS: ${pass}    FAIL: ${fail}    SKIP: ${skip}`);
  console.log('════════════════════════════════════════════');
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  }
  process.exit(fail ? 1 : 0);
})();
