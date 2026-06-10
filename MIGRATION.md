# MySQL Migration — what this branch does

This branch replaces the SQLite backend with MySQL (`mysql2/promise`), so dev
and production run the **same code** against **separate databases** chosen by
`.env`. The frontend is untouched — it is your Rev 8.0 exactly.

## What changed

| File | Change |
|---|---|
| `server.js` | All `db.prepare(...)` → `await pool.query(...)`. Same routes, same behavior. Passed 93 UAT checks against production. |
| `db.js` | MySQL schema bootstrap (CREATE TABLE IF NOT EXISTS on boot) + exports the connection pool. |
| `mysqlDb.js` | The mysql2 connection pool, configured from `.env`. |
| `cronJobs.js` | Digest cron rewritten for the async pool. |
| `create-admin.js` | Admin bootstrap rewritten for MySQL. |
| `migrate-sqlite-to-mysql.js` | One-time importer if you want your local SQLite data copied into a MySQL schema. |
| `package.json` | + `mysql2`, − `mssql` (Azure layer is gone). |
| `azureDb.js`, `azureSync.js`, `migrate.js` | Deleted (dead code). |

## Setup after merging (one time)

1. `npm install`
2. Create `.env` (see `.env.example`). Two options:
   - **Dev sandbox** (recommended for coding): point at the `sdc_scheduler_dev`
     schema on SERVER-APP1 — your test data stays out of production.
   - For **real scheduling work**, don't run locally at all — just use
     http://SERVER-APP1:4003 in the browser. That writes straight to the
     production database.
3. `node server.js` — tables are created automatically on first boot.
4. Optional: `node create-admin.js you@sdcautomation.com yourpassword admin`

## Why

One codebase on both machines means backend changes you push deploy to the
production server automatically (its auto-updater pulls `main` every 2 min) —
no more SQLite-vs-MySQL porting gap.
