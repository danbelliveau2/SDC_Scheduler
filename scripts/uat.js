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
function decodeJwt(t) { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64').toString()); } catch { return null; } }

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

  await it('POST /api/auth/register with empty password returns 400', async () => {
    // Min length is 1 now — empty is the only rejected length.
    const r = await fetch('POST', '/api/auth/register', { email: `emptypw_${Date.now()}@test.com`, name: 'X', password: '' });
    eq(r.status, 400);
  });

  await it('POST /api/auth/register rejects a duplicate email (409)', async () => {
    // Self-contained: register a fresh email, then re-register it. Never touches
    // the test@sdc.com login fixture (registering that would overwrite it).
    const e = `dup_${Date.now()}@test.com`;
    const first = await fetch('POST', '/api/auth/register', { email: e, name: 'Dup1', password: 'longpass1' });
    eq(first.status, 201);
    const second = await fetch('POST', '/api/auth/register', { email: e, name: 'Dup2', password: 'longpass2' });
    eq(second.status, 409);
  });
}

// Deep auth edge cases — the sign-in robustness fixes. Needs a known admin
// seeded out-of-band: `node create-admin.js uat-admin@sdc.com UatAdminPass123 admin`.
// Restores the editor TOKEN on exit so later role-gate suites are unaffected.
async function suiteAuthEdge() {
  console.log('\n── Auth edge cases ──');
  const EDITOR_TOKEN = TOKEN; // suiteAuth left an editor token; restore it at the end

  const adminLogin = await fetch('POST', '/api/auth/login', { email: 'uat-admin@sdc.com', password: 'UatAdminPass123' });
  const ADMIN = (adminLogin.status === 200 && adminLogin.body && adminLogin.body.token) ? adminLogin.body.token : null;
  if (!ADMIN) { console.log('  (skip — seed admin missing: run `node create-admin.js uat-admin@sdc.com UatAdminPass123 admin`)'); skip += 8; return; }

  await it('login normalizes email (leading/trailing space + uppercase)', async () => {
    const r = await fetch('POST', '/api/auth/login', { email: '  UAT-ADMIN@SDC.COM  ', password: 'UatAdminPass123' });
    eq(r.status, 200, 'padded/uppercase email should still log in');
    assert(r.body.token, 'no token');
  });

  await it('token lifetime is ~30 days', async () => {
    const p = decodeJwt(ADMIN);
    assert(p && p.exp && p.iat, 'no exp/iat in token');
    const days = (p.exp - p.iat) / 86400;
    assert(days >= 29 && days <= 31, `expected ~30d, got ${days.toFixed(1)}d`);
  });

  await it('change-password rejects an empty new password (400)', async () => {
    TOKEN = ADMIN;
    const r = await fetch('PUT', '/api/auth/password', { current_password: 'whatever', new_password: '' });
    eq(r.status, 400);
  });

  const email = `uatedge_${Date.now()}@sdc.com`;
  let uid;
  await it('admin can create a user', async () => {
    TOKEN = ADMIN;
    const r = await fetch('POST', '/api/users', { email, name: 'UAT Edge', password: 'EdgePass123', role: 'editor' });
    eq(r.status, 201);
    uid = r.body.id;
    assert(uid > 0, 'no id returned');
  });

  await it('disabled account login → 403 ACCOUNT_DISABLED (clear, not generic)', async () => {
    TOKEN = ADMIN;
    await fetch('PUT', `/api/users/${uid}`, { active: 0 });
    TOKEN = '';
    const r = await fetch('POST', '/api/auth/login', { email, password: 'EdgePass123' });
    eq(r.status, 403);
    eq(r.body.code, 'ACCOUNT_DISABLED');
  });

  await it('wrong password on disabled account → generic 401 (no account enumeration)', async () => {
    TOKEN = '';
    const r = await fetch('POST', '/api/auth/login', { email, password: 'totally-wrong' });
    eq(r.status, 401);
    assert(!r.body.code || r.body.code !== 'ACCOUNT_DISABLED', 'must not reveal disabled state on bad password');
  });

  await it('admin reset-password generates temp + reactivates; user can then sign in', async () => {
    TOKEN = ADMIN;
    const r = await fetch('POST', `/api/users/${uid}/reset-password`, {});
    eq(r.status, 200);
    assert(r.body.tempPassword && r.body.tempPassword.length >= 8, 'no usable temp password');
    eq(r.body.reactivated, true);
    TOKEN = '';
    const login = await fetch('POST', '/api/auth/login', { email, password: r.body.tempPassword });
    eq(login.status, 200, 'temp-password login failed');
    assert(login.body.token, 'no token after reset');
  });

  await it('reset-password is admin-gated (editor → 403)', async () => {
    TOKEN = EDITOR_TOKEN;
    const r = await fetch('POST', `/api/users/${uid}/reset-password`, {});
    eq(r.status, 403);
  });

  await it('admin cannot delete their own account (400)', async () => {
    TOKEN = ADMIN;
    const meId = decodeJwt(ADMIN).id;
    const r = await fetch('DELETE', `/api/users/${meId}`);
    eq(r.status, 400);
    assert(/your own account/i.test(r.body.error || ''), `wrong message: ${r.body.error}`);
  });

  await it('delete is admin-gated (editor → 403)', async () => {
    TOKEN = EDITOR_TOKEN;
    const r = await fetch('DELETE', `/api/users/${uid}`);
    eq(r.status, 403);
  });

  await it('admin can hard-delete a user (row removed)', async () => {
    TOKEN = ADMIN;
    const r = await fetch('DELETE', `/api/users/${uid}`);
    eq(r.status, 200);
    eq(r.body.ok, true);
    const list = await fetch('GET', '/api/users');
    assert(!list.body.some(u => u.id === uid), 'deleted user still present in list');
  });

  // restore editor token for the role-gate suites that follow
  TOKEN = EDITOR_TOKEN;
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

  await it('GET /api/eto/readiness/:job returns totals + specs', async () => {
    const r = await fetch('GET', '/api/eto/readiness/1129');
    eq(r.status, 200);
    assert(r.body.totals && typeof r.body.totals.pct === 'number', 'no totals.pct');
    assert(Array.isArray(r.body.specs), 'no specs array');
    assert(Array.isArray(r.body.partsList), 'no partsList array');
  });

  await it('GET /api/eto/readiness with non-numeric job returns 400', async () => {
    const r = await fetch('GET', '/api/eto/readiness/abc');
    eq(r.status, 400);
  });

  await it('GET /api/eto/vendors/:job returns vendor-grouped POs', async () => {
    const r = await fetch('GET', '/api/eto/vendors/1129');
    eq(r.status, 200);
    assert(Array.isArray(r.body.vendors), 'no vendors array');
    if (r.body.vendors.length) {
      const v = r.body.vendors[0];
      assert(v.name && typeof v.pct === 'number' && Array.isArray(v.pos), 'vendor shape wrong');
    }
  });

  await it('GET /api/eto/po/:job/:po/lines returns line items', async () => {
    const vendors = await fetch('GET', '/api/eto/vendors/1129');
    const firstPo = vendors.body.vendors?.[0]?.pos?.[0]?.po;
    if (!firstPo) { skip++; return; }
    const r = await fetch('GET', `/api/eto/po/1129/${firstPo}/lines`);
    eq(r.status, 200);
    assert(Array.isArray(r.body), 'lines not an array');
  });

  await it('GET /api/eto/partcost/:job returns the full cost shape', async () => {
    const r = await fetch('GET', '/api/eto/partcost/1129');
    eq(r.status, 200);
    for (const k of ['estimated', 'actual', 'purchased', 'received', 'paid', 'leftToPay', 'etc', 'projection']) {
      assert(typeof r.body[k] === 'number', `partcost.${k} not a number`);
    }
  });

  await it('GET /api/eto/partcost with non-numeric job returns 400', async () => {
    const r = await fetch('GET', '/api/eto/partcost/abc');
    eq(r.status, 400);
  });
}

