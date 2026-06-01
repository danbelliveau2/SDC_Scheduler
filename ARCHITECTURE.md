# Architecture

How the SDC Scheduler is wired together. Read `README.md` first for setup; read this when you need to know **why** something is shaped the way it is.

---

## 1. Runtime topology

```
┌──────────────┐  HTTP + WebSocket   ┌──────────────────┐  TDS   ┌──────────────────┐
│   Browser    │ ──────────────────► │   Node server    │ ─────► │   Azure SQL      │
│ (vanilla JS) │ ◄────────────────── │  (Express +      │ ◄───── │  [scheduler].*   │
│ app.js etc.  │   socket.io events  │   socket.io)     │ (push) │   (optional)     │
└──────────────┘                     └──────┬───────────┘        └──────────────────┘
                                            │
                                            ▼
                                     ┌──────────────────┐
                                     │  scheduler.db    │
                                     │  (SQLite, WAL)   │
                                     └──────────────────┘
```

- **SQLite is the working store.** Every read + write hits SQLite first (`node:sqlite`, synchronous, in-process — sub-millisecond).
- **Azure SQL is the durable shared copy.** Fire-and-forget pushes from SQLite to Azure on every mutation. Never blocks the HTTP response. Disabled by default.
- **Socket.io broadcasts invalidations.** When a write commits, server emits `tasks:updated` / `team:updated` / `settings:updated`. Other tabs hear it, debounce 250 ms, then re-fetch over REST.

---

## 2. Request lifecycle

A typical `PUT /api/tasks/123`:

```
client (app.js → api.update)
  └─► attach Bearer token (auth-ui.js wraps window.fetch)
  └─► attach `version` from state.tasks[123].version
  └─► HTTP PUT /api/tasks/123
       │
       ▼ requireAuth (auth.js)         ── 401 if no/expired token
       ▼ requireRole('editor')         ── 403 if viewer
       ▼ existing.version vs req.body  ── 409 STALE_VERSION if mismatch
       ▼ UPDATE tasks SET …            ── one row
       ▼ UPDATE tasks SET version+=1   ── bump for next concurrency check
       ▼ cascadeSchedule()             ── walk predecessor graph, push dates
       ▼ logHistory(…)                 ── append-only task_history row
       ▼ res.json(updated)             ── return new row to caller
       ▼ io.emit('tasks:updated')      ── invalidate other tabs
       ▼ azureSync.syncTable('tasks')  ── debounced 500ms then push to Azure
```

Steps 1-7 run synchronously inside the request handler. Steps 8-9 are fire-and-forget.

---

## 3. Database schema

See `db.js` for the full DDL. Every table is created `IF NOT EXISTS`, and additive columns use `ALTER TABLE … ADD COLUMN` migrations that re-run idempotently on every boot.

### Core
- **`tasks`** — the everything-table. Includes the `version` column for optimistic locking and `machine` for multi-machine projects.
- **`team_members`** — name + discipline (`mech` / `controls` / `pm` / `build` / `wire`). Drives the assignee dropdown.
- **`settings`** — key/value JSON blobs (palette, phase definitions, milestone library, theme).
- **`projects`** — name + workspace + job_number. Workspaces: `Active` / `Sales` / `Closed` / etc.
- **`project_financials`** — per-project payment milestones (PO, FAT, ship, etc.) with predecessor-style triggers.

### Phase additions
- **`task_history`** (Phase 1) — every create/update/delete with full before/after JSON.
- **`task_comments`** (Phase 2) — per-task threaded comments; FK to `tasks` with `ON DELETE CASCADE`.
- **`notification_log`** (Phase 2/7) — dedupe for emails, keyed on `reference_key`.
- **`users`** (Phase 3) — email + bcrypt hash + role + avatar_color. Only used when `AUTH_ENABLED=true`.

### What's NOT in the DB
- Layout state (column widths, split position, collapsed sections) — `localStorage`.
- Auth token — `localStorage('sdc_auth_token')`.
- Active machine subset / per-machine colors — `localStorage`.
- Personal view filters — `localStorage`.

---

## 4. The phases

Each phase is independently toggleable via env vars. See `.env.example`.

