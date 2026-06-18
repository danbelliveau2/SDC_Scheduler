#!/bin/bash
# sync-from-dan.sh — Safely sync with Dan's latest version
#
# This script:
# 1. Fetches Dan's latest commits
# 2. Pulls the critical files from Dan's version
# 3. Verifies the sync
# 4. Creates a commit with the sync
#
# Usage:
#   bash scripts/sync-from-dan.sh

set -e  # Exit on error

echo "🔄 SDC_Scheduler Sync Tool"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Step 1: Check if upstream remote exists
if ! git remote | grep -q upstream; then
  echo "📍 Adding upstream remote..."
  git remote add upstream https://github.com/danbelliveau2/SDC_Scheduler.git
fi

# Step 2: Fetch latest
echo "📥 Fetching latest from Dan's repo..."
git fetch upstream --quiet
echo "   ✓ Fetched latest"

# Step 3: Show what's new
echo ""
echo "📊 Latest commits from Dan:"
git log --oneline upstream/main -5 | sed 's/^/   /'

# Step 4: Ask for confirmation
echo ""
echo "🔀 Ready to sync these files from upstream/main:"
echo "   • public/ (app.js, styles.css, index.html, etc.)"
echo "   • server.js (critical bug fixes)"
echo "   • db.js (schema updates)"
echo "   • auth.js (authentication logic)"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Sync cancelled."
  exit 1
fi

# Step 5: Pull files
echo ""
echo "⬇️  Pulling files from upstream/main..."
git checkout upstream/main -- public/ > /dev/null 2>&1 && echo "   ✓ public/"
git checkout upstream/main -- server.js > /dev/null 2>&1 && echo "   ✓ server.js"
git checkout upstream/main -- db.js > /dev/null 2>&1 && echo "   ✓ db.js"
git checkout upstream/main -- auth.js > /dev/null 2>&1 && echo "   ✓ auth.js"
git checkout upstream/main -- package.json > /dev/null 2>&1 && echo "   ✓ package.json"
git checkout upstream/main -- package-lock.json > /dev/null 2>&1 && echo "   ✓ package-lock.json"

# Step 6: Verify sync
echo ""
echo "🔍 Verifying sync..."
if node scripts/verify-sync.js > /tmp/sync-verify.txt 2>&1; then
  echo "   ✓ All checks passed"
else
  echo "   ⚠️  Some checks failed:"
  cat /tmp/sync-verify.txt
  echo ""
  read -p "Continue anyway? (y/n) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Sync aborted."
    git checkout HEAD -- public/ server.js db.js auth.js package.json package-lock.json 2>/dev/null || true
    exit 1
  fi
fi

# Step 7: Commit
echo ""
echo "💾 Creating commit..."
UPSTREAM_COMMIT=$(git rev-parse upstream/main --short)
git add public/ server.js db.js auth.js package.json package-lock.json
git commit -m "chore(scheduler): sync from danbelliveau2@$UPSTREAM_COMMIT" > /dev/null 2>&1

echo "   ✓ Synced to upstream/main ($UPSTREAM_COMMIT)"

# Step 8: Done
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "✅ Sync complete!"
echo ""
echo "Next steps:"
echo "  1. Review changes: git diff HEAD~1"
echo "  2. Test the app: npm run dev"
echo "  3. If OK, push: git push origin main"
echo ""
