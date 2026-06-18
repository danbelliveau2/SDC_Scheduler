'use strict';

/**
 * SDC_Scheduler/scripts/server-auto-update.js
 *
 * Polls danbelliveau2/SDC_Scheduler for new commits every 5 min.
 * On change: downloads tarball, replaces safe dirs/files, merges new deps,
 * then pm2 restarts sdc-scheduler.
 *
 * Preserved (never overwritten):
 *   server.js   — rewritten for MySQL (mysql2/promise), must not be replaced with Dan's SQLite version
 *   db.js       — re-exports MySQL pool; Dan's version is SQLite (better-sqlite3)
 *   cronJobs.js — rewritten for MySQL; Dan's version uses SQLite prepared statements
 *   mysqlDb.js, create-admin.js, migrate-sqlite-to-mysql.js  — MySQL-only files
 *   package.json     — only new upstream deps added, local extras kept
 *   .env
 *
 * Run via PM2:  pm2 start ecosystem.config.js --only sdc-scheduler-updater
 */

const https            = require('https');
const http             = require('http');
const fs               = require('fs');
const path             = require('path');
const os               = require('os');
const { execSync }     = require('child_process');

const GITHUB_REPO       = 'danbelliveau2/SDC_Scheduler';
const GITHUB_BRANCH     = 'main';   // Dan's active branch — master is stale
const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const APP_DIR           = path.join(__dirname, '..');
const PM2_APP_NAMES     = ['sdc-scheduler', 'sdc-scheduler-repo-sync'];
const SELF_PM2_NAME     = 'sdc-scheduler-updater';
const SHA_FILE          = path.join(APP_DIR, '.update-sha');

// Directories to wholesale replace from upstream.
// 'scripts' is intentionally excluded — this updater script lives here and must
// not be overwritten by upstream on every pull (that would erase the local-patch
// logic below). Dan's repo-sync script is pulled individually via SAFE_FILES.
const SAFE_DIRS = ['public'];

// Individual files safe to replace from upstream.
// ⚠ server.js, db.js, cronJobs.js are EXCLUDED — they have been rewritten for
//   MySQL (mysql2/promise) and must never be overwritten with Dan's SQLite version.
//   auth.js and emailService.js are safe: they contain no direct DB calls.
// ⚠ scripts/repo-sync.js is intentionally excluded — it is monorepo infrastructure
//   owned by this repo. Pulling Dan's version would wipe our SYNC_PATHS additions.
const SAFE_FILES = ['ARROW_ROUTING_RULES.md', '.gitignore',
                    'auth.js', 'emailService.js'];

// ─── helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [scheduler-updater] ${msg}`);
}

function getStoredSha() {
  try { return fs.readFileSync(SHA_FILE, 'utf8').trim(); } catch { return null; }
}

function storeSha(sha) {
  fs.writeFileSync(SHA_FILE, sha, 'utf8');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: {
        'User-Agent': 'SDC-Tools-Scheduler-Updater/1.0',
        'Accept':     'application/vnd.github.v3+json',
      },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const doGet = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'SDC-Tools-Scheduler-Updater/1.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return doGet(res.headers.location);
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    doGet(url);
  });
}

function run(cmd, cwd) {
  try {
    execSync(cmd, { cwd: cwd || APP_DIR, stdio: 'pipe' });
  } catch (e) {
    const detail = e.stderr ? e.stderr.toString().trim() : (e.stdout ? e.stdout.toString().trim() : '');
    throw new Error(`Command failed: ${cmd}\n${detail}`);
  }
}

// ─── local patches ───────────────────────────────────────────────────────────
// Applied after every upstream pull. Add any persistent local modifications here.
// Each patch is idempotent: checks before applying so re-runs are safe.

