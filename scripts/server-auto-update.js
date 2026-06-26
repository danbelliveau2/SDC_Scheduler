'use strict';

/**
 * scripts/server-auto-update.js
 *
 * Polls danbelliveau2/SDC_Scheduler (upstream) for new commits every 2 min.
 * On change: git fetch + git merge, then npm install if package.json changed,
 * then pm2 restart.
 *
 * Fixes applied:
 *   #8  — First run now checks if local is behind upstream and merges if so
 *   #10 — Merge conflict: stops retrying after 3 consecutive failures, requires manual reset
 *   #12 — Push-back failure: retried next poll, tracked separately, never silent
 *   #13 — PM2 restart: retried 3 times with delay before giving up
 *   #14 — npm install failure: rolls back the merge via git reset --hard, stays on old code
 *
 * Manual trigger: POST http://<host>:4013/trigger
 * Reset conflict lock: POST http://<host>:4013/reset-conflict
 */

const https        = require('https');
const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const UPSTREAM_REPO      = 'danbelliveau2/SDC_Scheduler';
const UPSTREAM_BRANCH    = 'main';
const CHECK_INTERVAL_MS  = 2 * 60 * 1000;
const APP_DIR            = path.join(__dirname, '..');
const SHA_FILE           = path.join(APP_DIR, '.update-sha');
const CONFLICT_FILE      = path.join(APP_DIR, '.update-conflict');  // fix #10
const PUSH_PENDING_FILE  = path.join(APP_DIR, '.push-pending');     // fix #12
const MAX_CONFLICT_FAILS = 3;                                        // fix #10
const PM2_APP_NAMES      = ['sdc-scheduler'];

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [scheduler-updater] ${msg}`);
}

function getStoredSha()   { try { return fs.readFileSync(SHA_FILE, 'utf8').trim(); }    catch { return null; } }
function storeSha(sha)    { fs.writeFileSync(SHA_FILE, sha, 'utf8'); }

// fix #10 — conflict lock
function getConflictCount() { try { return parseInt(fs.readFileSync(CONFLICT_FILE, 'utf8').trim(), 10) || 0; } catch { return 0; } }
function bumpConflictCount() { fs.writeFileSync(CONFLICT_FILE, String(getConflictCount() + 1), 'utf8'); }
function clearConflictLock() { try { fs.unlinkSync(CONFLICT_FILE); } catch {} }

// fix #12 — push-pending flag
function setPushPending(sha) { fs.writeFileSync(PUSH_PENDING_FILE, sha, 'utf8'); }
function getPushPending()    { try { return fs.readFileSync(PUSH_PENDING_FILE, 'utf8').trim(); } catch { return null; } }
function clearPushPending()  { try { fs.unlinkSync(PUSH_PENDING_FILE); } catch {} }

function run(cmd, opts = {}) {
  try {
    const out = execSync(cmd, {
      cwd: opts.cwd || APP_DIR,
      stdio: 'pipe',
      timeout: opts.timeout || 60000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return out ? out.toString().trim() : '';
  } catch (e) {
    const detail = [e.stderr, e.stdout].map(b => b && b.toString().trim()).filter(Boolean).join('\n');
    throw new Error(`Command failed: ${cmd}\n${detail}`);
  }
}

function getRemoteSha() {
  const out = run(
    `git ls-remote https://github.com/${UPSTREAM_REPO}.git refs/heads/${UPSTREAM_BRANCH}`,
    { timeout: 15000 }
  );
  const sha = out.split(/\s+/)[0];
  if (!sha || sha.length < 10) throw new Error('Could not parse remote SHA');
  return sha;
}

