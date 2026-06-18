#!/usr/bin/env node
/**
 * clean-stale-custom-public.js — Remove stale files from custom-public/ folder
 *
 * PROBLEM: custom-public/ accumulates stale copies of public/ files during syncs.
 * These stale files shadow the real files (even with correct serving order) and
 * cause the old UI to render even though the backend code is updated.
 *
 * SOLUTION: Keep only app-local.js in custom-public/. Everything else should
 * come from public/ which gets auto-updated.
 *
 * Usage: node scripts/clean-stale-custom-public.js
 */

const fs = require('fs');
const path = require('path');

const CUSTOM_PUBLIC_DIR = path.join(__dirname, '..', 'custom-public');
const ALLOWED_FILES = ['app-local.js'];

function log(msg, level = 'info') {
  const colors = {
    error: '\x1b[31m',
    warn: '\x1b[33m',
    ok: '\x1b[32m',
    info: '\x1b[36m',
    reset: '\x1b[0m'
  };
  const c = colors[level] || colors.info;
  console.log(`${c}[${level.toUpperCase()}]${colors.reset} ${msg}`);
}

try {
  if (!fs.existsSync(CUSTOM_PUBLIC_DIR)) {
    log('custom-public/ directory does not exist', 'info');
    process.exit(0);
  }

  log('Scanning custom-public/ for stale files...', 'info');
  const files = fs.readdirSync(CUSTOM_PUBLIC_DIR);
  let deleted = 0;
  let kept = 0;

  for (const file of files) {
    const filePath = path.join(CUSTOM_PUBLIC_DIR, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      continue; // Skip directories
    }

    if (ALLOWED_FILES.includes(file)) {
      log(`  ✓ Keeping ${file}`, 'ok');
      kept++;
    } else {
      fs.unlinkSync(filePath);
      log(`  ✗ Deleted stale ${file}`, 'warn');
      deleted++;
    }
  }

  console.log('');
  log(`Cleanup complete: ${deleted} stale files deleted, ${kept} files kept`, 'ok');
  console.log('');

  if (deleted > 0) {
    log('IMPORTANT: Restart the server for changes to take effect:', 'warn');
    log('  pkill -f "node server.js"', 'info');
    log('  node server.js', 'info');
  }

  process.exit(0);
} catch (err) {
  log(`Error: ${err.message}`, 'error');
  process.exit(1);
}
