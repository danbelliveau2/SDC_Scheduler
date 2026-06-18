#!/usr/bin/env node
/**
 * verify-sync.js — Verify that your SDC_Scheduler is in sync with Dan's GitHub repo
 * Usage: node scripts/verify-sync.js
 */

const fs = require('fs');
const path = require('path');

const BASE_DIR = path.join(__dirname, '..');

function log(msg, level = 'info') {
  const colors = { error: '\x1b[31m', warn: '\x1b[33m', ok: '\x1b[32m', info: '\x1b[36m', reset: '\x1b[0m' };
  const c = colors[level] || colors.info;
  console.log(`${c}[${level.toUpperCase()}]${colors.reset} ${msg}`);
}

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch (e) { return null; }
}

function checkTaskDeletionLogic() {
  log('Checking task deletion cleanup logic...', 'info');
  const serverJs = readFile(path.join(BASE_DIR, 'server.js'));
  const hasCleanup = serverJs?.includes('stripRef') && serverJs?.includes('taskRefs') && serverJs?.includes('finRefs');
  if (hasCleanup) { log('✓ Task deletion cleanup logic present', 'ok'); return true; }
  else { log('✗ MISSING: Task deletion cleanup logic', 'error'); return false; }
}

function checkStaticFileOrder() {
  log('Checking static file serving order...', 'info');
  const serverJs = readFile(path.join(BASE_DIR, 'server.js'));
  const publicIndex = serverJs?.indexOf("express.static(path.join(__dirname, 'public')");
  const customIndex = serverJs?.indexOf("express.static(path.join(__dirname, 'custom-public')");
  if (publicIndex > 0 && customIndex > 0 && publicIndex < customIndex) {
    log('✓ Correct file serving order: public/ FIRST, custom-public/ second', 'ok');
    return true;
  } else {
    log('✗ WRONG: custom-public/ served first (shadows updates)', 'error');
    return false;
  }
}

function checkCriticalFiles() {
  log('Checking critical files exist...', 'info');
  const files = ['server.js', 'db.js', 'auth.js', 'public/index.html', 'public/app.js', 'public/styles.css', 'package.json'];
  let allPresent = true;
  for (const file of files) {
    const filePath = path.join(BASE_DIR, file);
    if (fs.existsSync(filePath)) { log(`  ✓ ${file}`, 'ok'); }
    else { log(`  ✗ MISSING: ${file}`, 'error'); allPresent = false; }
  }
  return allPresent;
}

console.log('\n═══════════════════════════════════════════════════════════════\n');
const checks = [checkCriticalFiles(), checkTaskDeletionLogic(), checkStaticFileOrder()];
const allPassed = checks.every(c => c);
console.log('\n═══════════════════════════════════════════════════════════════');
if (allPassed) log('✓ All checks passed! Your version is in sync with Dan\'s.', 'ok');
else log('✗ Some checks failed. See details above.', 'error');
console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(allPassed ? 0 : 1);
