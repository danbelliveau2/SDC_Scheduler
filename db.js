/**
 * db.js — MySQL schema bootstrap for the SDC Scheduler.
 *
 * Call init() once at startup to create all tables.
 * Export pool for use in server.js.
 */
require('dotenv').config();
const { pool } = require('./lib/mysqlDb');

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      name                  VARCHAR(255) NOT NULL,
      project               VARCHAR(255),
      phase                 VARCHAR(255),
      phase_group           VARCHAR(255),
      department            VARCHAR(255),
      sub_department        VARCHAR(255),
      assignee              VARCHAR(255),
      start_date            VARCHAR(32),
      end_date              VARCHAR(32),
      duration_days         INT,
      predecessors          TEXT,
      is_milestone          TINYINT(1) DEFAULT 0,
      progress              INT DEFAULT 0,
      allocation            INT DEFAULT 100,
      priority              INT DEFAULT 1,
      notes                 TEXT,
      sort_order            DOUBLE DEFAULT 0,
      anchor_key            VARCHAR(255),
      baseline_start_date   VARCHAR(32),
      baseline_end_date     VARCHAR(32),
      duration_link_task_id INT,
      is_action             TINYINT(1) DEFAULT 0,
      dates_locked          TINYINT(1) DEFAULT 0,
      completed_on          VARCHAR(32),
      machine               VARCHAR(255),
      version               INT DEFAULT 1,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const [col, idx] of [['phase','idx_tasks_phase'],['project','idx_tasks_project'],['assignee','idx_tasks_assignee']]) {
    await pool.query(`ALTER TABLE tasks ADD INDEX ${idx} (${col})`).catch(() => {});
  }

  // Repair: tables created before this schema text had version DEFAULT 0.
  // A version-0 row trips the optimistic-lock check on its FIRST edit (clients
  // send `version || 1`), so every new task showed a bogus 409 conflict.
  await pool.query(`ALTER TABLE tasks MODIFY COLUMN version INT DEFAULT 1`).catch(() => {});
  await pool.query(`UPDATE tasks SET version = 1 WHERE version = 0 OR version IS NULL`).catch(() => {});

  // Manual date lock: when a user edits a task's start/finish date, the task is
  // pinned (dates_locked=1) so the predecessor cascade stops overwriting the
  // hand-set dates. Editing the task's predecessors clears the pin again.
  await pool.query(`ALTER TABLE tasks ADD COLUMN dates_locked TINYINT(1) DEFAULT 0`).catch(() => {});
  // Person-transition join: a task with join_prev=1 displays ON the previous
  // row's line (one person rolling from one task straight into the next).
  // Display-level only — scheduling math still sees two tasks.
  await pool.query(`ALTER TABLE tasks ADD COLUMN join_prev TINYINT(1) DEFAULT 0`).catch(() => {});

  // Idempotency key for POST /api/tasks (2026-08-13) — a value the CLIENT
  // generates once per create attempt and resends unchanged on every retry.
  // The UNIQUE index is what lets a retried create detect "I already did
  // this" instead of inserting a duplicate row when a first attempt's INSERT
  // committed but its response never reached the browser. Null for every
  // task created before this existed.
  await pool.query(`ALTER TABLE tasks ADD COLUMN client_ref VARCHAR(64) NULL`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD UNIQUE INDEX idx_tasks_client_ref (client_ref)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      \`key\`      VARCHAR(255) PRIMARY KEY,
      value        TEXT NOT NULL,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      discipline  VARCHAR(255) NOT NULL,
      active      TINYINT(1) DEFAULT 1,
      sort_order  DOUBLE DEFAULT 0,
      is_lead     TINYINT(1) DEFAULT 0,
      specialty   VARCHAR(255),
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`ALTER TABLE team_members ADD INDEX idx_team_discipline (discipline)`).catch(() => {});
  // Stable link into ETC Planner's Employee.id (2026-08-13) — the shared
  // source of truth for the 7 delivery-team groupings, replacing the old
  // name-matched sync. Null for placeholders (ME Placeholder, etc.) and for
  // the 5 back-office disciplines that stay Scheduler-local; see
  // routes/team.js for where a linked row's discipline/active get written
  // through to the shared Employee row.
  await pool.query(`ALTER TABLE team_members ADD COLUMN employee_id INT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE team_members ADD INDEX idx_team_employee (employee_id)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_financials (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      project        VARCHAR(255) NOT NULL,
      name           VARCHAR(255) NOT NULL,
      percent        DOUBLE,
      amount         DOUBLE,
      due_date       VARCHAR(32),
      paid           TINYINT(1) DEFAULT 0,
      predecessors   TEXT,
      sync_to_anchor VARCHAR(255),
      sort_order     DOUBLE DEFAULT 0,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`ALTER TABLE project_financials ADD INDEX idx_financials_project (project)`).catch(() => {});
  // Multi-machine payment terms: each financial milestone can belong to a
  // machine (M1/M2/…). NULL/'' = M1 / single-machine project (legacy rows).
  await pool.query(`ALTER TABLE project_financials ADD COLUMN machine VARCHAR(32)`).catch(() => {});
  // Invoice lifecycle (Invoicing tab): ready is DERIVED from the trigger
  // task's progress; sent + paid are explicit states with dates. The old
  // single `paid` flag doubled as "sent" — the one-time UPDATE carries it
  // into `sent` so history lands in a sensible bucket.
  await pool.query(`ALTER TABLE project_financials ADD COLUMN sent TINYINT(1) DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE project_financials ADD COLUMN sent_at VARCHAR(32)`).catch(() => {});
  await pool.query(`ALTER TABLE project_financials ADD COLUMN paid_at VARCHAR(32)`).catch(() => {});
  // Payment terms in days (Net 30 etc.) — NULL means the default (30).
  // Drives the "sent but not paid → past due" split on the Invoicing tab.
  await pool.query(`ALTER TABLE project_financials ADD COLUMN terms_days INT`).catch(() => {});
  await pool.query(`UPDATE project_financials SET sent = 1 WHERE paid = 1 AND sent = 0`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      status      VARCHAR(64) DEFAULT 'active',
      is_template TINYINT(1) DEFAULT 0,
      job_number  VARCHAR(255),
      workspace   VARCHAR(255) DEFAULT 'default',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_projects_name (name)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_history (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      task_id        INT,
      project        VARCHAR(255),
      action         VARCHAR(32) NOT NULL,
      changed_by     VARCHAR(255),
      changed_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      before_json    MEDIUMTEXT,
      after_json     MEDIUMTEXT,
      changed_fields TEXT
    )
  `);
  await pool.query(`ALTER TABLE task_history ADD INDEX idx_history_project (project)`).catch(() => {});
  await pool.query(`ALTER TABLE task_history ADD INDEX idx_history_changed_at (changed_at)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      task_id     INT NOT NULL,
      project     VARCHAR(255),
      author_id   INT,
      author_name VARCHAR(255) NOT NULL,
      body        TEXT NOT NULL,
      mentions    TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_comments_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  await pool.query(`ALTER TABLE task_comments ADD INDEX idx_comments_task_id (task_id)`).catch(() => {});
  await pool.query(`ALTER TABLE task_comments ADD INDEX idx_comments_project (project)`).catch(() => {});
  // Clean up comments orphaned by past task deletes (the live DB has no FK
  // cascade, and the delete path historically didn't remove them). Idempotent —
  // a no-op once clean. The delete handler now keeps this from recurring.
  await pool.query(`DELETE FROM task_comments WHERE task_id NOT IN (SELECT id FROM tasks)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      user_email    VARCHAR(255) NOT NULL,
      type          VARCHAR(64) NOT NULL,
      task_id       INT,
      sent_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      reference_key VARCHAR(255) UNIQUE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      email         VARCHAR(255) UNIQUE NOT NULL,
      name          VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role          VARCHAR(32) DEFAULT 'editor',
      avatar_color  VARCHAR(32) DEFAULT '#1574c4',
      active        TINYINT(1) DEFAULT 1,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login    VARCHAR(64)
    )
  `);
  await pool.query(`ALTER TABLE users ADD INDEX idx_users_email (email)`).catch(() => {});
  // Bumped to invalidate every previously-issued JWT for this user — the
  // server-side half of "sign out" (JWTs are otherwise stateless and would
  // keep working until their natural 30-day expiry regardless). Embedded in
  // signToken()'s claims, re-checked on every request in the active-flag
  // middleware right below the global requireAuth in server.js. Also what a
  // Reports-side logout calls out to bump, over POST /api/auth/revoke-session
  // — the mirror of what THIS app's own logout does to Reports.
  await pool.query(`ALTER TABLE users ADD COLUMN token_version INT DEFAULT 0`).catch(() => {});
  // Stable link into Reports' User.id (shared-account project, 2026-08-13) —
  // Reports is the one place a password actually lives; a linked row's own
  // password_hash stops being checked (see routes/auth.js's POST
  // /api/auth/login) once this is set. UNIQUE because the reverse is also
  // true: a given Reports account should never end up linked from two
  // different Scheduler rows. Null for anyone not yet linked — see
  // scripts/link-etc-users.js for the one-time backfill and routes/auth.js's
  // POST /api/auth/sso for how a brand-new row gets this set going forward.
  await pool.query(`ALTER TABLE users ADD COLUMN reports_user_id INT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD UNIQUE INDEX idx_users_reports_user_id (reports_user_id)`).catch(() => {});
  // Normalize any legacy emails stored with stray case/whitespace so they match
  // the trim+lowercase login lookup. Per-row + guarded so a (rare) collision
  // can't abort boot. Idempotent — only touches rows that aren't already clean.
  try {
    const [dirty] = await pool.query('SELECT id, email FROM users WHERE email <> LOWER(TRIM(email))');
    for (const r of dirty) {
      try { await pool.query('UPDATE users SET email = ? WHERE id = ?', [String(r.email).trim().toLowerCase(), r.id]); }
      catch (e) { console.warn(`[db] could not normalize email for user ${r.id}: ${e.message}`); }
    }
    if (dirty.length) console.log(`[db] normalized ${dirty.length} user email(s) to trim+lowercase`);
  } catch (_) { /* users table may be mid-migration on a fresh DB */ }

  // Per-app roles for SDC Tools apps that have their own role concept but no
  // users table of their own (today: Calendar's admin/hr/manager/employee).
  // Scheduler's own role stays in `users.role` above — not duplicated here.
  // Read/written by routes/ssoCentral.js (the central SSO exchange) and
  // seeded from each app's pre-migration role source by a one-time backfill
  // script run at that app's cutover — see scripts/link-etc-users.js for the
  // precedent this follows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdc_app_roles (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      email      VARCHAR(255) NOT NULL,
      app        VARCHAR(32) NOT NULL,
      role_value VARCHAR(32) NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY idx_sdc_app_roles_email_app (email, app)
    )
  `);

  // Per-job materials-estimate override (PM-entered). ETO is read-only and its
  // EstTotalMaterials is often unset, so PMs can enter the real estimate here;
  // the Procurement Cost tab uses it for the "vs estimate" + ETC figures.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_estimates (
      job                VARCHAR(255) PRIMARY KEY,
      materials_estimate DECIMAL(14,2),
      updated_by         VARCHAR(255),
      updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // v9.0: "Parts in Shop" — PM-facing list of parts physically at the SDC shop.
  // NOTE: `rank` is a reserved word in MySQL 8 — must be backticked everywhere.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_parts (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      \`rank\`           INT,
      job               VARCHAR(255),
      qty               INT,
      part_no           VARCHAR(255),
      description       TEXT,
      shop_release      VARCHAR(32),
      new_mod           VARCHAR(255),
      location          VARCHAR(255),
      out_for_finishing VARCHAR(255),
      priority          VARCHAR(32),
      comments          TEXT,
      engineer          VARCHAR(255),
      pm                VARCHAR(255),
      added_to_bom      TINYINT(1) DEFAULT 0,
      part_complete     TINYINT(1) DEFAULT 0,
      completed_on      VARCHAR(32),
      sort_order        DOUBLE DEFAULT 0,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`ALTER TABLE shop_parts ADD INDEX idx_shop_parts_job (job)`).catch(() => {});

  // ── ETO receiving link (2026-08-26) ────────────────────────────────────────
  // Most parts on this page are FABRICATED in the SDC shop and have no PO at all
  // — measured 58 of 61 rows when this was built. A minority are farmed out
  // (outside machining, anodizing) and arrive on a vendor PO, and for those the
  // ETO receipt IS the completion event, so ticking Done by hand is duplicate
  // data entry.
  //
  // `eto_po` is therefore deliberately NULLable and opt-in: a PM entering a PO
  // number is the explicit statement "this one is bought, not made". Nothing
  // automatic touches a row with a NULL eto_po, so a shop-made part can never be
  // auto-completed by a coincidence.
  //
  // Keying on the PO (not the part number alone) is what makes this safe. Part
  // numbers repeat across orders: 1147-FB-003 was received on PO 104448 on
  // 2026-04-21, and a NEW row for that same part number was created 2026-08-26
  // for a re-order. Matching on part number alone would have marked the new row
  // complete off the April receipt. Naming the PO excludes it structurally.
  //
  // The eto_* columns below are a CACHE of ETO's answer, refreshed by
  // etoDb.syncShopPartReceipts on the existing 30-min ETO cron. ETO stays the
  // system of record; nothing here is ever written back to it.
  await pool.query(`ALTER TABLE shop_parts ADD COLUMN eto_po VARCHAR(32) NULL`).catch(() => {});
  // Received/ordered qty summed across every line for this part on that PO — a
  // single shop part routinely spans several lines (1147-FB-003 is two lines of
  // qty 1 against a shop qty of 2, so per-line matching would never complete).
  await pool.query(`ALTER TABLE shop_parts ADD COLUMN eto_received_qty INT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE shop_parts ADD COLUMN eto_po_qty INT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE shop_parts ADD COLUMN eto_received_on VARCHAR(32) NULL`).catch(() => {});
  await pool.query(`ALTER TABLE shop_parts ADD COLUMN eto_synced_at DATETIME NULL`).catch(() => {});
  // Audit: how a row got completed. NULL = a person ticked the box (every row
  // that predates this feature). Set to e.g. 'ETO PO 104448' by the sync, so the
  // shop can always tell an automated close from a human one.
  await pool.query(`ALTER TABLE shop_parts ADD COLUMN completed_source VARCHAR(64) NULL`).catch(() => {});
  // Why the sync declined to auto-complete a fully-received row, e.g. 'receipt
  // predates part'. Persisted rather than inferred client-side from "received
  // but still open", which would also match a row someone just un-ticked and a
  // row this sync has not reached yet. NULL = no hold.
  await pool.query(`ALTER TABLE shop_parts ADD COLUMN eto_hold_reason VARCHAR(64) NULL`).catch(() => {});
  await pool.query(`ALTER TABLE shop_parts ADD INDEX idx_shop_parts_eto_po (eto_po)`).catch(() => {});

  // v9.0: "Vendor PO Track" — every PO sent to an outside vendor. Status derived
  // client-side from complete/partial + ETA (PO Date + Lead Time weeks).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendor_pos (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      priority      INT,
      po            VARCHAR(255),
      job           VARCHAR(255),
      vendor        VARCHAR(255),
      po_date       VARCHAR(32),
      lead_time     INT,
      eta           VARCHAR(32),
      ship_date     VARCHAR(32),
      delivery_date VARCHAR(32),
      tracking      VARCHAR(255),
      po_price      VARCHAR(64),
      pm            VARCHAR(255),
      comments      TEXT,
      partial       TINYINT(1) DEFAULT 0,
      complete      TINYINT(1) DEFAULT 0,
      completed_on  VARCHAR(32),
      sort_order    DOUBLE DEFAULT 0,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`ALTER TABLE vendor_pos ADD INDEX idx_vendor_pos_vendor (vendor)`).catch(() => {});
  // ETO integration: rows pulled from Total ETO are flagged so the sync can
  // refresh status fields without clobbering PM-entered rows.
  await pool.query(`ALTER TABLE vendor_pos ADD COLUMN eto_synced TINYINT(1) DEFAULT 0`).catch(() => {});
  // Pre-revision ETA — when a buyer revises dates in ETO, eta carries the new
  // promise and eta_original keeps the initial one so rows can show the slip.
  await pool.query(`ALTER TABLE vendor_pos ADD COLUMN eta_original VARCHAR(32)`).catch(() => {});
  // Separate Power BI job ID — lets a project link a different job number for
  // hours data than the one used for ETO (e.g. multi-job rollups like "1129&1143").
  await pool.query(`ALTER TABLE projects ADD COLUMN hours_job_id VARCHAR(255)`).catch(() => {});
  // Live customer share links: a random token per project; anyone holding it
  // gets READ-ONLY, project-scoped access to the customer view (no login).
  await pool.query(`ALTER TABLE projects ADD COLUMN share_token VARCHAR(64)`).catch(() => {});
  await pool.query(`ALTER TABLE projects ADD UNIQUE INDEX idx_projects_share_token (share_token)`).catch(() => {});
  // Snapshot pulled from the SDC ETC Planner when a project is created from its
  // job list. billable + the release/delivery estimate dates are captured once
  // at create time; live actuals-vs-execution are fetched on demand via
  // /api/planner/jobs/:jobId (never stored, so they can't go stale).
  await pool.query(`ALTER TABLE projects ADD COLUMN billable TINYINT(1)`).catch(() => {});
  await pool.query(`ALTER TABLE projects ADD COLUMN po_start_date DATE`).catch(() => {});
  await pool.query(`ALTER TABLE projects ADD COLUMN est_start_date DATE`).catch(() => {});
  await pool.query(`ALTER TABLE projects ADD COLUMN complete_date DATE`).catch(() => {});
  await pool.query(`ALTER TABLE projects ADD COLUMN planner_synced_at DATETIME`).catch(() => {});
  // Contract value + customer PO number on the project itself. Distinct from
  // project_financials, which models *billing milestones*: a service or T&M job
  // has a single PO / not-to-exceed figure that is not a milestone and has no
  // due date, and forcing it into a 100%-milestone row misreports the billing
  // schedule. DECIMAL(12,2) — money is never a float here.
  await pool.query(`ALTER TABLE projects ADD COLUMN contract_value DECIMAL(12,2)`).catch(() => {});
  await pool.query(`ALTER TABLE projects ADD COLUMN po_number VARCHAR(64)`).catch(() => {});
  // Clean up duplicate (po, job) rows left by syncs that overlapped before the
  // sync serializer existed. Conservatively deletes only the higher-id copy and
  // only when it carries NO PM-entered data — so manual edits are never lost; a
  // dupe where both copies have PM data is left for a human to reconcile.
  await pool.query(`
    DELETE v1 FROM vendor_pos v1
    JOIN vendor_pos v2 ON v1.po = v2.po AND v1.job = v2.job AND v1.id > v2.id
    WHERE v1.eto_synced = 1 AND v2.eto_synced = 1
      AND v1.po IS NOT NULL AND v1.job IS NOT NULL
      AND (v1.pm IS NULL OR v1.pm = '') AND (v1.comments IS NULL OR v1.comments = '')
      AND (v1.tracking IS NULL OR v1.tracking = '') AND (v1.ship_date IS NULL OR v1.ship_date = '')
  `).catch(() => {});

  // ─── Service Log Replacement (Monica R2) ──────────────────────────────────
  //
  // Replaces the Smartsheet-based Service workflow. The chain is:
  //   customer request → service_requests row → 1..n service_work_orders
  //   → assigned employee (+ a linked `tasks` row so the assignment shows in
  //   the normal Scheduler workload) → completion → service_reports row.
  //
  // service_requests IS the Service Log — there is no separate "log" table.
  // The customer-submitted fields and the internal management fields live on
  // the same row, which is what keeps "the website request automatically
  // creates a Service Log entry" a no-op rather than a sync job that can
  // drift.
  //
  // request_no (SR-YYYY-NNNN) is the common identifier across every table
  // here, deliberately NOT the job number: multiple Service requests can
  // exist for the same machine/job (R2 §3).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_requests (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      request_no            VARCHAR(32) NOT NULL,
      company_name          VARCHAR(255),
      requestor_name        VARCHAR(255),
      requestor_email       VARCHAR(255),
      requestor_phone       VARCHAR(64),
      machine_serial        VARCHAR(255),
      job_number            VARCHAR(255),
      urgency               VARCHAR(64),
      service_details       TEXT,
      location_type         VARCHAR(16),
      department_needed     VARCHAR(32),
      warranty              VARCHAR(16),
      ppe_requirements      TEXT,
      additional_comments   TEXT,
      onsite_address        TEXT,
      quote_sent            TINYINT(1) DEFAULT 0,
      quote_sent_at         VARCHAR(32),
      po_received           TINYINT(1) DEFAULT 0,
      po_received_at        VARCHAR(32),
      service_complete      TINYINT(1) DEFAULT 0,
      service_complete_date VARCHAR(32),
      resource_assigned     VARCHAR(255),
      current_status        VARCHAR(64) DEFAULT 'new',
      information_needed    TEXT,
      source                VARCHAR(32) DEFAULT 'website',
      created_by            VARCHAR(255),
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_service_requests_no (request_no)
    )
  `);
  for (const [col, idx] of [
    ['job_number',     'idx_svc_req_job'],
    ['company_name',   'idx_svc_req_company'],
    ['current_status', 'idx_svc_req_status'],
    ['service_complete', 'idx_svc_req_complete'],
  ]) {
    await pool.query(`ALTER TABLE service_requests ADD INDEX ${idx} (${col})`).catch(() => {});
  }
  // SDC-built machine vs somebody else's equipment. This is not cosmetic: an
  // SDC machine has a serial / job number that ties the request back to its
  // build schedule, and a third-party machine has neither — which is why the
  // serial field stops being mandatory when this says 'non_sdc' (see the
  // required-field check in routes/service.js). It also tells the coordinator
  // straight away that there is no build history to look up and no SDC
  // warranty to fall back on.
  //
  // Added after the table shipped, so existing rows are NULL rather than
  // 'sdc' — a null here means "submitted before we asked", which is honest;
  // backfilling them all to 'sdc' would invent an answer nobody gave.
  await pool.query(`ALTER TABLE service_requests ADD COLUMN machine_type VARCHAR(16)`).catch(() => {});

  // Work Orders (R2 §6). Every WO stays linked to its parent request; the
  // requestor columns are NOT duplicated here — the API joins them from the
  // parent so there is one source of truth ("should populate from the parent
  // Service Log rather than requiring duplicate entry").
  //
  // task_id links to a row in `tasks`, which is how a Service assignment
  // shows up in the assignee's normal Scheduler workload (R2 §7) WITHOUT a
  // second employee roster. Null when no task could be created (or the task
  // was later deleted by hand).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_work_orders (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      service_request_id  INT NOT NULL,
      wo_no               VARCHAR(40) NOT NULL,
      task_date           VARCHAR(32),
      employee_name       VARCHAR(255),
      employee_email      VARCHAR(255),
      location_type       VARCHAR(16),
      task_description    TEXT,
      ppe_requirements    TEXT,
      onsite_address      TEXT,
      sdc_contact_name    VARCHAR(255),
      sdc_contact_email   VARCHAR(255),
      sdc_contact_phone   VARCHAR(64),
      budgeted_hours      DECIMAL(8,2),
      status              VARCHAR(32) DEFAULT 'open',
      completed_at        DATETIME,
      completed_by        VARCHAR(255),
      task_id             INT,
      notified_at         DATETIME,
      reminder_sent_at    DATETIME,
      created_by          VARCHAR(255),
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_service_wo_no (wo_no),
      CONSTRAINT fk_svc_wo_request FOREIGN KEY (service_request_id)
        REFERENCES service_requests(id) ON DELETE CASCADE
    )
  `);
  for (const [col, idx] of [
    ['service_request_id', 'idx_svc_wo_request'],
    ['employee_email',     'idx_svc_wo_employee'],
    ['task_date',          'idx_svc_wo_date'],
    ['status',             'idx_svc_wo_status'],
  ]) {
    await pool.query(`ALTER TABLE service_work_orders ADD INDEX ${idx} (${col})`).catch(() => {});
  }

  // Multi-day Work Orders. The original model assumed one visit = one day, which
  // is true for break-fix but false for the work Service actually plans around:
  // a machine move or a large addition books an engineer for weeks. end_date is
  // the INCLUSIVE last day; NULL means a single-day WO (so every pre-existing
  // row keeps its exact meaning and no backfill is required). task_date remains
  // the start and the only date the day-before reminder fires against.
  await pool.query(`ALTER TABLE service_work_orders ADD COLUMN end_date VARCHAR(32)`).catch(() => {});

  // Service PO tracking. `po_received` was a bare checkbox, which cannot answer
  // "how much service work do we have on the books" — the question a $172k
  // service PO immediately raises. Amount is nullable: a warranty call has a PO
  // of nothing, and 0.00 would be a lie.
  await pool.query(`ALTER TABLE service_requests ADD COLUMN po_number VARCHAR(64)`).catch(() => {});
  await pool.query(`ALTER TABLE service_requests ADD COLUMN po_amount DECIMAL(12,2)`).catch(() => {});

  // Attachments (R2 §16). Files live on disk under SERVICE_UPLOAD_DIR; this
  // table is the metadata plus the association that keeps them reachable
  // from the Service Log detail — explicitly NOT "temporary browser state".
  // stored_name is the on-disk name (random, so a customer-supplied filename
  // can never traverse a path or collide); filename is what gets shown in
  // the UI and sent back as the download name.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_attachments (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      service_request_id INT NOT NULL,
      work_order_id      INT,
      filename           VARCHAR(255) NOT NULL,
      stored_name        VARCHAR(255) NOT NULL,
      mime_type          VARCHAR(128),
      size_bytes         INT,
      uploaded_by        VARCHAR(255),
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_att_request FOREIGN KEY (service_request_id)
        REFERENCES service_requests(id) ON DELETE CASCADE
    )
  `);
  await pool.query(`ALTER TABLE service_attachments ADD INDEX idx_svc_att_request (service_request_id)`).catch(() => {});

  // Service Report (R2 §11). Generated — prepopulated — the moment an
  // employee marks their Work Order complete, so nothing already known from
  // the request / log / WO has to be re-typed.
  //
  // folder_path is the SEAM for "generate into the appropriate Service
  // Request folder": the report is an in-app record today, because the
  // actual folder convention has not been confirmed yet (R2 §22 is where
  // that gets settled with Monica). Once the location IS known, a generator
  // can write the document out and stamp its path here with no schema or API
  // change — same posture as R2 §5's ETO limitation: keep it extensible,
  // don't make it a dependency.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_reports (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      service_request_id INT NOT NULL,
      work_order_id      INT NOT NULL,
      report_no          VARCHAR(40) NOT NULL,
      status             VARCHAR(32) DEFAULT 'draft',
      work_performed     TEXT,
      findings           TEXT,
      parts_used         TEXT,
      hours_actual       DECIMAL(8,2),
      follow_up_needed   TINYINT(1) DEFAULT 0,
      follow_up_notes    TEXT,
      customer_contact   VARCHAR(255),
      prefill_json       MEDIUMTEXT,
      folder_path        VARCHAR(512),
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      submitted_at       DATETIME,
      submitted_by       VARCHAR(255),
      UNIQUE KEY uq_svc_report_wo (work_order_id),
      CONSTRAINT fk_svc_report_request FOREIGN KEY (service_request_id)
        REFERENCES service_requests(id) ON DELETE CASCADE
    )
  `);

  // Audit history (R2 §19). Deliberately mirrors task_history's shape —
  // action + who + when + a human-readable detail — rather than inventing a
  // second audit idiom for the same job.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_history (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      service_request_id INT NOT NULL,
      work_order_id      INT,
      action             VARCHAR(64) NOT NULL,
      detail             TEXT,
      changed_by         VARCHAR(255),
      changed_at         DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`ALTER TABLE service_history ADD INDEX idx_svc_hist_request (service_request_id)`).catch(() => {});
  await pool.query(`ALTER TABLE service_history ADD INDEX idx_svc_hist_changed_at (changed_at)`).catch(() => {});
}

const DEFAULT_SETTINGS = {
  brand_palette: [
    { name: 'SDC Blue',   hex: '#1574c4' },
    { name: 'Light Blue', hex: '#aacee8' },
    { name: 'Navy',       hex: '#061d39' },
    { name: 'Light Gray', hex: '#d9d9d9' },
    { name: 'Yellow',     hex: '#ffde51' },
    { name: 'Green',      hex: '#74c415' },
    { name: 'Lime',       hex: '#befa4f' },
  ],
  theme: {
    primary: '#1574c4',
    dark:    '#061d39',
    accent:  '#ffde51',
  },
  phases: [
    { key: 'me',          label: 'ME — Mechanical', color: '#aacee8', text: '#061d39' },
    { key: 'ce',          label: 'CE — Controls',   color: '#befa4f', text: '#1d4220' },
    { key: 'engineering', label: 'Engineering',     color: '#d9d9d9', text: '#061d39' },
    { key: 'build',       label: 'Build',           color: '#ffde51', text: '#5a4500' },
    { key: 'wire',        label: 'Wire',            color: '#74c415', text: '#0a2e07' },
    { key: 'testing',     label: 'Testing',         color: '#1574c4', text: '#ffffff' },
  ],
  project_milestone_library: [
    { name: 'Mech Release 1',         suggested_section: 'design_build',    suggested_dept: 'engineering', suggested_sub: 'mech' },
    { name: 'Mech Release 2',         suggested_section: 'design_build',    suggested_dept: 'engineering', suggested_sub: 'mech' },
    { name: 'Design Review',          suggested_section: 'design_build',    suggested_dept: 'engineering', suggested_sub: 'general' },
    { name: 'Order Long Lead Items',  suggested_section: 'design_build',    suggested_dept: 'procurement', suggested_sub: null },
    { name: 'Order Commercial Parts', suggested_section: 'design_build',    suggested_dept: 'procurement', suggested_sub: null },
    { name: 'First Part Full Auto',   suggested_section: 'machine_testing', suggested_dept: 'engineering', suggested_sub: null },
  ],
  default_financial_milestones: [
    { name: 'Receipt of PO',                percent: 30, predecessors: 'PO' },
    { name: 'Major Commercials',            percent: 40, predecessors: '' },
    { name: 'Acceptance at SDC (FAT)',      percent: 20, predecessors: 'FAT' },
    { name: 'Acceptance at Customer (SAT)', percent: 10, predecessors: 'Ship' },
  ],
  // Font size (px) for the grid's data columns — everything EXCEPT the Task and
  // Assigned To columns (dates, predecessors, duration, %, alloc, etc.). Lets
  // those columns run narrow without clipping. Task/Assigned-To keep their size.
  grid_data_font_px: 11,
};

async function seedDefaults(pool) {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      'INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)',
      [k, JSON.stringify(v)]
    );
  }
}

module.exports = { init, pool, DEFAULT_SETTINGS, seedDefaults };
