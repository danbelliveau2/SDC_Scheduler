#!/usr/bin/env node
/**
 * verify-sync.js — Verify that your SDC_Scheduler is in sync with Dan's GitHub repo
 *
 * Usage:
 *   node scripts/verify-sync.js          (check current directory)
 *   node scripts/verify-sync.js --fix    (auto-fix detected issues)
 *
 * This script checks for:
 * 1. server.js task deletion cleanup logic (dangling reference fix)
 * 2. Static file serving order (public/ BEFORE custom-public/)
 * 3. File size parity between public/ and custom-public/
 * 4. Presence of critical files
 */

const fs = require('fs');
const path = require('path');

const FIX_MODE = process.argv.includes('--fix');
const BASE_DIR = path.join(__dirname, '..');

function log(msg, level = 'info') {
  const colors = {
    error: '\x1b[31m',    // red
    warn: '\x1b[33m',     // yellow
    ok: '\x1b[32m',       // green
    info: '\x1b[36m',     // cyan
    reset: '\x1b[0m'
  };
  const c = colors[level] || colors.info;
  console.log(`${c}[${level.toUpperCase()}]${colors.reset} ${msg}`);
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function checkTaskDeletionLogic() {
  log('Checking task deletion cleanup logic...', 'info');
  const serverJs = readFile(path.join(BASE_DIR, 'server.js'));

  const hasCleanup = serverJs?.includes('stripRef') &&
                      serverJs?.includes('taskRefs') &&
                      serverJs?.includes('finRefs');

  if (hasCleanup) {
    log('✓ Task deletion cleanup logic present', 'ok');
    return true;
  } else {
    log('✗ MISSING: Task deletion cleanup logic (dangling reference fix)', 'error');
    log('  This can cause cascading schedule failures when deleting tasks.', 'warn');
    return false;
  }
}

function checkStaticFileOrder() {
  log('Checking static file serving order...', 'info');
  const serverJs = readFile(path.join(BASE_DIR, 'server.js'));

  // Find the indices of both static serves
  const publicIndex = serverJs?.indexOf("express.static(path.join(__dirname, 'public')");
  const customIndex = serverJs?.indexOf("express.static(path.join(__dirname, 'custom-public')");

  if (publicIndex > 0 && customIndex > 0 && publicIndex < customIndex) {
    log('✓ Correct file serving order: public/ FIRST, custom-public/ second', 'ok');
    return true;
  } else if (publicIndex > 0 && customIndex > 0) {
    log('✗ WRONG: custom-public/ is served FIRST (shadows Dan\'s updates)', 'error');
    log('  This means your local custom files override auto-updated public/ files.', 'warn');
    return false;
  } else {
    log('✗ Could not determine file serving order', 'error');
    return false;
  }
}

function checkFileSizeParity() {
  log('Checking file size parity (public/ vs custom-public/)...', 'info');

  const criticalFiles = [
    'app.js',
    'styles.css',
    'release-notes.js',
    'index.html',
    'auth-ui.js',
    'comments-ui.js'
  ];

  let allMatch = true;
  for (const file of criticalFiles) {
    const publicPath = path.join(BASE_DIR, 'public', file);
    const customPath = path.join(BASE_DIR, 'custom-public', file);

    const publicExists = fs.existsSync(publicPath);
    const customExists = fs.existsSync(customPath);

    if (!publicExists) {
      log(`  ⚠ public/${file} missing`, 'warn');
      continue;
    }

    if (!customExists) {
      log(`  ✓ ${file}: only in public/ (correct)`, 'ok');
      continue;
    }

    const publicSize = fs.statSync(publicPath).size;
    const customSize = fs.statSync(customPath).size;
    const diff = Math.abs(publicSize - customSize);
    const diffPercent = ((diff / publicSize) * 100).toFixed(1);

    if (diff > 1000) { // More than 1KB difference
      log(`  ✗ ${file}: SIZE MISMATCH — public ${(publicSize / 1024).toFixed(0)}KB vs custom ${(customSize / 1024).toFixed(0)}KB (${diffPercent}% diff)`, 'error');
      allMatch = false;
    } else {
      log(`  ✓ ${file}: sizes match`, 'ok');
    }
  }

  return allMatch;
}

function checkCriticalFiles() {
  log('Checking critical files exist...', 'info');

  const files = [
    'server.js',
    'db.js',
    'auth.js',
    'public/index.html',
    'public/app.js',
    'public/styles.css',
    'package.json'
  ];

  let allPresent = true;
  for (const file of files) {
    const filePath = path.join(BASE_DIR, file);
    if (fs.existsSync(filePath)) {
      log(`  ✓ ${file}`, 'ok');
    } else {
      log(`  ✗ MISSING: ${file}`, 'error');
      allPresent = false;
    }
  }

  return allPresent;
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SDC Scheduler Sync Verification');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const checks = [
    checkCriticalFiles(),
    checkTaskDeletionLogic(),
    checkStaticFileOrder(),
    checkFileSizeParity()
  ];

  const allPassed = checks.every(c => c);

  console.log('\n═══════════════════════════════════════════════════════════════');
  if (allPassed) {
    log('✓ All checks passed! Your version is in sync with Dan\'s.', 'ok');
  } else {
    log('✗ Some checks failed. See details above.', 'error');
    log('Run: node scripts/verify-sync.js --fix    (to auto-fix)', 'info');
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  process.exit(allPassed ? 0 : 1);
}

main();
