'use strict';

/**
 * scripts/server-auto-update.js
 *
 * Polls danbelliveau2/SDC_Scheduler (upstream) for new commits every 2 min.
 * On change: git fetch + git merge --ff-only, then npm install if package.json
 * changed, then pm2 restart.
 *
 * Using git merge instead of tarball overwrite means:
 *   - Abhi's local commits are NEVER destroyed (merge, not reset)
 *   - Conflicts stop the auto-update and log a clear error (no silent data loss)
 *   - Full git history is preserved on both sides
 *
 * Manual trigger: POST http://<host>:4013/trigger
 */

const https        = require('https');
const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const UPSTREAM_REPO  = 'danbelliveau2/SDC_Scheduler';
const UPSTREAM_BRANCH = 'main';
const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const APP_DIR        = path.join(__dirname, '..');
const SHA_FILE       = path.join(APP_DIR, '.update-sha');
const PM2_APP_NAMES  = ['sdc-scheduler'];

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [scheduler-updater] ${msg}`);
}

function getStoredSha() {
  try { return fs.readFileSync(SHA_FILE, 'utf8').trim(); } catch { return null; }
}
function storeSha(sha) { fs.writeFileSync(SHA_FILE, sha, 'utf8'); }

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
  // Use git ls-remote — avoids GitHub API rate limits.
  const out = run(
    `git ls-remote https://github.com/${UPSTREAM_REPO}.git refs/heads/${UPSTREAM_BRANCH}`,
    { timeout: 15000 }
  );
  const sha = out.split(/\s+/)[0];
  if (!sha || sha.length < 10) throw new Error('Could not parse remote SHA');
  return sha;
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

  if (!storedSha) {
    log('First run — recording current SHA, no update needed.');
    storeSha(remoteSha);
    return;
  }

  if (storedSha === remoteSha) {
    log('Already up to date.');
    return;
  }

  log(`Update available (${storedSha.slice(0, 7)} → ${remoteSha.slice(0, 7)}). Merging…`);

  try {
    // Ensure upstream remote is configured (idempotent).
    try {
      run('git remote get-url upstream');
    } catch {
      run(`git remote add upstream https://github.com/${UPSTREAM_REPO}.git`);
      log('Registered upstream remote.');
    }

    // Fetch latest from upstream.
    run(`git fetch upstream ${UPSTREAM_BRANCH}`);
    log('Fetched upstream.');

    // Record package.json hash before merge so we know if deps changed.
    const pkgBefore = (() => {
      try { return fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'); } catch { return ''; }
    })();

    // Merge — fast-forward preferred, fall back to true merge.
    // --no-edit so it never blocks waiting for a commit message.
    // If there are conflicts this throws, which we catch below.
    try {
      run(`git merge upstream/${UPSTREAM_BRANCH} --no-edit --ff`);
    } catch {
      run(`git merge upstream/${UPSTREAM_BRANCH} --no-edit`);
    }
    log('Merge complete.');

    // Push merged result back to origin (Dan's repo) so the fork stays in sync.
    try {
      run('git push origin main');
      log('Pushed to origin.');
    } catch (e) {
      log(`Push to origin skipped or failed (non-fatal): ${e.message}`);
    }

    // If package.json changed, reinstall deps.
    const pkgAfter = (() => {
      try { return fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'); } catch { return ''; }
    })();
    if (pkgBefore !== pkgAfter) {
      log('package.json changed — running npm install…');
      run('npm install');
    }

    // Restart PM2 processes.
    for (const name of PM2_APP_NAMES) {
      log(`Restarting ${name}…`);
      try { run(`pm2 restart ${name} --update-env`); }
      catch (e) { log(`pm2 restart warning (${name}): ${e.message}`); }
    }

    storeSha(remoteSha);
    log(`Successfully updated to ${remoteSha.slice(0, 7)}!`);

  } catch (e) {
    log(`Update FAILED: ${e.message}`);
    // If merge left conflicts, abort so the working tree stays clean.
    try { run('git merge --abort'); log('Aborted incomplete merge.'); } catch {}
    if (e.stack) log(e.stack.split('\n').slice(1, 3).join(' '));
  }
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

// ─── manual trigger server ────────────────────────────────────────────────────
const TRIGGER_PORT = 4013;
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/trigger') {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    checkAndUpdate().catch(e => log(`Manual trigger error: ${e.message}`));
  } else {
    res.writeHead(404); res.end();
  }
}).listen(TRIGGER_PORT, '0.0.0.0', () => log(`Trigger server listening on :${TRIGGER_PORT}`));
