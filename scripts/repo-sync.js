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
const fs   = require('fs');
const path = require('path');

const REPO_ROOT      = path.join(__dirname, '..', '..');
const CHECK_INTERVAL = 2 * 60 * 1000;

const SYNC_PATHS = [
  'SDC_Scheduler/public',
  'SDC_Scheduler/auth.js',
  'SDC_Scheduler/emailService.js',
  'SDC_Scheduler/db.js',
  'SDC_Scheduler/package.json',
  'SDC_Scheduler/package-lock.json',
  'SDC_Scheduler/ARROW_ROUTING_RULES.md',
  'SDC_Scheduler/.gitignore',
];

// PM2 runs as SYSTEM; the repo is owned by a user account.
// -c safe.directory lets git operate despite the ownership mismatch.
// Identity + credential flags give SYSTEM a valid author and push target.
const GIT_FLAGS = `-c safe.directory="${REPO_ROOT.replace(/\\/g, '/')}"`
  + ' -c user.name="SDC Repo Sync" -c user.email="repo-sync@stevendouglas.local"'
  + ' -c credential.helper= -c "credential.helper=store --file=C:/ProgramData/SDC_Scheduler/git-credentials"';

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [scheduler-repo-sync] ${msg}`);
}

function git(args) {
  return execSync(`git -C "${REPO_ROOT}" ${GIT_FLAGS} ${args}`, { stdio: 'pipe', timeout: 60000 }).toString().trim();
}

async function syncRepo() {
  log('Checking for uncommitted scheduler changes…');
  try {
    // Stage the tracked paths
    git(`add ${SYNC_PATHS.map(s => `"${s}"`).join(' ')}`);

    // Check if anything is actually staged
    let staged = true;
    try { git('diff --cached --quiet'); staged = false; }
    catch { staged = true; }

    if (!staged) {
      log('Nothing to commit — repo already in sync with Dan\'s version.');
      return;
    }

    // Read the SHA the updater last synced to
    const shaFile = path.join(__dirname, '..', '.update-sha');
    const danSha  = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, 'utf8').trim().slice(0, 7) : 'unknown';

    git(`commit -m "chore(scheduler): sync from danbelliveau2@${danSha}"`);

    // Pull latest before push — stash any unstaged changes first to avoid rebase block
    try {
      git('stash --include-untracked');
      git('pull --rebase origin master');
      git('stash pop');
    } catch (e) { log(`Pull warning: ${e.message}`); }

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