| # | Feature | Files | Env switch |
|---|---|---|---|
| 1 | Audit trail | `db.js`, `server.js:logHistory` | always on |
| 2 | Comments + @mentions | `comments-ui.js`, server routes | always on |
| 3 | Auth + JWT | `auth.js`, `auth-ui.js`, `create-admin.js` | `AUTH_ENABLED` |
| 4 | Socket.io real-time | `realtime-ui.js`, `presence-ui.js`, server `io.emit` | always on |
| 5 | Conflict detection | `tasks.version`, PUT handler 409 path | always on |
| 6 | Azure SQL sync | `azureDb.js`, `azureSync.js` | `AZURE_SQL_*` |
| 7 | Email + cron digest | `emailService.js`, `cronJobs.js` | `SMTP_HOST` |

---

## 5. Scheduling engine

The interesting bit. Lives in `server.js` (`cascadeSchedule`, `parsePredecessorRef`, `addBusinessDays` etc.).

- **All dates are business-day-only.** Weekends are skipped. `+1w` = 5 business days.
- **Predecessor syntax**: `5FS +1w` means "start after task 5 finishes, plus 1 week." Types: `FS` (default) / `SS` / `FF` / `SF`. Lag in `d` (days) or `w` (work weeks).
- **`cascadeSchedule()`** runs after every task mutation. It walks the topological order of predecessors and recomputes `start_date` / `end_date` for downstream rows. Idempotent.
- **Priority is per-assignee.** Each person has their own 1, 2, 3 … list. The PUT handler auto-collapses gaps + bumps conflicts.
- **Anchors** (Receipt of PO, Machine Power-Up, FAT, Ship Machine) are spine milestones. They can't be deleted, only edited. `inferredAnchorKey(task)` is the canonical check.

---

## 6. Client-side state

`public/app.js` is a 14 000-line everything-file. Sorry. The structure:

```
const api      = { … }      // fetch wrappers — one per endpoint
const state    = { … }      // single global; tasks, filters, layout, etc.
function render() { … }     // wholesale re-render: renderTable + renderGantt
function renderTable() …    // grid (LEFT pane)
function renderGantt()  …   // frappe-gantt + post-render decorators
function init()         …   // wires every button, fetches initial data
```

Patterns to follow when adding things:

- **Every drawer added to `renderGantt`'s chain must be wrapped in `try/catch`.** A throw inside one drawer skips every drawer after it, breaking zoom and bar-meta labels. See `CLAUDE.md` for the exact pattern.
- **Don't `wrap.insertBefore(elem, label)` on a frappe-gantt bar-wrapper.** `bar-label` is not a direct child — the call throws. Use `wrap.appendChild(elem)` and rely on z-order.
- **SVG `<text>` needs `style.fontFamily = 'sans-serif'` inline.** Otherwise frappe-gantt's stylesheet wins with an invisible font.
- **`state.gantt.gantt_start` is a Date object, not a string.** Pass it through `new Date(g.gantt_start)` before doing math.
- **`alignGanttToGrid()` keeps grid rows row-by-row aligned with Gantt bars.** If you add new row types, make sure they get a `data-id` so the alignment pass finds them.

---

## 7. Real-time sync (Phase 4)

Server side (`server.js`):

```js
const server = http.createServer(app);
const io     = new SocketIO(server, { cors: { origin: '*' } });
// after a task save:
io.emit('tasks:updated', { project: 'Test_Project' });
```

Client side (`realtime-ui.js`):

```js
const socket = io('/', { transports: ['websocket', 'polling'] });
socket.on('tasks:updated', () => {
  if (Date.now() - window._lastLocalEdit < 800) return; // skip self-echo
  setTimeout(() => loadTasks(), 250);                   // debounce burst
});
```

The 800 ms self-echo skip is the critical bit. Without it, every save would trigger an immediate re-fetch, which would re-render the grid mid-edit and steal focus from any inline input.

Presence (`presence-ui.js`) is layered on top. Each client emits `presence:join` with `{ project, user }` on connect; server tracks per-project sets and broadcasts `presence:update` whenever the membership changes.

---

## 8. Azure sync (Phase 6)

`azureSync.js` is **push-only** by default. The flow:

