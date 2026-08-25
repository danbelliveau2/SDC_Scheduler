# Service Log Replacement — implementation notes

Replaces the Smartsheet Service workflow. Built to Monica's R2 requirements.

```
Customer request (website)
  → service_requests row            ← this IS the Service Log
  → 1..n service_work_orders        ← internal Work Orders
  → assigned SDC employee           ← existing team_members roster
  → a linked `tasks` row            ← so it shows in normal Scheduler workload
  → employee marks complete
  → service_reports row             ← generated, prepopulated
```

## Files

| File | What it is |
|---|---|
| `db.js` | Five new tables (see below). Additive `CREATE TABLE IF NOT EXISTS`, runs on boot. |
| `routes/service.js` | The whole API. Exports `{ router, publicRouter }` plus `reminderSweep` for cron. |
| `lib/serviceNotify.js` | Work Order email + day-before reminder + optional Teams webhook. |
| `lib/cronJobs.js` | Registers the 07:00 ET reminder sweep. |
| `lib/emailService.js` | `_sendOnce` is now exported so the above can reuse the dedupe. |
| `public/service-request.html` | The customer-facing form. Standalone, no login. |
| `public/service-ui.js` / `.css` | The internal Service module UI. |
| `public/index.html` | Sidebar entry, `#view-service` section, script/style tags. |
| `public/app.js` | One line in `setView()`. Nothing else. |
| `public/realtime-ui.js` | `service:updated` socket handler. |

## Tables

- **`service_requests`** — the Service Log. Customer fields and the internal
  management fields (`quote_sent`, `po_received`, `service_complete`,
  `resource_assigned`, `current_status`, `information_needed`,
  `service_complete_date`) on one row. `request_no` is `SR-YYYY-NNNN`.
- **`service_work_orders`** — WOs, `SR-YYYY-NNNN-WOn`, FK to the request.
  `task_id` links to the `tasks` row that puts it in the employee's workload.
- **`service_attachments`** — metadata; files live on disk.
- **`service_reports`** — one per WO, generated at completion.
- **`service_history`** — the audit trail.

## Configuration

All optional — the module works without any of these, degrading sensibly.

| Env var | Default | Effect |
|---|---|---|
| `SERVICE_UPLOAD_DIR` | `<app>/uploads/service` | Where attachments land. Must be writable and **backed up** — it is customer data the DB dump does not contain. |
| `SERVICE_MAX_FILE_MB` | `25` | Per-file upload cap. |
| `SERVICE_INTAKE_EMAIL` | *(unset)* | Address notified when a website request arrives. Unset = no intake alert. |
| `SERVICE_PUBLIC_RATE_MAX` | `8` | Max public submissions per IP per hour. |
| `TEAMS_WEBHOOK_URL` | *(unset)* | Incoming Webhook for Work Order cards. Unset = email only. |
| `APP_URL` | `http://localhost:3000` | Base for the "Open Work Order" link in emails. **Set this** or the links are useless. |
| `SMTP_*` | *(unset)* | Existing config. Without it, notifications are logged, not sent. |

New dependency: **`multer` ^2.2.0** (2.x — the 1.x line has open CVEs).

> **Note:** `SDC_Scheduler` is an npm *workspace* of the parent `sdc-tools`
> monorepo. The lockfile that records multer is the **parent's**
> `package-lock.json`, not the vestigial one in this repo. Both repos need
> committing or a clean install will not pull multer and the app will fail to
> boot on `require('multer')`.

## Website integration

Point the SDC website at:

```
https://<scheduler-host>/service-request.html
```

Link or iframe it. Or build a form against the API directly:

- `GET  /api/public/service-options` — the dropdown vocabulary (use this rather
  than hardcoding, so the two can't drift)
- `POST /api/public/service-requests` — accepts multipart, urlencoded or JSON.
  Required: `company_name`, `requestor_name`, `requestor_email`,
  `requestor_phone`, `machine_serial`, `urgency`, `service_details`.
  Returns `{ ok: true, request_no: "SR-2026-0001" }`.

Both are mounted above the global auth guard. The POST is create-only,
rate-limited and honeypot-guarded (a `website` field that must stay empty).

## Deliberate decisions

- **No ETO quote/order link** (§5). Documented as not currently possible.
  Nothing here depends on one, and the schema leaves room for it.
- **No invented status pipeline** (§17). `current_status` is free text with
  suggestions; the three checkboxes stay separate fields because they are
  separate facts.
- **Service Report is an in-app record.** `service_reports.folder_path` is the
  seam for "generate into the Service Request folder" — the folder convention
  has not been confirmed yet. When it is, a generator can write the document and
  stamp the path with no schema or API change.
- **`work_performed` is NOT prepopulated.** Seeding it from the task description
  would silently satisfy the submit gate, letting a report be filed without
  anyone describing the actual visit. The task description is shown in the
  prefill block to work from.
- **`service_complete` is never auto-ticked.** When the last WO completes the UI
  says so and lets the coordinator decide — the customer may still owe sign-off.
- **No Service-only employee roster** (§7). Employees come from `team_members`
  joined to `users` for the email address.

## Not built yet

- **Scheduled service contracts (§12)** — §12 says to inspect the real contract
  data before writing recurrence rules rather than inventing frequencies. That
  data has not been looked at yet. Everything needed to generate a WO on a
  schedule already exists; only the recurrence definition is missing.
- **Migration of existing Service data (§21)** — needs the "what do we actually
  need to keep" decision first.
- **Teams beyond an Incoming Webhook** — no Graph client exists in this codebase.
  Real per-user Teams messages would need an app registration.

## Duplicate-reminder prevention (§9)

Threefold, none of it in the cron file:

1. The sweep only selects `reminder_sent_at IS NULL`.
2. It stamps that column on send.
3. The send goes through `notification_log`'s UNIQUE `reference_key`, which
   carries the task date — so rescheduling a WO to a new date correctly earns a
   fresh reminder instead of being suppressed as a duplicate.