function applyLocalPatches(appDir) {
  // Patch 1: register route — surface a note when caller submits a role that
  // gets silently ignored (all self-registrations are clamped to 'editor').
  const serverPath = path.join(appDir, 'server.js');
  if (!fs.existsSync(serverPath)) return;

  let src = fs.readFileSync(serverPath, 'utf8');

  if (src.includes('Requested role ignored')) {
    log('Local patches: already applied, skipping.');
    return;
  }

  const before = `    io.emit('users:updated');\n    res.status(201).json({\n      token,\n      user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar_color: user.avatar_color },\n    });`;
  const after  = `    io.emit('users:updated');\n    // Surface a note when the caller submitted a role we ignored (always 'editor').\n    const roleNote = req.body.role && req.body.role !== 'editor'\n      ? 'Requested role ignored — all self-registered accounts start as editor. Contact an admin to change your role.'\n      : undefined;\n    res.status(201).json({\n      token,\n      user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar_color: user.avatar_color },\n      ...(roleNote ? { note: roleNote } : {}),\n    });`;

  if (!src.includes(before.split('\n')[0])) {
    log('Local patches: register handler not found in expected format — skipping note patch.');
    return;
  }

  src = src.replace(before, after);
  fs.writeFileSync(serverPath, src, 'utf8');
  log('Local patches: applied register role note to server.js');
}

// ─── update flow ─────────────────────────────────────────────────────────────

