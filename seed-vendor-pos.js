// One-time seed: import the full "Vendor PO Track" Smartsheet export into the
// vendor_pos table. Idempotent — only runs when the table is empty.
const XLSX = require('xlsx');
const db = require('./db'); // creates vendor_pos on require

const existing = db.prepare('SELECT COUNT(*) AS c FROM vendor_pos').get().c;
if (existing > 0) { console.log(`vendor_pos already has ${existing} rows — skipping.`); process.exit(0); }

const wb = XLSX.readFile(process.argv[2] || 'C:/Users/dbelliveau/Downloads/Vendor PO Track.xlsx');
const rows = XLSX.utils.sheet_to_json(wb.Sheets['Vendor PO Track'], { defval: '' });

function excelToISO(v) {
  if (typeof v === 'number' && isFinite(v) && v > 20000) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; const mo = m[1].padStart(2, '0'), da = m[2].padStart(2, '0'); if (+mo >= 1 && +mo <= 12 && +da >= 1 && +da <= 31) return `${y}-${mo}-${da}`; }
  return null;
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) && String(v).trim() !== '' ? n : null; };
const str = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };
const truthy = (v) => ['true', '1', 'yes', 'y', 'x', '✓', 'complete'].includes(String(v).trim().toLowerCase());

const insert = db.prepare(`
  INSERT INTO vendor_pos (priority, po, job, vendor, po_date, lead_time, eta, ship_date, delivery_date, tracking, po_price, pm, comments, partial, complete, completed_on, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

db.exec('BEGIN');
try {
  rows.forEach((r, i) => {
    if (!str(r['PO']) && !str(r['Vendor']) && !str(r['Job #'])) return;
    const complete = truthy(r['Complete']) ? 1 : 0;
    const deliv = excelToISO(r['Delivery Date']);
    insert.run(
      num(r['Priority']),
      str(r['PO']),
      str(r['Job #']),
      str(r['Vendor']),
      excelToISO(r['PO Date']),
      num(r['Lead Time']),
      excelToISO(r['ETA']),
      excelToISO(r['Ship Date']),
      deliv,
      str(r['Tracking Number']),
      str(r['PO Price']),
      str(r['PM']),
      str(r['COMMENTS']),
      0,
      complete,
      complete ? (deliv || null) : null,
      i
    );
  });
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

console.log(`Seeded ${db.prepare('SELECT COUNT(*) c FROM vendor_pos').get().c} vendor POs.`);