1. Server boot: `azureSync.init(db)` connects, calls `azureDb.ensureSchema()` (idempotent `CREATE TABLE IF NOT EXISTS`), marks ready.
2. (Optional) If `AZURE_PUSH_ON_BOOT=true`: full overwrite local → Azure.
3. (Optional) If `AZURE_PULL_ON_BOOT=true`: full overwrite Azure → local (**destructive**).
4. Every `app.put/post/delete` ends with `sync('tasks')` (or 'team_members' / 'settings' / etc.).
5. `syncTable(name)` debounces 500 ms then runs `_pushTable(name)`:
   - For `tasks` / `team_members` / `project_financials` / `projects`: `DELETE FROM [scheduler].<table>; INSERT …` for every local row.
   - For `task_history` / `task_comments`: append-only — `MAX(id)` cursor + `INSERT` new rows.
   - For `settings`: row-by-row `MERGE`.

The DELETE+INSERT pattern is dumb but safe — there's no merge logic to get wrong. On a 185-task project the push takes ~1-2s. Always async, never blocks the response.

Manual override:

- `POST /api/azure/push` (admin) — full overwrite, useful after a local-only batch import.
- `POST /api/azure/pull` (admin) — full overwrite the other way. **Make a backup of `scheduler.db` first.**

---

## 9. Auth (Phase 3)

`auth.js` is a thin JWT middleware:

```js
app.post('/api/auth/login',    publicRoute)  // bcrypt compare, signs JWT
app.post('/api/auth/register', publicRoute)  // bcrypt(12), inserts users row
app.get ('/api/auth/me',       requireAuth)  // verify token, return payload
app.use(requireAuth)                          // every subsequent /api/* gated
app.post('/api/tasks',         requireRole('editor'), …)
app.put ('/api/settings/:key', requireRole('admin'),  …)
```

When `AUTH_ENABLED=false`:
- `requireAuth` stamps `req.authUser` with a synthetic admin (`{id:0, role:'admin'}`) and continues.
- `requireRole` is a no-op.
- The login modal never appears (client gets `auth_enabled:false` from `/api/auth/me`).

Roles ranked low → high: `viewer` (read-only) → `editor` (task/team CRUD) → `admin` (settings, project delete, Azure sync).

---

## 10. Conflict detection (Phase 5)

Optimistic locking via an integer `version` column on `tasks`:

```
client GET /api/tasks  → row { id:42, version:5, … }
client edits, sends PUT /api/tasks/42 { notes:"x", version:5 }
server: existing.version === 5 → OK, UPDATE row, bump version → 6, return
```

If another tab saved first, `existing.version` is 6 by the time you PUT:

```
server: existing.version (6) !== body.version (5) → 409
body: { error:"…", code:"STALE_VERSION", server_version:6, server_row:{…} }
client (api.update): toast "Someone else just edited this row. Reloading…"
client: loadTasks() → fresh data
```

`api.update` (in `app.js`) handles the 409 transparently. Callers don't need to know.

---

## 11. Why some things are weird

- **`public/app.js` is one giant file.** Splitting it into modules without a bundler would require ESM imports, which means a build step. We don't want a build step. The cost of "one big file" is offset by "no toolchain to maintain."
- **`node:sqlite` is experimental.** Yes, you'll see a warning on every boot. The API is stable and the perf is excellent; the experimental flag is about the module name, not the implementation.
- **`frappe-gantt` is pinned at `0.6.1`.** Later versions changed the SVG structure and broke our `appendChild` overlays. Don't upgrade without testing every drawer.
- **The Gantt redraws on every save.** It's wasteful but works. A diff-based redraw is on the wishlist but not worth the complexity yet.
- **Every drawer in `renderGantt()` is wrapped in `try/catch`.** See `CLAUDE.md` — this rule cost a half day of debugging. Don't break it.

---

## 12. Where to add things

- **New API endpoint?** Add it in `server.js` next to the related routes. Guard with `requireRole('editor')` or `'admin'`. End with `io.emit('tasks:updated')` if it changed tasks, and `sync('tasks')` for Azure.
- **New grid column?** Edit the `FIELDS` array (top of `server.js`) and the column rendering in `app.js` (`renderHeaders` + the cell builders).
- **New phase / discipline?** Edit `public/phases.js` — the `HIERARCHY` constant drives every grid + Gantt walk.
- **New Gantt overlay?** Add a `drawXyz()` function in `app.js`. Wrap the body in `try/catch`. Call it from `renderGantt()` before `drawBarMeta`. Use `wrap.appendChild`, not `insertBefore`. See `CLAUDE.md`.
- **New setting?** Add it to `DEFAULT_SETTINGS` in `db.js`. Render the editor in the `view-setup` section of `index.html`. Persist via `api.putSetting(key, value)`.
