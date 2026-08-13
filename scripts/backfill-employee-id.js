'use strict';
/**
 * One-time link between team_members and ETC Planner's Employee table
 * (2026-08-13) — the stable ID that replaces name-matching going forward.
 *
 *   node scripts/backfill-employee-id.js            # dry run, prints the plan
 *   node scripts/backfill-employee-id.js --apply     # writes it
 *
 * Uses the existing `root` connection (lib/mysqlDb.js), not the new scoped
 * `sdc_scheduler_shared` credential — this is a one-time migration step, not
 * the ongoing runtime path (that's routes/team.js, which does use the scoped
 * credential). `root` already has full access to sdc_etc_planner regardless,
 * so this can run before the scoped user exists.
 *
 * Two special cases, NOT plain name matches (see the plan's "outsourced
 * overlap" decision): Kedar Tarlekar and Vipin Vijayan are the real-name
 * versions of ETC's generic "CE Outsourced" / "ME Outsourced" rows — same
 * outsourced labor, tracked two different ways. Linking them to those
 * EXISTING Employee rows (instead of creating new ones, which the ETC-side
 * backfill deliberately did NOT do for these two) avoids double-counting the
 * same hours under two identities.
 *
 * "New member" is left unlinked on purpose — it reads as a stale placeholder
 * row from the board UI, not a person. Flagged below for manual cleanup.
 */
const mysql = require('mysql2/promise');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');

const NICKNAMES = { mike:'michael', josh:'joshua', rich:'richard', tim:'timothy', matt:'matthew', rob:'robert', dave:'david', mitch:'mitchell', nick:'nicholas', greg:'gregory', dan:'daniel', tom:'thomas', jon:'jonathan', chris:'christopher', andy:'andrew', bill:'william', billy:'william', sam:'samuel', joe:'joseph', jim:'james', ben:'benjamin' };
function normName(name) {
  const parts = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/);
  if (parts.length) parts[0] = NICKNAMES[parts[0]] || parts[0];
  return parts.join('');
}

// name (as it appears on the Scheduler board) -> exact ETC Employee.name to
// link to, instead of the normal fuzzy match.
const SPECIAL_LINKS = {
  'Kedar Tarlekar': 'CE Outsourced',
};

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'sdc_scheduler',
  });

  const [members] = await conn.query(
    "SELECT id, name, discipline, employee_id FROM team_members WHERE name NOT LIKE '%Placeholder%'"
  );
  const [employees] = await conn.query('SELECT id, name FROM sdc_etc_planner.Employee');

  const empByKey = new Map();
  for (const e of employees) {
    const k = normName(e.name);
    if (!empByKey.has(k)) empByKey.set(k, e);
  }
  // "ME Outsourced" appears twice in ETC; Vipin Vijayan links to the first by
  // id (the second stays an unlinked generic outsourced-labor row).
  const meOutsourced = employees.filter((e) => e.name === 'ME Outsourced').sort((a, b) => a.id - b.id);
  if (meOutsourced.length) SPECIAL_LINKS['Vipin Vijayan'] = { id: meOutsourced[0].id, name: meOutsourced[0].name };

  const links = [];
  const alreadyLinked = [];
  const skippedNewMember = [];
  const noMatch = [];

  for (const m of members) {
    if (m.employee_id != null) { alreadyLinked.push(m.name); continue; }
    if (/^new member$/i.test(m.name)) { skippedNewMember.push(m.name); continue; }

    const special = SPECIAL_LINKS[m.name];
    if (special) {
      const target = typeof special === 'string' ? employees.find((e) => e.name === special) : special;
      if (target) { links.push({ memberId: m.id, memberName: m.name, employeeId: target.id, employeeName: target.name, special: true }); continue; }
    }

    const emp = empByKey.get(normName(m.name));
    if (emp) links.push({ memberId: m.id, memberName: m.name, employeeId: emp.id, employeeName: emp.name, special: false });
    else noMatch.push(m.name);
  }

  console.log(`\n${links.length} links to write:`);
  for (const l of links) console.log(`  ${l.memberName} -> Employee#${l.employeeId} (${l.employeeName})${l.special ? '  [special case]' : ''}`);
  console.log(`\n${alreadyLinked.length} already linked: ${alreadyLinked.join(', ') || '(none)'}`);
  console.log(`${skippedNewMember.length} skipped ("New member" placeholder — recommend deleting from the board): ${skippedNewMember.join(', ') || '(none)'}`);
  console.log(`${noMatch.length} no ETC match found: ${noMatch.join(', ') || '(none)'}`);

  if (!APPLY) {
    console.log('\nDry run only — pass --apply to write these links.');
    await conn.end();
    return;
  }

  for (const l of links) {
    await conn.query('UPDATE team_members SET employee_id = ? WHERE id = ?', [l.employeeId, l.memberId]);
  }
  console.log(`\nWrote ${links.length} links.`);
  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
