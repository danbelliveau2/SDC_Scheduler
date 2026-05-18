require('dotenv').config();
const db = require('../db');
const smartsheet = require('../smartsheetService');

async function importJob1125() {
  const projectId = '1125';
  const sheetId = '3694818388561796';

  console.log(`Starting import for Job ${projectId} (Sheet ${sheetId})...`);

  try {
    const ssTasks = await smartsheet.getSheetTasks(sheetId);
    if (!ssTasks || ssTasks.length === 0) {
      console.error('No tasks found in the Smartsheet');
      return;
    }

    console.log(`Found ${ssTasks.length} tasks in Smartsheet.`);

    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks WHERE project = ? AND smartsheet_row_id IS NULL').get(projectId).m;

    const stmt = db.prepare(`
      INSERT INTO tasks (
        name, project, start_date, end_date, duration_days, predecessors,
        assignee, progress, allocation, notes,
        baseline_start_date, baseline_end_date,
        is_milestone, sort_order, smartsheet_row_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM tasks WHERE project = ? AND smartsheet_row_id IS NOT NULL').run(projectId);
      ssTasks.forEach((t, i) => {
        stmt.run(
          t.name, projectId, t.start_date, t.end_date, t.duration_days, t.predecessors,
          t.assignee, t.progress,
          t.allocation ?? 90,
          t.notes ?? null,
          t.baseline_start_date ?? null, t.baseline_end_date ?? null,
          t.is_milestone,
          maxOrder + i + 1, t.smartsheetRowId
        );
      });
      db.exec('COMMIT');
      console.log(`Imported ${ssTasks.length} tasks for project ${projectId}.`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    // Update mapping in settings
    const mappingRow = db.prepare("SELECT value FROM settings WHERE key = 'smartsheet_sheet_ids'").get();
    let mapping = {};
    try {
        mapping = JSON.parse(mappingRow?.value || '{}');
    } catch (e) {
        mapping = {};
    }
    mapping[projectId] = { id: sheetId, name: '1125- Panduit Upgraded Foil Applicator' };
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('smartsheet_sheet_ids', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(JSON.stringify(mapping));

  } catch (err) {
    console.error('Import failed:', err);
  }
}

importJob1125();
