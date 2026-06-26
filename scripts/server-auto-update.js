'use strict';

/**
 * scripts/server-auto-update.js
 *
 * Polls origin/main (danbelliveau2/SDC_Scheduler) every 2 min.
 * On new commit: git pull, npm install if needed, pm2 restart.
 *
 * Both Dan and Abhi push to main. The server is a pure consumer —
 * it never has local changes, never pushes back, never merges cross-branch.
 *
 * Manual trigger: POST http://<host>:4013/trigger
 */

const https        = require('https');
const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const UPSTREAM_REPO     = 'danbelliveau2/SDC_Scheduler';
const UPSTREAM_BRANCH   = 'main';
const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const APP_DIR           = path.join(__dirname, '..');
const SHA_FILE          = path.join(APP_DIR, '.update-sha');
const PM2_APP_NAMES     = ['sdc-scheduler'];

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [scheduler-updater] ${msg}`);
}

function getStoredSha() { try { return fs.readFileSync(SHA_FILE, 'utf8').trim(); } catch { return null; } }
function storeSha(sha)   { fs.writeFileSync(SHA_FILE, sha, 'utf8'); }

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

async function restartPm2(name) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      run(`pm2 restart ${name} --update-env`);
      log(`Restarted ${name}.`);
      return;
    } catch (e) {
      log(`pm2 restart warning (${name}, attempt ${attempt}/3): ${e.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }
  }
  log(`ERROR: pm2 restart failed 3 times for ${name} — server running old code. Manual restart required.`);
}

async function checkAndUpdate() {
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

  if (storedSha === remoteSha) {
    log('Already up to date.');
    return;
  }

  log(`Update available (${storedSha ? storedSha.slice(0, 7) : 'none'} → ${remoteSha.slice(0, 7)}). Pulling…`);

  const pkgBefore = (() => { try { return fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'); } catch { return ''; } })();
  const prePullHead = run('git rev-parse HEAD');

  try {
    run(`git fetch origin ${UPSTREAM_BRANCH}`);
    run(`git reset --hard origin/${UPSTREAM_BRANCH}`);
    log('Pull complete.');
  } catch (e) {
    log(`Pull FAILED: ${e.message}`);
    log(`Restoring previous state…`);
    try { run(`git reset --hard ${prePullHead}`); } catch {}
    return;
  }

  const pkgAfter = (() => { try { return fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'); } catch { return ''; } })();
  if (pkgBefore !== pkgAfter) {
    log('package.json changed — running npm install…');
    try {
      run('npm install', { timeout: 120000 });
      log('npm install succeeded.');
    } catch (e) {
      log(`npm install FAILED: ${e.message}`);
      log(`Rolling back to ${prePullHead.slice(0, 7)}…`);
      try { run(`git reset --hard ${prePullHead}`); log('Rollback complete.'); } catch (re) {
        log(`Rollback also failed: ${re.message} — MANUAL INTERVENTION REQUIRED.`);
      }
      return;
    }
  }

  for (const name of PM2_APP_NAMES) {
    await restartPm2(name);
  }

  storeSha(remoteSha);
  log(`Successfully updated to ${remoteSha.slice(0, 7)}!`);
}

// ── Trigger server (port 4013) ────────────────────────────────────────────────
function startTriggerServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/trigger') {
      log('Manual trigger received.');
      res.writeHead(200);
      res.end('ok');
      checkAndUpdate().catch(e => log(`Trigger error: ${e.message}`));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  server.listen(4013, '127.0.0.1', () => log('Trigger server listening on port 4013'));
  server.on('error', e => log(`Trigger server error: ${e.message}`));
}

async function main() {
  log('SDC Scheduler — auto-updater started');
  log(`Watching: https://github.com/${UPSTREAM_REPO}/tree/${UPSTREAM_BRANCH}`);
  log(`Interval: ${CHECK_INTERVAL_MS / 60000} min`);
  startTriggerServer();
  await checkAndUpdate();
  setInterval(() => checkAndUpdate().catch(e => log(`Tick error: ${e.message}`)), CHECK_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
