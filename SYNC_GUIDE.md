# SDC Scheduler — Sync Maintenance Guide

**This guide explains how to stay in sync with Dan's GitHub repo and prevent critical issues.**

---

## The Problem (What We Just Fixed)

Your SDC_Scheduler had **drifted from Dan's version** in two critical ways:

1. **Missing task deletion cleanup logic** — When deleting a task, other tasks' predecessors could reference the deleted task ID, leaving dangling references. Dan added cleanup code to sever these refs before deletion.

2. **Wrong static file serving order** — Your setup served `custom-public/` FIRST, shadowing Dan's auto-updated `public/` files. You were running stale code even though updated code existed.

**Result:** Cascading failures in schedule calculations and stale frontend code in production.

---

## The Permanent Solution

We've implemented **3-layer protection**:

### 1. Verification Script (`scripts/verify-sync.js`)

Run anytime to check your sync status:

```bash
node scripts/verify-sync.js
```

This checks:
- ✓ Task deletion cleanup logic present
- ✓ Static file serving order correct (public/ FIRST)
- ✓ File sizes match between public/ and custom-public/
- ✓ Critical files exist

### 2. Pre-Commit Hook (`.git/hooks/pre-commit`)

Automatically runs `verify-sync.js` before every commit.

- **Blocks commits** if critical issues detected
- **Shows warnings** so you can fix before pushing
- Allows `git commit --no-verify` to override (use sparingly)

### 3. This Guide

Standard operating procedures for maintaining sync.

---

## Syncing with Dan's Latest

### The Right Way: Pull from GitHub

```bash
# 1. Add Dan's repo as a remote (if not already done)
git remote add upstream https://github.com/danbelliveau2/SDC_Scheduler.git

# 2. Fetch latest commits
git fetch upstream

# 3. Review what changed
git log --oneline upstream/main | head -20

# 4. Pull Dan's latest into your public/ folder
# (This is the safest approach — merge only the latest public/ code)
git checkout upstream/main -- public/
git checkout upstream/main -- server.js
git checkout upstream/main -- db.js
git checkout upstream/main -- auth.js
# (Add other critical files as needed)

# 5. Verify sync
node scripts/verify-sync.js

# 6. Commit the sync
git add public/ server.js db.js auth.js
git commit -m "chore(scheduler): sync public files from danbelliveau2@COMMIT_SHA"

# 7. Push to your repo
git push origin main
```

### Custom Overrides: What to Keep

Some files SHOULD be customized locally in `custom-public/`:

- `app-local.js` — Your local app variant (if you have one)
- Any production-specific overrides

**NEVER customize:**
- `app.js` — Keep from Dan's public/
- `styles.css` — Keep from Dan's public/
- `index.html` — Keep from Dan's public/
- `release-notes.js` — Keep from Dan's public/

---

## Critical Code Sections (Don't Modify These)

### ✓ Task Deletion Cleanup (server.js, ~line 542)

This MUST be present:

```javascript
// Sever references to this task BEFORE deleting it
const stripRef = (predStr, marker) => {
  if (!predStr) return predStr;
  const kept = String(predStr).split(',').map(s => s.trim()).filter(Boolean).filter(seg => {
    const m = seg.match(marker ? /^#(\d+)/ : /^(\d+)/);
    return !(m && Number(m[1]) === id);
  });
  return kept.join(', ');
};
const [taskRefs] = await pool.query('SELECT id, predecessors FROM tasks WHERE predecessors LIKE ?', [`%${id}%`]);
for (const r of taskRefs) {
  const np = stripRef(r.predecessors, false);
  if (np !== r.predecessors) await pool.query('UPDATE tasks SET predecessors = ? WHERE id = ?', [np || null, r.id]);
}
const [finRefs] = await pool.query('SELECT id, predecessors FROM project_financials WHERE predecessors LIKE ?', [`%#${id}%`]);
for (const r of finRefs) {
  const np = stripRef(r.predecessors, true);
  if (np !== r.predecessors) await pool.query('UPDATE project_financials SET predecessors = ? WHERE id = ?', [np || null, r.id]);
}
await pool.query('DELETE FROM tasks WHERE id = ?', [id]);
```

**Never skip this or move it after the DELETE.** Dangling refs break cascading.

### ✓ Static File Serving Order (server.js, ~line 103)

Must be in this exact order:

```javascript
// public/ FIRST — this is canonical
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true }));
// custom-public/ SECOND — fallback only
app.use(express.static(path.join(__dirname, 'custom-public'), { etag: true, lastModified: true }));
```

**NEVER reverse this order.** Public files are auto-updated; custom-public is stale by design.

---

## Daily Workflow

### Before starting work:

```bash
# Check sync status
node scripts/verify-sync.js

