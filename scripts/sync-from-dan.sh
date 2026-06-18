#!/bin/bash
# sync-from-dan.sh — Safely sync with Dan's latest version
#
# Usage: bash scripts/sync-from-dan.sh

set -e

echo "🔄 SDC_Scheduler Sync Tool"
echo "════════════════════════════════════════════════════════════════"
echo ""

if ! git remote | grep -q upstream; then
  echo "📍 Adding upstream remote..."
  git remote add upstream https://github.com/danbelliveau2/SDC_Scheduler.git
fi

echo "📥 Fetching latest from Dan's repo..."
git fetch upstream --quiet
echo "   ✓ Fetched latest"

echo ""
echo "📊 Latest commits from Dan:"
git log --oneline upstream/main -5 | sed 's/^/   /'

echo ""
echo "🔀 Ready to sync: public/, server.js, db.js, auth.js, package.json"
read -p "Continue? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Sync cancelled."
  exit 1
fi

echo ""
echo "⬇️  Pulling files from upstream/main..."
git checkout upstream/main -- public/ > /dev/null 2>&1 && echo "   ✓ public/"
git checkout upstream/main -- server.js > /dev/null 2>&1 && echo "   ✓ server.js"
git checkout upstream/main -- db.js > /dev/null 2>&1 && echo "   ✓ db.js"
git checkout upstream/main -- auth.js > /dev/null 2>&1 && echo "   ✓ auth.js"

echo ""
echo "🔍 Verifying sync..."
if node scripts/verify-sync.js > /dev/null 2>&1; then
  echo "   ✓ All checks passed"
else
  echo "   ⚠️  Some checks failed (continuing anyway)"
fi

echo ""
echo "💾 Creating commit..."
UPSTREAM_COMMIT=$(git rev-parse upstream/main --short)
git add public/ server.js db.js auth.js
git commit -m "chore(scheduler): sync from danbelliveau2@$UPSTREAM_COMMIT" > /dev/null 2>&1

echo "   ✓ Synced to upstream/main ($UPSTREAM_COMMIT)"
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "✅ Sync complete! Push when ready: git push origin main"
echo ""