async function checkAndUpdate() {
  const storedSha = getStoredSha();
  log(`Checking for updates… (stored SHA: ${storedSha ? storedSha.slice(0, 7) : 'none'})`);

  let remoteSha;
  try {
    // Use git ls-remote — avoids GitHub API rate limits and DNS issues.
    // Falls back to GitHub API if git is unavailable.
    const lsOut = require('child_process').execSync(
      `git ls-remote https://github.com/${GITHUB_REPO}.git refs/heads/${GITHUB_BRANCH}`,
      { timeout: 15000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    ).toString().trim();
    remoteSha = lsOut.split(/\s+/)[0];
  } catch (gitErr) {
    try {
      const data = await fetchJson(
        `https://api.github.com/repos/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`
      );
      remoteSha = data.sha;
    } catch (e) {
      log(`Could not read remote SHA: ${e.message}`);
      return;
    }
  }

  if (!remoteSha) { log('Could not read remote SHA.'); return; }
  log(`Remote SHA: ${remoteSha.slice(0, 7)}`);

  // First run — store SHA without updating to avoid re-applying manual changes
  if (!storedSha) {
    log('First run — storing current SHA, no update needed.');
    storeSha(remoteSha);
    return;
  }

  if (storedSha === remoteSha) {
    log('Already up to date.');
    return;
  }

  log(`Update available (${storedSha.slice(0, 7)} → ${remoteSha.slice(0, 7)}). Downloading…`);

  const tmpTar = path.join(os.tmpdir(), `sdc-scheduler-${remoteSha.slice(0, 7)}.tar.gz`);
  const tmpDir = path.join(os.tmpdir(), `sdc-scheduler-extract-${Date.now()}`);

  try {
    // 1. Download tarball of latest commit
    const tarUrl = `https://api.github.com/repos/${GITHUB_REPO}/tarball/${GITHUB_BRANCH}`;
    await downloadFile(tarUrl, tmpTar);
    log('Downloaded. Extracting…');

    fs.mkdirSync(tmpDir, { recursive: true });
    run(`tar -xzf "${tmpTar}" -C "${tmpDir}" --strip-components=1`);

    // 2. Replace safe directories
    for (const dir of SAFE_DIRS) {
      const src = path.join(tmpDir, dir);
      const dst = path.join(APP_DIR, dir);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true, force: true });
      log(`  Replaced: ${dir}/`);
    }

    // 3. Replace safe individual files
    for (const file of SAFE_FILES) {
      const src = path.join(tmpDir, file);
      const dst = path.join(APP_DIR, file);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, dst);
      log(`  Replaced: ${file}`);
    }

    // 4. Sync new deps from upstream — only ADD new packages, never remove existing
    // This preserves local extras; only new upstream deps are added
    const upstreamPkgPath = path.join(tmpDir, 'package.json');
    if (fs.existsSync(upstreamPkgPath)) {
      const upstream = JSON.parse(fs.readFileSync(upstreamPkgPath, 'utf8'));
      const local    = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
      let depsChanged = false;
      for (const [pkg, ver] of Object.entries(upstream.dependencies || {})) {
        if (local.dependencies?.[pkg] !== ver) {
          local.dependencies = local.dependencies || {};
          local.dependencies[pkg] = ver;
          depsChanged = true;
        }
      }
      if (depsChanged) {
        fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify(local, null, 2));
        log('New dependencies detected — running npm install…');
        run('npm install');
      }
    }

    // 5. Wipe stale shadow files from custom-public/ — keep only local-only files
    //    that don't come from Dan (e.g. app-local.js). public/ is now served
    //    BEFORE custom-public/ in Express, so this is just cleanup; but clearing
    //    prevents old files from committing to the repo via startRepoAutoSync.
    const customPublicDir = path.join(APP_DIR, 'custom-public');
    const LOCAL_ONLY_FILES = new Set(['app-local.js']);
    if (fs.existsSync(customPublicDir)) {
      for (const entry of fs.readdirSync(customPublicDir)) {
        if (LOCAL_ONLY_FILES.has(entry)) continue;
        try {
          const fp = path.join(customPublicDir, entry);
          if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
        } catch (_) {}
      }
      log('  Cleared stale overrides from custom-public/ (kept local-only files).');
    }

    // 6. Apply local patches on top of upstream files — runs after every pull so
    //    fixes survive upstream updates without forking Dan's repo.
    applyLocalPatches(APP_DIR);

    // 7. Restart PM2 apps
    for (const name of PM2_APP_NAMES) {
      log(`Restarting ${name}…`);
      try { run(`pm2 restart ${name} --update-env`); }
      catch (e) { log(`pm2 restart warning (${name}): ${e.message}`); }
    }

    // 8. Keep sdc-scheduler-repo mirror in lockstep with Dan's repo.
    //    This ensures any comparison of the mirror vs SDC_Scheduler/ is always
    //    apples-to-apples — both at the same Dan commit.
    const mirrorDir = path.join(APP_DIR, '..', 'sdc-scheduler-repo');
    if (fs.existsSync(mirrorDir)) {
      try {
        require('child_process').execSync(
          `git -C "${mirrorDir}" fetch origin --quiet`,
          { stdio: 'pipe', timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
        );
        require('child_process').execSync(
          `git -C "${mirrorDir}" reset --hard origin/main`,
          { stdio: 'pipe' }
        );
        log(`sdc-scheduler-repo mirror reset to Dan's latest (${remoteSha.slice(0, 7)}).`);
      } catch (e) {
        log(`Mirror sync warning (non-fatal): ${e.message}`);
      }
    }

    storeSha(remoteSha);
    log(`Successfully updated to ${remoteSha.slice(0, 7)}!`);

  } catch (e) {
    log(`Update failed: ${e.message}`);
    if (e.stack) log(e.stack.split('\n').slice(1, 3).join(' '));
  } finally {
    // Clean up temp files BEFORE self-restart so they are never orphaned
    try { fs.unlinkSync(tmpTar); }                              catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    // Self-restart after cleanup — deferred so finally block fully completes first
    setTimeout(() => {
      try { run(`pm2 restart ${SELF_PM2_NAME} --update-env`); } catch {}
    }, 500);
  }
}

// ─── entry point ─────────────────────────────────────────────────────────────

async function main() {
  log('SDC Scheduler — server auto-updater started');
  log(`Watching: https://github.com/${GITHUB_REPO}/tree/${GITHUB_BRANCH}  (branch: ${GITHUB_BRANCH})`);
  log(`Check interval: ${CHECK_INTERVAL_MS / 60000} min`);
  await checkAndUpdate();
  setInterval(checkAndUpdate, CHECK_INTERVAL_MS);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });

// ─── manual trigger server ────────────────────────────────────────────────────
// POST http://<host>:4013/trigger  →  runs checkAndUpdate() immediately
const TRIGGER_PORT = 4013;
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/trigger') {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    checkAndUpdate().catch(e => log(`Manual trigger error: ${e.message}`));
  } else {
    res.writeHead(404); res.end();
  }
}).listen(TRIGGER_PORT, '0.0.0.0', () => log(`Trigger server on port ${TRIGGER_PORT}`));
