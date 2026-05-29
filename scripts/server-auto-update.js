'use strict';

/**
 * SDC_Scheduler/scripts/server-auto-update.js
 *
 * Polls danbelliveau2/SDC_Scheduler for new commits every 5 min.
 * On change: downloads tarball, replaces safe dirs/files, merges new deps,
 * then pm2 restarts sdc-scheduler.
 *
 * Preserved (never overwritten):
 *   server.js        — compression middleware, azureSync, /health endpoint
 *   azureDb.js       — Azure SQL connection
 *   azureSync.js     — Azure sync layer
 *   create-admin.js, migrate.js
 *   *.db / sessions.db — live SQLite databases
 *   package.json     — extra deps (compression, mssql) kept; only new upstream deps added
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
const GITHUB_BRANCH     = 'main';
const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const APP_DIR           = path.join(__dirname, '..');
const PM2_APP_NAME      = 'sdc-scheduler';
const SHA_FILE          = path.join(APP_DIR, '.update-sha');

// Directories to wholesale replace from upstream
const SAFE_DIRS = ['public'];

// Individual files safe to replace
const SAFE_FILES = ['db.js', 'ARROW_ROUTING_RULES.md', '.gitignore'];

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

// ─── update flow ─────────────────────────────────────────────────────────────

async function checkAndUpdate() {
  const storedSha = getStoredSha();
  log(`Checking for updates… (stored SHA: ${storedSha ? storedSha.slice(0, 7) : 'none'})`);

  let remoteSha;
  try {
    const data = await fetchJson(
      `https://api.github.com/repos/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`
    );
    remoteSha = data.sha;
  } catch (e) {
    log(`GitHub API error: ${e.message}`);
    return;
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
    // This preserves local extras: compression, mssql (needed for azureSync)
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

    // 5. Restart PM2 app
    log(`Restarting ${PM2_APP_NAME}…`);
    try { run(`pm2 restart ${PM2_APP_NAME} --update-env`); }
    catch (e) { log(`pm2 restart warning: ${e.message}`); }

    storeSha(remoteSha);
    log(`Successfully updated to ${remoteSha.slice(0, 7)}!`);

  } catch (e) {
    log(`Update failed: ${e.message}`);
    if (e.stack) log(e.stack.split('\n').slice(1, 3).join(' '));
  } finally {
    try { fs.unlinkSync(tmpTar); }                              catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
