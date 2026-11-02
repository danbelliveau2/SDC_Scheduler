'use strict';
/**
 * One-time load of each job's SALES PRICE (2026-11-02) from the Projects grid
 * onto projects.contract_value, which is what the Invoicing tab multiplies a
 * milestone percent by to show dollars (PortalCalc.milestoneAmounts).
 *
 *   node scripts/import-sales-prices.js              # dry run, prints the plan
 *   node scripts/import-sales-prices.js --apply      # writes it
 *   node scripts/import-sales-prices.js --apply --overwrite
 *
 * Matches on projects.job_number. Templates are skipped. A project that
 * already has a contract_value is left alone unless --overwrite is given, so a
 * price somebody typed by hand is never replaced silently. Change quotes are
 * deliberately not in these numbers: they are their own milestone rows.
 *
 * Read the dry run before --apply: the NAME column is the project this price
 * would land on, and it has to be the job the grid meant.
 */
require('dotenv').config();
const { getPool } = require('../lib/mysqlDb');

const PRICES = {
  1101: 2692160, 1104: 2089000, 1106: 2690400, 1118: 2026700, 1119: 405000,
  1122: 1385000, 1125: 407000, 1127: 299400, 1129: 415000, 1130: 2344000,
  1131: 554000, 1133: 182520, 1135: 524200, 1136: 141350, 1137: 208600,
  1138: 38250, 1139: 95800, 1140: 35120, 1141: 58100, 1142: 2132000,
  1143: 2344000, 1144: 197000, 1145: 405200, 1146: 412400, 1147: 1094000,
  1148: 3130000, 1149: 52600, 1150: 565900, 1151: 1105900, 1152: 466000,
  1153: 96000, 1156: 89500, 1157: 2745000, 1158: 713300, 1159: 25000,
  1160: 715000, 1161: 140000, 1162: 620000, 1163: 7067000, 1164: 3976800,
  1165: 100000, 1166: 192600, 1167: 210000, 1168: 725000, 1169: 495000,
  1170: 70000, 1171: 137900, 1172: 2747000, 1173: 47200, 1174: 119000,
  1176: 112100,
};

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US');

(async () => {
  const apply = process.argv.includes('--apply');
  const overwrite = process.argv.includes('--overwrite');
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, name, job_number, contract_value FROM projects
     WHERE (is_template IS NULL OR is_template = 0) AND job_number IS NOT NULL AND job_number != ''`);

  const byJob = new Map();
  rows.forEach(r => { const k = parseInt(r.job_number, 10); if (Number.isInteger(k)) (byJob.get(k) || byJob.set(k, []).get(k)).push(r); });

  let write = 0, keep = 0;
  for (const [job, price] of Object.entries(PRICES)) {
    const hits = byJob.get(Number(job)) || [];
    if (!hits.length) { console.log(`${job}  NO PROJECT with this job number`); continue; }
    for (const p of hits) {
      const has = p.contract_value != null;
      const doIt = !has || overwrite;
      console.log(`${job}  ${doIt ? 'SET ' : 'KEEP'} ${money(price).padStart(11)}  (now ${money(p.contract_value)})  ${p.name}`);
      if (!doIt) { keep++; continue; }
      write++;
      if (apply) await pool.query('UPDATE projects SET contract_value = ? WHERE id = ?', [price, p.id]);
    }
  }
  console.log(`\n${apply ? 'Wrote' : 'Would write'} ${write}, kept ${keep}.${apply ? '' : '  Re-run with --apply to write.'}`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
