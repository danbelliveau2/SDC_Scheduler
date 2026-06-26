# Contributing to SDC Scheduler

## Who works on this repo

| Developer | GitHub | Role |
|-----------|--------|------|
| Dan | @danbelliveau2 | Core features, frontend (`app.js`, CSS, HTML) |
| Abhi | @akamuju | Deployment, UI/UX, backend (server, DB, integrations) |

---

## Git workflow — one branch, both push to `main`

```bash
# Start of EVERY session — do this first, always
git pull origin main

# End of session — push your work
git add -A
git commit -m "feat: description"
git push origin main
```

The production server pulls from `main` every 2 minutes. Your push goes live automatically.

**If push is rejected** (someone pushed while you were working):
```bash
git pull --rebase origin main   # rebase your commits on top of theirs
git push origin main
```

---

## File ownership — who edits what

### Dan owns (frontend)

| File | Notes |
|------|-------|
| `public/app.js` | Main SPA — vanilla JS, 20k+ lines |
| `public/styles.css` | All app CSS |
| `public/index.html` | Entry point — script load order matters |
| `public/phases.js` | Phase/dept hierarchy |
| `public/release-notes.js` | **Dan bumps the rev only — never touch this** |
| `public/realtime-ui.js` | Socket.io client |
| `public/auth-ui.js` / `auth-ui.css` | Login UI |

### Abhi owns (backend + deployment)

| File | Notes |
|------|-------|
| `server.js` | Express + Socket.io + MySQL — do NOT SQLite-ify |
| `db.js` | MySQL schema + boot migrations |
| `mysqlDb.js` | MySQL connection pool — production DB layer |
| `hoursApi.js` | Power BI DAX bridge |
| `etoDb.js` | Total ETO MSSQL read-only bridge |
| `agent.js` | Claude AI tool-using agent |
| `auth.js` | JWT, roles (viewer/editor/admin), lockout |
| `ops.js` | DB backup, health, status |
| `backfillProjects.js` | ETO project auto-registration |
| `cronJobs.js` | Scheduled jobs (backup, sync, digest) |
| `emailService.js` | SMTP — mentions, digests, alerts |
| `routes/` | All 12 route files |
| `mcp/` | Read-only MCP server (port 4100) |
| `custom-public/` | Frontend overlay patches |
| `scripts/` | Auto-updater, deployment scripts |
| `ecosystem.config.js` | PM2 process definitions |

---

## Critical: MySQL in production, SQLite in Dan's local dev

Dan develops locally with `node:sqlite` (zero install).
Production runs **MySQL 9.7**. All production DB code uses `mysql2/promise` via `mysqlDb.js`.

**Dan: never push SQLite imports or `DatabaseSync` into `db.js` or `server.js` — it crashes production.**

When Dan adds a new DB column locally, tell Abhi the table + column name.
Abhi adds an idempotent migration to `db.js`:
```js
tryAlter('ALTER TABLE tasks ADD COLUMN my_col VARCHAR(255) DEFAULT NULL');
```

---

## Production server

```
GitHub (main branch)
      ↓  auto-pulled every 2 min by sdc-scheduler-updater
Windows Server — SERVER-APP1
      ├─ sdc-scheduler         port 4003  (main app)
      ├─ MySQL 9.7
      └─ Power BI MCP exe      (job hours DAX bridge)
```

- App URL on LAN: `http://SERVER-APP1:4003`
- PM2 logs: `C:\Users\akamuju\.pm2\logs\sdc-scheduler-*.log`
- Manual deploy trigger: `POST http://localhost:4013/trigger`

---

## Adding features

### New API route
1. Add to the relevant file in `routes/` (or create a new one)
2. Mount in `server.js` if it's a new group
3. Wire up in `public/app.js` via the `api` object

### New frontend feature
- **Dan**: edit `public/app.js` directly
- **Abhi**: use `custom-public/app-local.js` for small patches; edit `public/app.js` for major features

### New DB column
- Dan: add in SQLite schema locally, tell Abhi the column name
- Abhi: add `tryAlter(...)` migration in `db.js` — runs on next server boot, idempotent

---

## Key gotchas (hard-won — don't repeat these)

1. **Never bump `public/release-notes.js` rev** — Dan's job only
2. **Every Gantt drawer must be in `try/catch`** — one throw kills all subsequent drawers silently
3. **`state.gantt.gantt_start` is a `Date` object** — never concatenate strings to it
4. **SVG additions to `.bar-wrapper`: use `appendChild`, not `insertBefore`** — label is nested, not direct child
5. **`mysqlDb.js` is never overwritten by the auto-updater** — preserved list
6. **`.env` is never committed** — MySQL password, API keys, JWT secret live there
7. **Compression filter excludes SSE routes** — buffering kills server-sent events
