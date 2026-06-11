// One-time seed: import OPEN parts from the "Parts in Shop" Smartsheet export
// into the shop_parts table. Idempotent — only runs when the table is empty.
const XLSX = require('xlsx');
const db = require('./db'); // creates the shop_parts table on require

const existing = db.prepare('SELECT COUNT(*) AS c FROM shop_parts').get().c;
if (existing > 0) {
  console.log(`shop_parts already has ${existing} rows — skipping seed.`);
  process.exit(0);
}

const XLSX_PATH = process.argv[2] || 'C:/Users/dbelliveau/Downloads/Parts in Shop.xlsx';
const wb = XLSX.readFile(XLSX_PATH);
const rows = XLSX.utils.sheet_to_json(wb.Sheets['Parts in Shop'], { defval: '' });

const norm = (v) => String(v).trim().toLowerCase();
const truthy = (v) => ['true', '1', 'yes', 'y', 'x', '✓', '/', 'complete', 'checked'].includes(norm(v));
const isComplete = (r) => ['true', '1', 'yes', 'y', 'x', '✓', 'complete', 'checked'].includes(norm(r['Part Complete']));
const open = rows.filter(r => !isComplete(r) && (String(r['Part NO.']).trim() || String(r['Description']).trim()));

const num = (v) => { const n = Number(v); return Number.isFinite(n) && String(v).trim() !== '' ? n : null; };
const str = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };

const insert = db.prepare(`
  INSERT INTO shop_parts
    (rank, job, qty, part_no, description, shop_release, new_mod, location, out_for_finishing, priority, comments, engineer, pm, added_to_bom, part_complete, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

db.exec('BEGIN');
try {
  open.forEach((r, i) => {
    insert.run(
      num(r['Rank']),
      str(r['Job #']),
      num(r['QTY']),
      str(r['Part NO.']),
      str(r['Description']),
      str(r['Shop Release']),
      str(r['New/MOD']),
      str(r['Location/Machinist']),
      str(r['Out for Finishing']),
      str(r['Priority']),
      str(r['COMMENTS']),
      str(r['Engineer']),
      str(r['PM']),
      truthy(r['Added to BOM ']) ? 1 : 0,
      0,
      i
    );
  });
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

console.log(`Seeded ${open.length} open shop parts.`);
