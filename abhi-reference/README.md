# Abhi reference snapshot

These are the files from `origin/feature/smartsheet-architecture` (commit `f676d8c`) that conflicted with `main` during the bulk merge. They live here for **reference only** — `server.js` at this level is the working one. Nothing in this folder is loaded by the app.

| File | What's different from `main` |
|---|---|
| `server.js` | Older base — no Socket.io, no version-based conflict detection, no `requireRole` guards on most endpoints, no `/api/azure/push` admin route. References `./auth` but `auth.js` was deleted on his branch (his branch won't actually boot as-is). |
| `azureSync.js` | **Azure-primary design** — `_bootstrapData()` pulls Azure → SQLite on every boot, overwriting local. Opposite of `main`'s push-only design where SQLite is the working store. |
| `azureDb.js` | Same idea as `main`'s; missing some of the additive table columns we added (e.g. `tasks.version`, `task_comments` schema). |
| `create-admin.js` | Older — takes positional args instead of `--email/--name/--password` flags; hard-codes a default admin email. |
| `db.js` | Older base — missing the `users`, `task_comments`, `notification_log`, `task_history` tables we added later. |
| `package.json` | Subset of `main`'s deps (no `socket.io`). |

## Why we didn't auto-merge these

- `main` and `feature/smartsheet-architecture` are **orphan branches** — git found no common ancestor. A standard merge produced 13 K insertions / 5 K deletions with 6 file-level conflicts.
- The architectures are mutually exclusive: Azure-primary (his) vs SQLite-primary (ours).
- His `server.js` requires `./auth` but the file was removed on his branch — picking up his server.js wholesale would not boot.

## How to cherry-pick a specific Abhi change

```bash
# Open the file from this folder side-by-side with the live one:
code abhi-reference/server.js public/../server.js   # or your editor

# Or just diff a function:
diff <(grep -nA20 "function _bootstrapData" abhi-reference/azureSync.js) \
     <(grep -nA20 "function init"           ../azureSync.js)
```

When you find a function/block in here that you want in the live code, hand-port it and commit. The full diff is also available in git:

```bash
git diff main:server.js origin/feature/smartsheet-architecture:server.js
```

A backup of `main` before Abhi's branch was pulled is at the branch
`origin/backup/main-before-abhi-merge` if you ever need to roll back.
