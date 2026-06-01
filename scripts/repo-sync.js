'use strict';

/**
 * SDC_Scheduler/scripts/repo-sync.js
 *
 * Runs every 2 min. If the auto-updater has pulled new files from
 * danbelliveau2/SDC_Scheduler (public/, db.js, etc.) those appear as
 * unstaged changes in the centralized library repo. This script stages,
 * commits, and pushes them so the centralized repo always matches Dan's
 * version exactly.
 *
 * PM2 name: sdc-scheduler-repo-sync
 */

const { execSync } = require('child_process');
const path         = require('path');

const REPO_ROOT      = path.join(__dirname, '..', '..');
const CHECK_INTERVAL = 2 * 60 * 1000;

const SYNC_PATHS = [
  'SDC_Scheduler/public',
  'SDC_Scheduler/db.js',
  'SDC_Scheduler/ARROW_ROUTING_RULES.md',
  'SDC_Scheduler/.gitignore',
];

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [scheduler-repo-sync] ${msg}`);
}

function git(args) {
  return execSync(`git -C "${REPO_ROOT}" ${args}`, { stdio: 'pipe' }).toString().trim();
}

function hasChanges() {
  try {
    git(`add ${SYNC_PATHS.join(' ')}`);
    execSync(`git -C "${REPO_ROOT}" diff --cached --quiet`, { stdio: 'pipe' });
    // exit 0 = no staged changes
    git('restore --staged .');
    return false;
  } catch {
    // exit 1 = staged changes present
    return true;
  }
}

async function syncRepo() {
  log('Checking for uncommitted scheduler changes…');
  try {
    // Stage the tracked paths
    git(`add ${SYNC_PATHS.join(' ')}`);

    // Check if anything is actually staged
    let staged = true;
    try { execSync(`git -C "${REPO_ROOT}" diff --cached --quiet`, { stdio: 'pipe' }); staged = false; }
    catch { staged = true; }

    if (!staged) {
      log('Nothing to commit — repo already in sync with Dan\'s version.');
      return;
    }

    // Read the SHA the updater last synced to
    const fs = require('fs');
    const shaFile = path.join(__dirname, '..', '.update-sha');
    const danSha  = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, 'utf8').trim().slice(0, 7) : 'unknown';

    git(`commit -m "chore(scheduler): sync from danbelliveau2@${danSha}"`);

    // Pull latest before push to avoid fast-forward failures
    try { git('pull --rebase origin master'); } catch (e) { log(`Pull warning: ${e.message}`); }

    git('push origin master');
    log(`Committed and pushed scheduler sync (danbelliveau2@${danSha}).`);

  } catch (e) {
    log(`Sync error: ${e.message}`);
  }
}

log('SDC Scheduler repo-sync started');
log(`Repo root: ${REPO_ROOT}`);
log(`Check interval: ${CHECK_INTERVAL / 60000} min`);

syncRepo();
setInterval(syncRepo, CHECK_INTERVAL);
