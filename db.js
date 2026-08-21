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
