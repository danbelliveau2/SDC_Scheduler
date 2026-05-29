/**
 * azureDb.js — Azure SQL connection pool + schema bootstrap.
 *
 * Uses the [scheduler] schema (separate from the dbo / assemblies / readiness
 * etc. schemas living in the same database). ensureSchema() is idempotent —
 * every CREATE / ALTER guards with IF NOT EXISTS so it's safe to run on every
 * server boot.
 *
 * Ported from feature/smartsheet-architecture (Abhi) with these adjustments:
 *   • returns silently when AZURE_SQL_* env vars are empty (Phase 6 disabled)
 *   • exposes the underlying `sql` so callers can build typed inputs
 */
'use strict';
const sql = require('mssql');
require('dotenv').config();

const config = {
  server:   process.env.AZURE_SQL_SERVER   || '',
  database: process.env.AZURE_SQL_DATABASE || '',
  user:     process.env.AZURE_SQL_USER     || '',
  password: process.env.AZURE_SQL_PASSWORD || '',
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 30000,
    requestTimeout: 60000,
  },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
};

const ENABLED = !!(config.server && config.database && config.user && config.password);

let _pool = null;

async function getPool() {
  if (!ENABLED) throw new Error('Azure SQL env vars not set (AZURE_SQL_SERVER/DATABASE/USER/PASSWORD)');
  if (!_pool) {
    _pool = await sql.connect(config);
  }
  return _pool;
}

async function request() {
  const pool = await getPool();
  return pool.request();
}

async function ensureSchema() {
  if (!ENABLED) return;
  const pool = await getPool();
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'scheduler')
      EXEC('CREATE SCHEMA [scheduler]');
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                   WHERE TABLE_SCHEMA = 'scheduler' AND TABLE_NAME = 'tasks')
    CREATE TABLE [scheduler].[tasks] (
      id                  INT PRIMARY KEY,
      name                NVARCHAR(500) NOT NULL,
      project             NVARCHAR(255),
      phase               NVARCHAR(100),
      phase_group         NVARCHAR(100),
      department          NVARCHAR(100),
      sub_department      NVARCHAR(100),
      assignee            NVARCHAR(255),
      start_date          NVARCHAR(20),
      end_date            NVARCHAR(20),
      duration_days       INT,
      predecessors        NVARCHAR(500),
      is_milestone        BIT DEFAULT 0,
      progress            INT DEFAULT 0,
      allocation          INT DEFAULT 100,
      priority            INT DEFAULT 1,
      notes               NVARCHAR(MAX),
      sort_order          INT DEFAULT 0,
      anchor_key          NVARCHAR(100),
      baseline_start_date NVARCHAR(20),
      baseline_end_date   NVARCHAR(20),
      created_at          NVARCHAR(50)
    );
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                   WHERE TABLE_SCHEMA = 'scheduler' AND TABLE_NAME = 'settings')
    CREATE TABLE [scheduler].[settings] (
      [key]      NVARCHAR(200) PRIMARY KEY,
      value      NVARCHAR(MAX) NOT NULL,
      updated_at NVARCHAR(50)
    );
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                   WHERE TABLE_SCHEMA = 'scheduler' AND TABLE_NAME = 'team_members')
    CREATE TABLE [scheduler].[team_members] (
      id         INT PRIMARY KEY,
      name       NVARCHAR(255) NOT NULL,
      discipline NVARCHAR(100) NOT NULL,
      active     BIT DEFAULT 1,
      sort_order INT DEFAULT 0,
      is_lead    BIT DEFAULT 0,
      specialty  NVARCHAR(255),
      created_at NVARCHAR(50)
    );
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                   WHERE TABLE_SCHEMA = 'scheduler' AND TABLE_NAME = 'project_financials')
    CREATE TABLE [scheduler].[project_financials] (
      id             INT PRIMARY KEY,
      project        NVARCHAR(255) NOT NULL,
      name           NVARCHAR(255) NOT NULL,
      [percent]      FLOAT,
      amount         FLOAT,
      due_date       NVARCHAR(20),
      paid           BIT DEFAULT 0,
      predecessors  NVARCHAR(500),
      sync_to_anchor NVARCHAR(100),
      sort_order     INT DEFAULT 0,
      created_at     NVARCHAR(50)
    );
  `);

  // Add newer task columns (idempotent ALTERs — only run when missing)
  for (const [col, def] of [
    ['duration_link_task_id', 'INT'],
    ['is_action',             'BIT DEFAULT 0'],
    ['completed_on',          'NVARCHAR(20)'],
    ['machine',               'NVARCHAR(100)'],
    ['version',               'INT DEFAULT 1'],
  ]) {
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                     WHERE TABLE_SCHEMA = 'scheduler' AND TABLE_NAME = 'tasks' AND COLUMN_NAME = '${col}')
        ALTER TABLE [scheduler].[tasks] ADD ${col} ${def};
    `);
  }

  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                   WHERE TABLE_SCHEMA = 'scheduler' AND TABLE_NAME = 'task_history')
    CREATE TABLE [scheduler].[task_history] (
      id             INT PRIMARY KEY,
      task_id        INT,
      project        NVARCHAR(255),
      action         NVARCHAR(20) NOT NULL,
      changed_by     NVARCHAR(255),
      changed_at     NVARCHAR(50),
      before_json    NVARCHAR(MAX),
      after_json     NVARCHAR(MAX),
      changed_fields NVARCHAR(500)
    );
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                   WHERE TABLE_SCHEMA = 'scheduler' AND TABLE_NAME = 'task_comments')
    CREATE TABLE [scheduler].[task_comments] (
      id          INT PRIMARY KEY,
      task_id     INT NOT NULL,
      project     NVARCHAR(255),
      author_id   INT,
      author_name NVARCHAR(255) NOT NULL,
      body        NVARCHAR(MAX) NOT NULL,
      mentions    NVARCHAR(MAX),
      created_at  NVARCHAR(50),
      updated_at  NVARCHAR(50)
    );
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                   WHERE TABLE_SCHEMA = 'scheduler' AND TABLE_NAME = 'projects')
    CREATE TABLE [scheduler].[projects] (
      id          INT PRIMARY KEY,
      name        NVARCHAR(255) NOT NULL UNIQUE,
      status      NVARCHAR(50)  DEFAULT 'active',
      is_template BIT           DEFAULT 0,
      job_number  NVARCHAR(100),
      workspace   NVARCHAR(100) DEFAULT 'default',
      created_at  NVARCHAR(50)
    );
  `);

  console.log('[AzureDB:scheduler] Schema ready.');
}

module.exports = { ENABLED, getPool, request, ensureSchema, sql };