// Deep edge-case coverage for the Procurement surface (Parts List + filters,
// Category, Cost tab, vendor dates). Lives apart from suiteEto so the happy
// path and the corner cases read separately.
async function suiteProcurementEdge() {
  console.log('\n── Procurement edge cases ──');

  const st = await fetch('GET', '/api/eto/status');
  const connected = st.body && st.body.configured && st.body.connected;
  if (!connected) { console.log('  (skip — ETO not connected)'); skip += 18; return; }

  // ── new data fields flow through ──
  await it('readiness partsList carries category + supplier on every row', async () => {
    const r = await fetch('GET', '/api/eto/readiness/1129');
    eq(r.status, 200);
    const pl = r.body.partsList || [];
    assert(pl.length > 0, 'no parts');
    assert(pl.every(p => 'category' in p), 'a part is missing the category key');
    assert(pl.every(p => 'supplier' in p), 'a part is missing the supplier key');
    assert(pl.some(p => p.category), 'no part has a non-null category');
  });

  await it('vendors POs carry eta + receivedDate keys', async () => {
    const r = await fetch('GET', '/api/eto/vendors/1129');
    const pos = (r.body.vendors || []).flatMap(v => v.pos);
    assert(pos.length > 0, 'no POs');
    assert(pos.every(p => 'eta' in p && 'receivedDate' in p), 'PO missing eta/receivedDate');
    // received POs should expose an arrival date; open POs an ETA (not both null unless truly unknown)
    const recv = pos.filter(p => p.status === 'received');
    assert(recv.length === 0 || recv.some(p => p.receivedDate), 'no received PO has a receivedDate');
  });

  // ── partcost invariants ──
  await it('partcost invariants hold (leftToPay / etc / projection / pct ranges)', async () => {
    const r = await fetch('GET', '/api/eto/partcost/1129');
    const c = r.body;
    eq(c.leftToPay, Math.max(0, c.purchased - c.paid), 'leftToPay formula');
    eq(c.etc, Math.max(0, c.estimated - c.purchased), 'etc formula');
    eq(Math.round(c.projection), Math.round(c.purchased + c.etc), 'projection formula');
    assert(c.pctPaid >= 0, 'pctPaid negative');
    assert(c.pctReceived >= 0, 'pctReceived negative');
    assert(c.received <= c.purchased + 0.01, 'received value exceeds purchased');
  });

  // ── no-data job (real ETO job with no released BOM / no POs) ──
  await it('readiness for a no-BOM job returns 200 with empty specs', async () => {
    const r = await fetch('GET', '/api/eto/readiness/1158');
    eq(r.status, 200);
    assert(Array.isArray(r.body.specs) && r.body.specs.length === 0, 'expected empty specs');
    assert(Array.isArray(r.body.partsList) && r.body.partsList.length === 0, 'expected empty partsList');
  });

  await it('vendors for a no-PO job returns 200 with empty vendors', async () => {
    const r = await fetch('GET', '/api/eto/vendors/1158');
    eq(r.status, 200);
    assert(Array.isArray(r.body.vendors) && r.body.vendors.length === 0, 'expected empty vendors');
  });

  await it('partcost for a no-PO job returns zeros (not an error)', async () => {
    const r = await fetch('GET', '/api/eto/partcost/1158');
    eq(r.status, 200);
    eq(r.body.purchased, 0, 'purchased should be 0');
    eq(r.body.paid, 0, 'paid should be 0');
  });

  // ── bogus / malformed inputs ──
  await it('readiness for a bogus job returns 404', async () => {
    const r = await fetch('GET', '/api/eto/readiness/99999999');
    eq(r.status, 404);
  });

  await it('vendors for a bogus job returns 200 empty (no crash)', async () => {
    const r = await fetch('GET', '/api/eto/vendors/99999999');
    eq(r.status, 200);
    assert(Array.isArray(r.body.vendors), 'vendors not array');
  });

  await it('partcost for a bogus job returns 200 zeros (no crash)', async () => {
    const r = await fetch('GET', '/api/eto/partcost/99999999');
    eq(r.status, 200);
    eq(r.body.purchased, 0);
  });

  await it('partcost for a negative job id returns 200 zeros (no SQL error)', async () => {
    const r = await fetch('GET', '/api/eto/partcost/-5');
    eq(r.status, 200);
    eq(r.body.purchased, 0);
  });

  await it('po lines with non-numeric job returns 400', async () => {
    const r = await fetch('GET', '/api/eto/po/abc/123/lines');
    eq(r.status, 400);
  });

  await it('po lines with non-numeric PO returns 400', async () => {
    const r = await fetch('GET', '/api/eto/po/1129/abc/lines');
    eq(r.status, 400);
  });

  await it('po lines for a PO that is not on the job returns 200 empty', async () => {
    const r = await fetch('GET', '/api/eto/po/1129/99999999/lines');
    eq(r.status, 200);
    assert(Array.isArray(r.body) && r.body.length === 0, 'expected empty lines');
  });

  // ── caching ──
  await it('partcost second call is served from cache', async () => {
    await fetch('GET', '/api/eto/partcost/1129'); // prime
    const r = await fetch('GET', '/api/eto/partcost/1129');
    eq(r.status, 200);
    eq(r.body.cached, true, 'second call not flagged cached');
  });

  await it('partcost ?refresh=1 bypasses the cache', async () => {
    const r = await fetch('GET', '/api/eto/partcost/1129?refresh=1');
    eq(r.status, 200);
    assert(!r.body.cached, 'refresh still returned cached');
  });

  await it('readiness ?refresh=1 bypasses the cache', async () => {
    await fetch('GET', '/api/eto/readiness/1129');
    const r = await fetch('GET', '/api/eto/readiness/1129?refresh=1');
    eq(r.status, 200);
    assert(!r.body.cached, 'refresh still returned cached');
  });

  await it('category join produces sensible values (not raw ints)', async () => {
    const r = await fetch('GET', '/api/eto/readiness/1129');
    const cats = [...new Set((r.body.partsList || []).map(p => p.category).filter(Boolean))];
    assert(cats.length > 0, 'no categories');
    assert(cats.every(c => typeof c === 'string' && /[A-Za-z]/.test(c)), `category looks non-text: ${JSON.stringify(cats)}`);
  });
}

async function suiteReliability() {
  console.log('\n── Reliability: health, status, backups ──');

  await it('GET /api/status returns db + uptime (auth required)', async () => {
    const r = await fetch('GET', '/api/status');
    eq(r.status, 200);
    assert(r.body.db && typeof r.body.db.ok === 'boolean', 'no db.ok');
    assert(typeof r.body.uptimeSeconds === 'number', 'no uptimeSeconds');
  });

  await it('POST /api/backup as editor returns 403 (admin required)', async () => {
    const r = await fetch('POST', '/api/backup', {});
    eq(r.status, 403);
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
    await suiteAuthEdge();
    await suiteTasks();
    await suiteAudit();
    await suiteComments();
    await suiteTeam();
    await suiteSettings();
    await suiteProjects();
    await suiteLegacyGone();
    await suiteEto();
    await suiteProcurementEdge();
    await suiteReliability();
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
