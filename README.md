# SDC Project Scheduler

Web-based project scheduler for SDC Automation. Tasks, predecessors, multi-machine Gantt, per-project finances, audit trail, comments + @mentions, optional Azure SQL sync, optional email notifications.

Single-page client (`public/app.js`) talks to an Express server (`server.js`) backed by SQLite (`scheduler.db`). When Azure SQL credentials are set, the server pushes writes to Azure too. Socket.io broadcasts task / team / settings updates so open browser tabs refresh automatically.

---

## Quick start

```bash
git clone https://github.com/danbelliveau2/SDC_Scheduler.git
cd SDC_Scheduler
npm install
cp .env.example .env             # fill in any values you want (all optional)
node server.js
# → http://localhost:3000
```

That's it. With an empty `.env`, every optional feature (Azure sync, auth, email) is off; the app works locally against `scheduler.db`.

### Enable login

```bash
# Create the first admin
node create-admin.js --email you@sdcautomation.com --name "Your Name" --password "yourpass"

# Set AUTH_ENABLED=true in .env, then restart
node server.js
```

The login modal appears for everyone after that. JWT tokens last 7 days.

### Enable Azure SQL sync

Fill `AZURE_SQL_*` in `.env`. On first boot, the server creates the `[scheduler].*` schema in your Azure DB. To force a one-time push of local → Azure (overwriting Azure), set `AZURE_PUSH_ON_BOOT=true` for one boot, then flip back to `false`. After that, every local write fires a debounced push.

To force a pull (overwriting **local**), use `AZURE_PULL_ON_BOOT=true` — but **back up `scheduler.db` first**, this is destructive.

### Enable email notifications

Fill `SMTP_*` in `.env`. Without those vars, mentions still get logged to the `notification_log` table; with them set, @mentions in comments trigger an email to the mentioned user.

---

## What's in here

| Path | What it is |
|---|---|
| `server.js` | Express app, all `/api/*` routes, cascade scheduler |
| `db.js` | SQLite schema + bootstrap + default settings |
| `auth.js` | JWT middleware (`requireAuth`, `requireRole`) |
| `azureDb.js` | Azure SQL connection pool + schema migration |
| `azureSync.js` | Push-only write-through from SQLite to Azure |
| `cronJobs.js` | Scheduled work (weekday-9am email digest) |
| `emailService.js` | Mention emails + dedupe via `notification_log` |
| `create-admin.js` | One-off script to seed the first user |
| `public/index.html` | Single-page shell |
| `public/app.js` | Everything-file: render, state, drag, edit, save |
| `public/auth-ui.js` + `auth-ui.css` | Login modal + user pill |
| `public/comments-ui.js` | Per-task 💬 badge + slide-in panel |
| `public/realtime-ui.js` | Socket.io client + invalidate handlers |
| `public/presence-ui.js` | "Who's editing" avatars |
| `public/phases.js` | `HIERARCHY` constant — section / department / sub-dep tree |
| `public/release-notes.js` | Rev history (only Dan bumps this) |
| `scripts/server-auto-update.js` | Production deploy helper — polls GitHub, restarts via PM2 |
| `CLAUDE.md` | Working rules for Claude when editing this codebase |
| `ARCHITECTURE.md` | Deeper system design |
| `CONTRIBUTING.md` | Branch / commit / PR conventions |

---

## Features

- **Hierarchy-aware scheduling.** Tasks live in sections (10 / 40 / 50) → departments → sub-departments. Sub-section headers in the grid + colored Gantt bars match the same hierarchy.
- **Predecessor graph with lag.** `5FS +1w`, `12SS -3d` etc. Server cascades start/end dates whenever you change a duration or a predecessor.
- **Work-day Gantt.** Weekends compressed out. Monday header labels, T/W/Th/F dashed lines. Bars stay on full days, never sub-day.
- **Multi-machine support.** Per-project machine sub-tabs, machine-colored bar borders, clone-machine flow that duplicates tasks with predecessor remapping.
- **Baseline snapshot.** Capture the original plan; drift chips show ahead / behind against baseline.
- **Quote vs Schedule modal.** Per-discipline comparison of estimated vs scheduled hours. Sales workspaces collapse the 10 detailed buckets into 5 combined ones.
- **Audit trail.** Every task create / update / delete logs to `task_history` with full before / after JSON.
- **Comments + @mentions.** Per-row 💬 badge opens a slide-in panel. @Name autocompletes against `team_members`; mentions trigger optional email.
- **Real-time sync.** Open two browser tabs — edits in one show up in the other within a second.
- **Optimistic concurrency.** Two users editing the same row → second save returns 409 + the latest server row instead of silent overwrite.
- **Role-based access.** `viewer` / `editor` / `admin`. Set per user via `create-admin.js`. With `AUTH_ENABLED=false` everyone is treated as admin.

---

## Stack

- **Server**: Node 22, Express, `node:sqlite` (built-in), `mssql`, Socket.io, jsonwebtoken, bcryptjs, nodemailer, node-cron.
- **Client**: vanilla JS — no framework. Frappe Gantt for the chart. SheetJS for xlsx import/export.
- **Persistence**: SQLite (`scheduler.db`) is the working store. Azure SQL (optional) is the durable shared copy.

---

## Configuration reference

All env vars are optional. Defaults shown below.

| Var | Default | Effect |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `AUTH_ENABLED` | `false` | Require JWT on every `/api/*` |
| `JWT_SECRET` | dev-only string | Used to sign tokens — **set this in prod** |
| `AZURE_SQL_SERVER` etc. | empty | Connect to Azure SQL when all 4 set |
| `AZURE_PUSH_ON_BOOT` | `false` | Overwrite Azure with local at startup |
| `AZURE_PULL_ON_BOOT` | `false` | Overwrite local with Azure at startup (destructive) |
| `SMTP_HOST` | empty | Enable email when set |
| `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | Standard SMTP config |
| `APP_URL` | `http://localhost:3000` | Used in mention email links |

---

## Working rules (for anyone editing this)

Read `CLAUDE.md`. The short version:

1. **Never bump the rev** in `public/release-notes.js`. Only Dan does that.
2. **Never tell anyone to open dev tools.** Use visible UI, in-app toasts, or just fix the thing.
3. **Never commit without being asked.**
4. **Never claim it works without verifying.**
5. **Keep the personal view aligned with the main Schedule view.** Same patterns, same layout, same row alignment.