# If issues, sync with Dan's latest
git fetch upstream && git checkout upstream/main -- public/ server.js
node scripts/verify-sync.js
```

### When committing:

```bash
git add .
git commit -m "your message"
# Hook automatically verifies sync
```

If the hook blocks you:
1. Run `node scripts/verify-sync.js` to see what failed
2. Fix the issue
3. Recommit (or use `git commit --no-verify` if you're confident)

---

## Monitoring for Drift

### Weekly Sync Check

```bash
# Check for new commits in Dan's repo
git fetch upstream
git log --oneline -5 upstream/main

# Compare your version with Dan's
diff server.js <(git show upstream/main:server.js)

# If significant diffs, pull the latest
git checkout upstream/main -- public/ server.js db.js
```

### Before Production Deploy

**Always run:**

```bash
node scripts/verify-sync.js
```

If this fails, **do not deploy.** Fix the issues first.

---

## What NOT to Do

❌ **Don't modify public/ files directly** — they get auto-updated  
❌ **Don't use custom-public/ for feature work** — that's for ACL-locked overrides only  
❌ **Don't skip the pre-commit hook** — it protects you  
❌ **Don't ignore verify-sync.js warnings** — they point to real bugs  
❌ **Don't reorder the static file serves** — public/ MUST be first

---

## Troubleshooting

### "verify-sync.js says task deletion cleanup is missing"

Your server.js is out of date. Pull the latest:

```bash
git fetch upstream
git checkout upstream/main -- server.js
```

Then verify:

```bash
node scripts/verify-sync.js
```

### "static file serving order is wrong"

Your server.js has the static serves in the wrong order. Fix:

1. Open `server.js`
2. Find the two `app.use(express.static(...))` lines (~line 103)
3. Move `public/` to first, `custom-public/` to second
4. Run `node scripts/verify-sync.js`

### "custom-public/ files are larger than public/"

Your custom-public files have been locally modified. Decide:

- **Option A:** Restore from Dan's version:
  ```bash
  git checkout upstream/main -- public/
  # Then copy to custom-public if you want to keep your changes
  cp -r public/* custom-public/
  ```

- **Option B:** Keep custom changes but document them:
  ```bash
  # Add a note explaining why custom-public diverges
  echo "# Custom modifications" > custom-public/CHANGES.md
  ```

---

## References

- **CLAUDE.md** — Working rules for editing this codebase
- **ARCHITECTURE.md** — System design overview
- **README.md** — Quick start + feature overview
- **CONTRIBUTING.md** — Branch/commit conventions
- **Dan's GitHub** — https://github.com/danbelliveau2/SDC_Scheduler.git

---

## Questions?

If verify-sync.js keeps failing or you're unsure about a change:

1. Run `node scripts/verify-sync.js` to see what's wrong
2. Check this guide's "Troubleshooting" section
3. Read CLAUDE.md for working rules
4. Ask Dan before making critical changes to server.js

---

**Last updated:** 2026-06-18  
**Sync status:** All checks passing ✓