// fix #13 — retry PM2 restart up to 3 times
async function restartPm2(name) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      run(`pm2 restart ${name} --update-env`);
      log(`Restarted ${name} (attempt ${attempt}).`);
      return;
    } catch (e) {
      log(`pm2 restart warning (${name}, attempt ${attempt}/3): ${e.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }
  }
  log(`ERROR: pm2 restart failed 3 times for ${name} — server is running old code. Manual restart required.`);
}

async function checkAndUpdate() {

  // fix #12 — retry pending push FIRST, before conflict lock check.
  // A pending push belongs to a previously SUCCESSFUL merge — it must not
  // be blocked by a conflict that happened on a later poll.
  const pushPending = getPushPending();
  if (pushPending) {
    log(`Retrying pending push to origin (SHA ${pushPending.slice(0, 7)})…`);
    try {
      run('git push origin main');
      log('Pending push succeeded.');
      clearPushPending();
    } catch (e) {
      log(`Pending push still failing: ${e.message}`);
    }
  }

  const storedSha = getStoredSha();
  log(`Checking upstream… (last known: ${storedSha ? storedSha.slice(0, 7) : 'none'})`);

  let remoteSha;
  try {
    remoteSha = getRemoteSha();
  } catch (e) {
    log(`Could not read remote SHA: ${e.message}`);
    return;
  }

  log(`Upstream SHA: ${remoteSha.slice(0, 7)}`);

  // fix #8 — on first run, check if local is actually behind and merge if so
  if (!storedSha) {
    const localSha = run('git rev-parse HEAD');
    if (localSha === remoteSha) {
      log('First run — already up to date. Recording SHA.');
      storeSha(remoteSha);
      return;
    }
    log(`First run — local (${localSha.slice(0, 7)}) is behind upstream (${remoteSha.slice(0, 7)}). Merging now instead of skipping.`);
    // fall through to merge logic below
  } else if (storedSha === remoteSha) {
    log('Already up to date.');
    return;
  } else {
    log(`Update available (${storedSha.slice(0, 7)} → ${remoteSha.slice(0, 7)}). Merging…`);
  }

  // fix #10 — stop retrying merges if conflict count exceeded (push retry above is exempt)
  const conflictCount = getConflictCount();
  if (conflictCount >= MAX_CONFLICT_FAILS) {
    log(`CONFLICT LOCK ACTIVE (${conflictCount} consecutive failures). Auto-update suspended.`);
    log(`Fix the conflict manually, then POST /reset-conflict to resume.`);
    log(`Steps: cd ${APP_DIR} && git status && git merge --abort (if needed) && git merge upstream/main`);
    return;
  }

  // Ensure upstream remote exists
  try {
    run('git remote get-url upstream');
  } catch {
    run(`git remote add upstream https://github.com/${UPSTREAM_REPO}.git`);
    log('Registered upstream remote.');
  }

  run(`git fetch upstream ${UPSTREAM_BRANCH}`);
  log('Fetched upstream.');

  const pkgBefore = (() => { try { return fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'); } catch { return ''; } })();

  // Record pre-merge HEAD so we can roll back on npm failure (fix #14)
  const preMergeHead = run('git rev-parse HEAD');

  // Auto-commit any uncommitted local changes so merge can always proceed
  try {
    const dirty = run('git status --porcelain');
    if (dirty) {
      run('git add -A');
      run('git commit -m "chore: auto-commit local changes before upstream merge"');
      log('Auto-committed local changes before merge.');
    }
  } catch (e) {
    log(`Auto-commit warning: ${e.message} — proceeding anyway.`);
  }

  // Attempt merge
  try {
    try {
      run(`git merge upstream/${UPSTREAM_BRANCH} --no-edit --ff`);
    } catch {
      run(`git merge upstream/${UPSTREAM_BRANCH} --no-edit`);
    }
    log('Merge complete.');
    clearConflictLock();
  } catch (e) {
    log(`Merge FAILED: ${e.message}`);
    try { run('git merge --abort'); log('Aborted incomplete merge.'); } catch {}
    bumpConflictCount();
    const newCount = getConflictCount();
    log(`Consecutive conflict failures: ${newCount}/${MAX_CONFLICT_FAILS}.`);
    if (newCount >= MAX_CONFLICT_FAILS) {
      log(`CONFLICT LOCK engaged — auto-update suspended until manual fix + POST /reset-conflict.`);
    }
    return;
  }

  // fix #14 — npm install failure rolls back the merge
  const pkgAfter = (() => { try { return fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'); } catch { return ''; } })();
  if (pkgBefore !== pkgAfter) {
    log('package.json changed — running npm install…');
    try {
      run('npm install', { timeout: 120000 });
      log('npm install succeeded.');
    } catch (e) {
      log(`npm install FAILED: ${e.message}`);
      log(`Rolling back merge to ${preMergeHead.slice(0, 7)} to keep server stable…`);
      try {
        run(`git reset --hard ${preMergeHead}`);
        log('Rollback complete. Server stays on previous version. Fix the dependency issue in the upstream commit.');
      } catch (re) {
        log(`Rollback also failed: ${re.message} — MANUAL INTERVENTION REQUIRED.`);
      }
      return;
    }
  }

  // fix #12 — push back to origin with explicit retry tracking
  try {
    run('git push origin main');
    log('Pushed to origin.');
    clearPushPending();
  } catch (e) {
    log(`Push to origin FAILED: ${e.message}`);
    log(`Will retry push on next poll. Local server will still be updated.`);
    setPushPending(remoteSha); // fix #12 — flag for retry next poll
  }

  // fix #13 — restart PM2 with retry
  for (const name of PM2_APP_NAMES) {
    await restartPm2(name);
  }

  storeSha(remoteSha);
  log(`Successfully updated to ${remoteSha.slice(0, 7)}!`);
}

// ─── entry ────────────────────────────────────────────────────────────────────

async function main() {
  log('SDC Scheduler — git-based auto-updater started');
  log(`Watching: https://github.com/${UPSTREAM_REPO}/tree/${UPSTREAM_BRANCH}`);
  log(`Interval: ${CHECK_INTERVAL_MS / 60000} min`);
  await checkAndUpdate();
  setInterval(() => checkAndUpdate().catch(e => log(`Tick error: ${e.message}`)), CHECK_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });

// ─── manual trigger + control server ─────────────────────────────────────────
const TRIGGER_PORT = 4013;
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/trigger') {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, msg: 'Update check triggered' }));
    checkAndUpdate().catch(e => log(`Manual trigger error: ${e.message}`));

  } else if (req.method === 'POST' && req.url === '/reset-conflict') {
    // fix #10 — manual escape hatch after resolving a conflict
    clearConflictLock();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, msg: 'Conflict lock cleared. Auto-update will resume on next poll.' }));
    log('Conflict lock cleared via /reset-conflict endpoint.');

  } else {
    res.writeHead(404); res.end();
  }
}).listen(TRIGGER_PORT, '0.0.0.0', () => log(`Trigger server listening on :${TRIGGER_PORT}`));
