#!/usr/bin/env node
'use strict';
/**
 * scripts/auto-pull.js — keep this local clone in sync with origin/main.
 *
 * Polls GitHub every 2 min (configurable). When the remote `main` advances:
 *   1. Skips if there are uncommitted changes (your edits never get clobbered).
 *   2. Skips if you have local commits ahead of origin (those need an
 *      explicit push or merge first — no surprise rebase).
 *   3. Fast-forward merges `origin/main` into local `main`.
 *   4. Logs the new commits to scripts/auto-pull.log.
 *
 * Start it once, leave it running:
 *   node scripts/auto-pull.js          # foreground (Ctrl-C to stop)
 *   node scripts/auto-pull.js &        # background (nohup-style)
 *
 * On Windows, easiest is PM2:
 *   npm i -g pm2
 *   pm2 start scripts/auto-pull.js --name sdc-auto-pull
 *   pm2 save && pm2 startup
 *
 * Environment:
 *   AUTO_PULL_INTERVAL_MS  default 120000 (2 min)
 *   AUTO_PULL_BRANCH       default 'main'
 *   AUTO_PULL_REMOTE       default 'origin'
 */
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

const REPO        = path.join(__dirname, '..');
const REMOTE      = process.env.AUTO_PULL_REMOTE   || 'origin';
const BRANCH      = process.env.AUTO_PULL_BRANCH   || 'main';
const INTERVAL_MS = Number(process.env.AUTO_PULL_INTERVAL_MS) || 120 * 1000;
const LOG_PATH    = path.join(__dirname, 'auto-pull.log');

function log(msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) {}
}

function git(args) {
  try { return execSync(`git ${args}`, { cwd: REPO, encoding: 'utf8' }).trim(); }
  catch (e) { return null; }
}

function hasUncommittedChanges() {
  const status = git('status --porcelain');
  return status === null || status.length > 0;
}

function localAheadCount() {
  const out = git(`rev-list --count ${REMOTE}/${BRANCH}..${BRANCH}`);
  return Number(out) || 0;
}

function remoteAheadCount() {
  const out = git(`rev-list --count ${BRANCH}..${REMOTE}/${BRANCH}`);
  return Number(out) || 0;
}

function check() {
  // Fetch silently — no merge.
  const fetch = git(`fetch ${REMOTE} ${BRANCH}`);
  if (fetch === null) {
    log('git fetch failed (network? auth? skipping this tick)');
    return;
  }

  const ahead  = localAheadCount();
  const behind = remoteAheadCount();

  if (behind === 0) {
    return; // nothing new upstream — silent, no log spam
  }

  if (hasUncommittedChanges()) {
    log(`Remote has ${behind} new commit(s) but local has uncommitted edits — skipping pull.`);
    return;
  }

  if (ahead > 0) {
    log(`Remote has ${behind} new commit(s) and local is ${ahead} ahead — skipping (push or rebase manually).`);
    return;
  }

  // Show what's about to land
  const incoming = git(`log --oneline ${BRANCH}..${REMOTE}/${BRANCH}`);
  log(`Pulling ${behind} new commit(s) from ${REMOTE}/${BRANCH}:`);
  if (incoming) for (const line of incoming.split('\n')) log('  ' + line);

  const result = git(`merge --ff-only ${REMOTE}/${BRANCH}`);
  if (result === null) {
    log('git merge --ff-only failed — repo may need manual attention.');
  } else {
    log(`Up to date with ${REMOTE}/${BRANCH}.`);
  }
}

function main() {
  log(`SDC Scheduler — auto-pull started`);
  log(`Watching ${REMOTE}/${BRANCH} every ${Math.round(INTERVAL_MS / 1000)}s`);
  log(`Repo: ${REPO}`);
  check();                  // run immediately on boot
  setInterval(check, INTERVAL_MS);
}

main();
