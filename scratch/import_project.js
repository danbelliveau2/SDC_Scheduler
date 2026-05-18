require('dotenv').config();
const db = require('../db');
const smartsheet = require('../smartsheetService');

async function importProject(projectId, sheetId, sheetName) {
  console.log(`Starting import for Job ${projectId} (Sheet ${sheetId})...`);

  try {
    const ssTasks = await smartsheet.getSheetTasks(sheetId);
    if (!ssTasks || ssTasks.length === 0) {
      console.error(`No tasks found in the Smartsheet for ${projectId}`);
      return;
    }

    console.log(`Found ${ssTasks.length} tasks in Smartsheet.`);

    const maxOrderRow = await db.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks WHERE project = ? AND smartsheet_row_id IS NULL', [projectId]);
    const maxOrder = maxOrderRow.m;

    const sql = `
      INSERT INTO tasks (
        name, project, start_date, end_date, duration_days, predecessors,
        assignee, progress, allocation, notes,
        baseline_start_date, baseline_end_date,
        is_milestone, sort_order, smartsheet_row_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await db.begin();
    try {
      await db.run('DELETE FROM tasks WHERE project = ? AND smartsheet_row_id IS NOT NULL', [projectId]);
      for (let i = 0; i < ssTasks.length; i++) {
        const t = ssTasks[i];
        await db.run(sql, [
          t.name, projectId, t.start_date, t.end_date, t.duration_days, t.predecessors,
          t.assignee, t.progress,
          t.allocation ?? 90,
          t.notes ?? null,
          t.baseline_start_date ?? null, t.baseline_end_date ?? null,
          t.is_milestone,
          maxOrder + i + 1, t.smartsheetRowId
        ]);
      }
      await db.commit();
      console.log(`Imported ${ssTasks.length} tasks for project ${projectId}.`);
    } catch (err) {
      await db.rollback();
      throw err;
    }

    // Update mapping in settings
    const mappingRow = await db.get("SELECT value FROM settings WHERE key = 'smartsheet_sheet_ids'");
    let mapping = {};
    try {
        mapping = JSON.parse(mappingRow?.value || '{}');
    } catch (e) {
        mapping = {};
    }
    mapping[projectId] = { id: sheetId, name: sheetName };
    
    const settingsSql = process.env.DB_TYPE === 'postgres'
        ? `INSERT INTO settings (key, value, updated_at) VALUES ('smartsheet_sheet_ids', $1, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`
        : `INSERT INTO settings (key, value, updated_at) VALUES ('smartsheet_sheet_ids', ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`;

    await db.run(settingsSql, [JSON.stringify(mapping)]);

  } catch (err) {
    console.error(`Import failed for ${projectId}:`, err);
  }
}

const projectId = process.argv[2];
const sheetId = process.argv[3];
const sheetName = process.argv[4];

if (!projectId || !sheetId) {
  console.error('Usage: node import_project.js <projectId> <sheetId> <sheetName>');
  process.exit(1);
}

importProject(projectId, sheetId, sheetName);
