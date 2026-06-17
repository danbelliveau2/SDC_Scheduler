# SDC Scheduler — Database MCP server

A **read-only** [MCP](https://modelcontextprotocol.io) server that exposes the
SDC Scheduler database (and the read-only Total ETO bridge) to MCP clients
(Claude Code, Claude Desktop, etc.) over **Streamable HTTP**.

It reuses the app's existing MySQL pool (`mysqlDb.js`) and ETO bridge
(`etoDb.js`) — same `.env`, same connection.

## Safety (read-only by design)

- Only `SELECT` / `WITH` / `EXPLAIN` / `SHOW` / `DESCRIBE` are accepted.
- Every query runs inside `START TRANSACTION READ ONLY … ROLLBACK`, so writes
  are impossible at the database level even if one slipped past the guard.
- `mysql2` runs a single statement per call — stacked `;` statements are rejected.
- Results are row-capped (default 1000, max 5000).
- The endpoint requires a **bearer token** (`MCP_TOKEN`). The server refuses to
  start without one, since it exposes the database over the network.

An MCP client (or a bad prompt) **cannot mutate or delete data**.

## Configure

Add to `.env` (see `.env.example`):

```
MCP_TOKEN=<a long random secret>     # required
MCP_PORT=4100                        # optional (default 4100)
MCP_HOST=0.0.0.0                     # optional (default 0.0.0.0)
```

It also reads the usual `MYSQL_*` and `ETO_*` vars already in `.env`.

## Run

```
npm run mcp
# → [mcp] SDC Scheduler DB MCP server (read-only) on http://0.0.0.0:4100/mcp
```

Health probe (no auth): `GET http://<host>:4100/health`.

## Connect a client

**Claude Code (remote HTTP):**
```
claude mcp add --transport http sdc-db http://<host>:4100/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

**Generic MCP client / config JSON:**
```json
{
  "mcpServers": {
    "sdc-db": {
      "type": "http",
      "url": "http://<host>:4100/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

## Tools

| Tool | What it does |
|------|--------------|
| `list_tables` | All tables + approximate row counts |
| `describe_table` | Columns (name, type, nullability, key, default) for a table |
| `run_select` | Run one read-only query; returns rows as JSON (capped) |
| `eto_status` | Whether the Total ETO bridge is configured/reachable |
| `eto_project` | ETO project name/ID by job number |
| `eto_readiness` | BOM build-readiness (specs, rollups, parts, totals) for a job |
| `eto_vendors` | POs grouped by supplier with received progress |
| `eto_partcost` | Materials cost summary (estimated/purchased/received/paid/ETC) |

The `eto_*` tools appear only when the Total ETO bridge is configured.

## Notes

- Run as its own process — it does **not** start with the main app.
- It's deliberately not wired into the auto-deploy/PM2 flow; start it explicitly
  where you want the DB reachable.

---

# Claude Desktop extension (.dxt)

For a one-click **Claude Desktop** install there's a packaged extension under
[`dxt/`](dxt/). Unlike the HTTP server above, a `.dxt` runs the MCP server
**locally over stdio** — Claude Desktop launches it on your machine and prompts
for the MySQL connection on install. Same read-only guarantees (SELECT-only +
read-only transaction + row cap); no token needed since it's a local process.

Tools: `list_tables`, `describe_table`, `run_select` (scheduler MySQL only — for
the Total ETO tools, use the HTTP server above).

## Install
1. Open Claude Desktop → **Settings → Extensions**.
2. Drag in `mcp/sdc-scheduler-db.dxt` (or **Install from file**).
3. Enter the MySQL host / port / user / password / database when prompted.

## Build / rebuild the .dxt
The `.dxt` is a build artifact (gitignored). To (re)build it:

```
cd mcp/dxt
npm install --omit=dev          # self-contained deps for the bundle
npx @anthropic-ai/dxt pack . ../sdc-scheduler-db.dxt
```

Source lives in `mcp/dxt/` (`manifest.json`, `server/index.mjs`, `package.json`);
`node_modules/` and the built `*.dxt` are not committed.
