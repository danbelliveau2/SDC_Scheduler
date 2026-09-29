// portalCustomerShim.js — makes the CUSTOMER page look, to portalRender.js's
// functions, exactly like the staff app's global scope. portalRender.js is a
// byte-for-byte relocation of public/app.js's Portal-tab content functions,
// and those functions reference a handful of app.js globals by name (state,
// escapeHtml, fmtDate, inferredAnchorKey, taskScheduleDelta, riskPlan, ...).
// On the staff page those already exist. Here, this file defines customer
// equivalents — most delegating to the already-verified public/portalCalc.js
// — so the SAME rendering functions run unmodified on both pages.
//
// Load order matters only in that this file (and portalCalc.js, and
// portalRender.js) must all finish loading before portal-app.js calls any
// render function — same classic-script, shared-global-scope model as
// phases.js/release-notes.js loading before app.js on the staff page.

let state = {
  tasks: [],
  financials: {},
  team: [],
  settings: { risk_plans: {}, project_leads: {} },
};

// Keyed by project name -> boolean. Populated by _setPortalCustomerData()
// from the dashboard payload's per-project isSales flag, so taskScheduleDelta
// (which public/app.js's real version derives via isSalesProjectTask(task))
// can look it up without needing the whole projects list passed around.
let _portalCustomerSalesMap = {};

// Call once per dashboard load/refresh, before any portalRender.js function
// runs, to point `state` at this customer's own (already server-scoped) data.
function _setPortalCustomerData(data) {
  state.tasks = data.rawTasks || [];
  state.financials = data.financials || {};
  state.team = data.teamMembers || [];
  state.settings = {
    risk_plans: data.riskPlans || {},
    project_leads: data.projectLeads || {},
  };
  _portalCustomerSalesMap = {};
  (data.projects || []).forEach(p => { _portalCustomerSalesMap[p.name] = !!p.isSales; });
}

// Exact copy of public/app.js's own escapeHtml() (app.js:1292).
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Exact copy of public/app.js's own fmtDate() (app.js:1286) — deliberately
// NOT PortalCalc.fmtDate (a Date-object-based equivalent used by the JSON
// API): this one matches the staff app's algorithm byte-for-byte, since
// portalDate() in the shared render file calls this exact name.
function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y.slice(2)}`;
}

// Exact copy of public/app.js's own _ymdLocal() (app.js:18886) — LOCAL
// timezone, not portalCalc.js's UTC-based ymdLocal(), since portalRender.js's
// functions were written against this exact one.
function _ymdLocal(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function inferredAnchorKey(t) { return PortalCalc.inferredAnchorKey(t); }
function isMilestoneLike(t) { return PortalCalc.isMilestoneLike(t); }
function getEffectiveProgress(t) { return PortalCalc.getEffectiveProgress(t); }

// Exact copy of public/app.js's own isPlaceholder() (app.js:1071).
function isPlaceholder(name) { return /\bplaceholder\b/i.test(String(name || '')); }

// public/app.js's taskScheduleDelta(task) takes just the task and derives
// isSalesProjectTask(task) itself from global project data; here we look the
// same flag up from the map _setPortalCustomerData() built.
function taskScheduleDelta(task) {
  const isSales = !!_portalCustomerSalesMap[task && task.project];
  return PortalCalc.taskScheduleDelta(task, isSales);
}

function _finBaseMachine(machines) { return PortalCalc.finBaseMachine(machines); }
function _finProjectMachines(project) {
  return PortalCalc.finProjectMachines(state.tasks.filter(t => t.project === project));
}
function financialAnchorTask(f, project) {
  const rows = state.tasks.filter(t => t.project === project);
  const finBase = PortalCalc.finBaseMachine(PortalCalc.finProjectMachines(rows));
  return PortalCalc.financialAnchorTaskForMoney(f, rows, finBase);
}
function financialDueDate(f, project) {
  const rows = state.tasks.filter(t => t.project === project);
  const tasksById = new Map(rows.map(t => [t.id, t]));
  return PortalCalc.financialDueDate(f, tasksById, rows);
}

function riskBand(score) { return PortalCalc.riskBand(score); }

// Exact copy of public/app.js's own riskPlan() (app.js:16056).
function riskPlan(project) {
  const map = (state.settings && state.settings.risk_plans) || {};
  const rec = map[project];
  return (rec && Array.isArray(rec.risks)) ? rec.risks : [];
}

const RISK_GROUP = 'RISK';
const riskSubDept = (riskId) => 'risk:' + riskId;

// Exact copy of public/app.js's own riskTaskList() (app.js:16835).
function riskTaskList(project, riskId) {
  const sub = riskSubDept(riskId);
  return state.tasks
    .filter(t => t.project === project && t.phase_group === RISK_GROUP && t.sub_department === sub)
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
}

// Exact copy of public/app.js's own projectLead() (app.js:27251).
function projectLead(project, role) {
  const map = (state.settings && state.settings.project_leads) || {};
  const rec = map[project];
  return (rec && rec[role]) || '';
}

// Exact copies of public/app.js's own RISK_LIKELIHOOD/RISK_SEVERITY
// (app.js:16006/16017) — app.js declares these itself (its risk-register
// editor also uses them), so portalRender.js can't declare them a second
// time without a redeclaration error; each page that loads portalRender.js
// provides its own copy instead.
const RISK_LIKELIHOOD = [
  { v: 1, label: 'Rare',           hint: 'It will work. We are confident it costs us no schedule time.' },
  { v: 2, label: 'Unlikely',       hint: 'Probably works first time; any shortfall is absorbed without moving a date.' },
  { v: 3, label: 'Possible',       hint: 'Even odds it falls short of what we need and costs us time.' },
  { v: 4, label: 'Likely',         hint: 'Expect it to fall short and cost us time unless we act now.' },
  { v: 5, label: 'Almost certain', hint: 'It is already not working well enough, and already costing us time.' },
];
const RISK_SEVERITY = [
  { v: 1, label: 'Days',   hint: 'Days - absorbed inside the float we have.' },
  { v: 2, label: 'Weeks',  hint: 'Weeks - an internal date slips.' },
  { v: 3, label: 'Months', hint: 'Months - FAT moves, or we are into redesign.' },
];
