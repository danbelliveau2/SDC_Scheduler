/**
 * customerScope.js — what a customer portal session may read.
 *
 * One answer for every route that scopes by req.shareCustomer, so tasks,
 * projects, financials, settings and team can never disagree about whose
 * rows these are.
 *
 *   • A CUSTOMER owns the projects the staff app attributes to them. That is
 *     the same rule the app uses (public/app.js projectCustomerName): the
 *     explicit `project_customer` setting wins, otherwise the synced
 *     projects.customer. Matching ignores case and stray spaces, so an account
 *     named "ALTEN" and a project synced as "Alten" are the same customer.
 *
 *   • A PARTNER (ALTEN) has no jobs of its own — it is a group of contract
 *     engineers on SDC's jobs. Its scope is the rows ASSIGNED to the group's
 *     members (settings `alten_members` → team_members), nothing else on any
 *     project. Mirrors PORTAL_PARTNERS in public/app.js.
 */

// name (lower-case) → settings key holding the member ids.
const PARTNERS = { alten: 'alten_members' };

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

async function readSetting(pool, key) {
  const [[row]] = await pool.query('SELECT value FROM settings WHERE `key` = ?', [key]);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch (_) { return null; }
}

/**
 * @returns {Promise<{partner:boolean, projects:string[], memberIds:number[], assignees:string[]}>}
 */
async function customerScope(pool, customerName) {
  const want = norm(customerName);
  const partnerKey = PARTNERS[want];

  if (partnerKey) {
    const ids = (await readSetting(pool, partnerKey));
    const memberIds = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
    let assignees = [];
    if (memberIds.length) {
      const [rows] = await pool.query('SELECT name FROM team_members WHERE id IN (?)', [memberIds]);
      assignees = rows.map(r => r.name);
    }
    let projects = [];
    if (assignees.length) {
      const [rows] = await pool.query('SELECT DISTINCT project FROM tasks WHERE assignee IN (?)', [assignees]);
      projects = rows.map(r => r.project).filter(Boolean);
    }
    return { partner: true, projects, memberIds, assignees };
  }

  const explicit = (await readSetting(pool, 'project_customer')) || {};
  const [synced] = await pool.query('SELECT name, customer FROM projects');
  const effective = new Map();   // project name → customer, explicit setting first
  for (const r of synced) effective.set(r.name, r.customer);
  for (const [project, customer] of Object.entries(explicit)) {
    if (customer) effective.set(project, customer);
  }
  const projects = [];
  for (const [project, customer] of effective) {
    if (want && norm(customer) === want) projects.push(project);
  }
  return { partner: false, projects, memberIds: [], assignees: [] };
}

module.exports = { customerScope };
