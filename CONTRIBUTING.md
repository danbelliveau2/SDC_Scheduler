# Contributing

Short version: read `CLAUDE.md`, branch off `main`, keep PRs small, never bump the rev.

---

## Local setup

```bash
git clone https://github.com/danbelliveau2/SDC_Scheduler.git
cd SDC_Scheduler
npm install
cp .env.example .env             # leave AUTH_ENABLED=false for local dev
node server.js
```

Open `http://localhost:3000`. Hot reload? Use `node --watch server.js` (built into Node 22+) — the server restarts on file save. The client doesn't hot-reload; refresh the browser after editing `public/*`.

---

## Branches

- `main` — stable. Dan pushes revs here.
- `feature/<short-name>` — your work. Branch off `main`, keep it small.
- `fix/<short-name>` — bug fixes.

PR target is always `main`. Don't merge into `main` yourself; open a PR for review.

---

## Commit style

One concrete change per commit. Imperative subject ≤ 70 chars, ends without a period:

```
Add @mention email notifications

Hook emailService.sendMentionEmail into the comment POST handler.
Looks up the @mentioned user's email from the users table; falls
back to no-op when SMTP_HOST is empty.
```

Avoid:
- `WIP`, `fix stuff`, `update`
- Reformat-only commits mixed with logic changes — split them
- Bumping the rev in `public/release-notes.js` (only Dan does that)

---

## The hard rules

Lifted from `CLAUDE.md`. These are not suggestions:

1. **Never bump the rev** in `public/release-notes.js`.
2. **Never tell the user to open dev tools.** Use visible UI, in-app toasts, or just fix the thing.
3. **Never commit secrets.** `.env`, credential files, anything matching `azure-backup-*.json` are gitignored — keep it that way.
4. **Never claim it works without verifying.** Run the curl / open the page / read the rows in the DB.
5. **Keep the personal view (Actions tab) aligned with the main Schedule view.** Same patterns, same column headers, same row-by-row Gantt alignment.

---

## Where things go

| You want to … | Edit … |
|---|---|
| Add an API endpoint | `server.js` next to related routes; guard with `requireRole(…)`; end with `io.emit(…)` + `sync(…)` |
| Add a grid column | `FIELDS` in `server.js`, `renderHeaders` + cell builders in `public/app.js` |
| Add a Gantt overlay | New `drawXyz()` in `public/app.js`, wrapped in `try/catch`, called from `renderGantt()` |
| Add a setting | `DEFAULT_SETTINGS` in `db.js` + editor in `view-setup` of `public/index.html` |
| Add a phase / discipline | `HIERARCHY` in `public/phases.js` |
| Add a Socket.io event | Server: `io.emit('your:event', payload)`. Client: `socket.on('your:event', …)` in `public/realtime-ui.js` |

---

## Common pitfalls (lessons from past pain)

- **Every drawer in `renderGantt()` must be `try/catch`-wrapped.** A throw inside one drawer skips every drawer after it. Half-day debugging tax.
- **Don't `wrap.insertBefore(elem, label)` on a frappe-gantt bar-wrapper.** Use `appendChild` and rely on z-order.
- **SVG `<text>` needs `style.fontFamily = 'sans-serif'` inline.** Otherwise it inherits an invisible font.
- **`state.gantt.gantt_start` is a Date object.** Don't concatenate strings to it — wrap in `new Date(…)`.
- **Inputs flicker on save because of Socket.io.** Add `window._lastLocalEdit = Date.now()` before the fetch; the client suppresses self-echoes within 800 ms.

---

## Adding a new phase

If you're porting another feature from Abhi's `feature/smartsheet-architecture` branch (or building something new of similar scope):

1. **Schema first.** Add the `CREATE TABLE IF NOT EXISTS` to `db.js`. Make it additive — never `DROP` or `ALTER` in destructive ways.
2. **Server route.** Add to `server.js`, guard with `requireRole`, emit a Socket.io invalidate, call `sync(…)` for Azure.
3. **Client UI.** Create a new file under `public/` (don't bloat `app.js`). Wire it into `index.html` with a `<script>` tag.
4. **Env flag.** If the feature needs external creds or could damage data, gate it behind an env var that defaults to off. Document in `.env.example`.
5. **Smoke test.** Add curl commands to your PR description that prove the happy path + at least one error path.

---

## Testing

There's no test suite yet — additions welcome. For now, every change ships with a hand-curled verification: a `curl` command + expected response in the PR description.

For UI work: list the steps you took in the browser and the visible result. Don't say "tested" without listing what you actually clicked.

---

## When in doubt

Ask once in chat, then move forward. Don't sit on a question for hours.
