const api = {
  list: () => fetch('/api/tasks').then(r => r.json()),
  create: (data) => fetch('/api/tasks', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) }).then(r => r.json()),
  update: (id, data) => fetch(`/api/tasks/${id}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) }).then(r => r.json()),
  remove: (id) => fetch(`/api/tasks/${id}`, { method: 'DELETE' }).then(r => r.json()),
  getSettings: () => fetch('/api/settings').then(r => r.json()),
  putSetting: (key, value) => fetch(`/api/settings/${key}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value) }).then(r => r.json()),
  team: {
    list:   () => fetch('/api/team').then(r => r.json()),
    create: (data) => fetch('/api/team', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) }).then(r => r.json()),
    update: (id, data) => fetch(`/api/team/${id}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) }).then(r => r.json()),
    remove: (id) => fetch(`/api/team/${id}`, { method: 'DELETE' }).then(r => r.json()),
  },
  // Baseline snapshot — captures the current start/end dates on every task in a
  // project so subsequent edits can be compared against the original plan.
  baseline: {
    set:   (project) => fetch('/api/baseline/set',   { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ project }) }).then(r => r.json()),
    clear: (project) => fetch('/api/baseline/clear', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ project }) }).then(r => r.json()),
  },
  // Per-project financial milestones. Independent from tasks: they're not in the grid,
  // don't have predecessors, and render as a Gantt overlay when the $ Financial toggle
  // is on. Auto-seeded from the default_financial_milestones setting via api.financials.seed.
  // Every method tolerates a missing server-side endpoint (404) — if the server hasn't
  // been restarted with the new routes, list() returns [] and seed() returns ok:false
  // so callers can show a "restart the server" hint instead of crashing.
  financials: {
    list: async (project) => {
      try {
        const r = await fetch(`/api/financials${project ? `?project=${encodeURIComponent(project)}` : ''}`);
        if (!r.ok) { state._financialsApiBroken = true; return []; }
        return await r.json();
      } catch (err) { state._financialsApiBroken = true; return []; }
    },
    create: async (data) => {
      const r = await fetch('/api/financials', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
      if (!r.ok) { state._financialsApiBroken = true; throw new Error('financials.create failed'); }
      return await r.json();
    },
    update: async (id, data) => {
      const r = await fetch(`/api/financials/${id}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
      if (!r.ok) { state._financialsApiBroken = true; throw new Error('financials.update failed'); }
      return await r.json();
    },
    remove: async (id) => {
      const r = await fetch(`/api/financials/${id}`, { method: 'DELETE' });
      if (!r.ok) { state._financialsApiBroken = true; throw new Error('financials.remove failed'); }
      return await r.json();
    },
    seed: async (project) => {
      try {
        const r = await fetch('/api/financials/seed', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ project }) });
        if (!r.ok) { state._financialsApiBroken = true; return { ok: false }; }
        return await r.json();
      } catch (err) { state._financialsApiBroken = true; return { ok: false }; }
    },
  },
};

// Disciplines = roles that get assigned to project tasks. Keep in sync with the server-side
// TEAM_DISCIPLINES set. The bar color used in the Resources timeline is per-PROJECT, not per-
// discipline, so the discipline color/text below is only used for chips and headers.
// v4.63: password gate for the Departments tab. Not real security — just
// keeps regular engineers from accidentally opening the manager view. The
// password caches in sessionStorage so it's prompted once per browser
// session, not on every click. Change here when you need to rotate it.
// v4.64: password updated to 'sdcautomation' (all lowercase).
const TEAM_PASSWORD = 'sdcautomation';

const DISCIPLINES = [
  { key: 'pm',       label: 'Project Management',   short: 'PM',       color: '#e9d5ff', text: '#581c87' },
  { key: 'mech',     label: 'Mechanical Engineers', short: 'Mech',     color: '#bfdbfe', text: '#1e3a8a' },
  { key: 'controls', label: 'Controls Engineers',   short: 'Controls', color: '#bbf7d0', text: '#14532d' },
  { key: 'build',    label: 'Builders',             short: 'Build',    color: '#fed7aa', text: '#7c2d12' },
  { key: 'wire',     label: 'Electricians',         short: 'Wire',     color: '#fef08a', text: '#713f12' },
];
const DISCIPLINE_BY_KEY = Object.fromEntries(DISCIPLINES.map(d => [d.key, d]));

const state = {
  tasks: [],
  team: [],
  view: 'schedule',
  filters: {
    search: '', project: '', phase: '', assignee: '',
    // Quick chip filters in the popover — each is a boolean toggle. Anchors are
    // exempt (always shown) so the schedule spine stays visible when filtering.
    quick: { behind: false, ahead: false, milestones: false, assigned: false, overallocated: false, showCompleted: false },
  },
  gantt: null,
  viewMode: 'Week',
  zoomPercent: 100,
  // First Gantt render of the session always fits the viewport. Project switches
  // refresh this too (see renderGantt). Manual zoom (wheel / +/- buttons) sticks until
  // one of those triggers fires again.
  _fitOnNextRender: true,
  _lastFitProject: null,
  // Schedule-tab view modes. Each is an independent toggle, persisted to localStorage.
  // - flatten: hide all sub-section headers; tasks render directly under section 10/40/50.
  // - sortByStart: order tasks by start_date within each section instead of sort_order.
  // - ganttOnly: hide the grid panel and show only the Gantt full-width.
  // - criticalPath: highlight the longest predecessor-driven chain from Receipt of PO
  //   to FAT — bars + arrows on that path turn red so the project-driving sequence
  //   reads at a glance.
  // - criticalOnly: filter the grid + Gantt to ONLY the critical-path tasks (and their
  //   anchor markers). Requires criticalPath to also be on.
  scheduleView: { flatten: false, sortByStart: false, ganttOnly: false, criticalPath: false, criticalOnly: false, showArrowLags: true, showBarMeta: false, showInlineAlloc: true, actionsMode: 'schedule' },
  settings: null,
  setupDraft: null, // editable copy while user is in Setup view
  layout: null,     // { gridWidth, showGantt, colWidths, rowHeight } - hydrated in init
  resources: { discipline: 'mech', project: '', zoomPercent: 100, focusMemberId: null },
  overAllocatedTaskIds: new Set(),
  // Open project schedules — like browser tabs. The empty string acts as the "All
  // projects" pseudo-tab so the user can always step back to the global view. Persisted
  // to localStorage so reloads remember which schedules you had open and which one was
  // active. The Team and Setup views ignore this — they show data across all projects.
  openProjects: [''],
  // Project names flagged as templates: protected from accidental close, marked with
  // a star in the tab. Stored in localStorage as a string array.
  templateProjects: [],
  // Workspaces — projects can be grouped into one of a fixed set of workspaces
  // so the "+ Open project" picker doesn't pile every sales schedule alongside
  // active customer projects. Default workspaces: Active, Sales, Closed.
  // projectWorkspaces is a map of project name → workspace name. Any project
  // not in the map defaults to "Active". Persisted in localStorage so it
  // survives reloads (per-browser; if you need shared workspaces across
  // engineers, that\'s a future server-side move).
  projectWorkspaces: {},
  // activeWorkspace controls which workspace's project tabs are visible at the
  // top. Switching workspaces only filters the tab list; the currently-active
  // project tab stays visible (special "currently viewing" exemption) so you
  // never get stranded with no tab to click. Persisted in localStorage.
  activeWorkspace: 'Active',
  // Favorites — per-browser list of starred project names. User clicks the ★
  // next to a project in Projects / sidebar to toggle.
  favoriteProjects: [],
  // Recents — last N opened project names, newest first. Capped at 10.
  recentProjects: [],
  // Project financial milestones, keyed by project name. Loaded on demand when the
  // Financials modal opens or the $ Financial overlay is enabled. Each value is the
  // full array from /api/financials?project=… in display order (sort_order, then id).
  financials: {},
  // Toggle for the $ Financial Gantt overlay. Persisted to localStorage via
  // saveScheduleView so it sticks across reloads.
  showFinancials: false,
  // Toggle for the Baseline ghost overlay — dashed outline at each task's
  // baseline date range + a drift chip showing days moved vs. baseline.
  showBaseline: false,
  // Undo / Redo history. Capped at UNDO_STACK_MAX entries (see pushUndoSnapshot).
  // Each entry: { taskId, before: { field: value, ... }, description }.
  // - Undo pops from undoStack, captures the CURRENT field values as a redo
  //   entry, then re-applies the `before` snapshot via api.update.
  // - Redo pops from redoStack, captures the CURRENT field values as an undo
  //   entry, then re-applies the redo entry's `before` (which holds the
  //   "after" state of the original edit).
  // - A NEW edit (via pushUndoSnapshot) clears redoStack so history stays
  //   linear and doesn't desync.
  // Cleared at page reload (no localStorage persistence).
  undoStack: [],
  redoStack: [],
};

// v4.54: ROW_H_MIN = 16 (was 12 in v4.52-v4.53; was 18 before that). User
// feedback: even friendly 10 = 12px was too small to be readable. New
// friendly scale goes 0–100 (not 10–100), mapping 0=16px → 100=30px in
// increments of 10 = 1.4px each. The previous "you'd never go smaller
// than 30 (= 16px in v4.53 friendly)" gets renamed to 0 in the new scale.
const ROW_H_MIN = 16;
const ROW_H_MAX = 120;
const ROW_H_FRIENDLY_MIN_PX = 16;
const ROW_H_FRIENDLY_MAX_PX = 30;
const ROW_H_DEFAULT = 26;
const BAR_H_MIN = 10;
// Row-height +/- step. Fixed 2px/click is fine-grained enough for the typical 14–60
// range; small enough to make tight 1-row-difference adjustments without
// overshooting, big enough that holding the button doesn't feel sluggish.
const ROW_H_STEP = 2;

const PHASES = window.PHASES;
const PHASE_BY_KEY = window.PHASE_BY_KEY;
const HIERARCHY = window.HIERARCHY;
const GROUP_BY_KEY = window.GROUP_BY_KEY;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Set of "phase_group/department/sub_department" paths the user has collapsed in the grid.
const collapsedGroups = new Set();
function groupPath(g, d, s) { return [g || '', d || '', s || ''].join('/'); }

// Maps maintained by updateLineNumbersAndPreds. Predecessors are stored by task id but shown
// as line numbers (1, 2, 3 …) so the user has a stable visual reference that keeps re-numbering
// as rows move.
let lineByTaskId = {};
let taskIdByLine = {};

function predDisplay(predString) {
  if (!predString) return '';
  return String(predString).split(',').map(s => {
    const m = s.trim().match(/^(\d+)(.*)$/);
    if (!m) return s.trim().toUpperCase();
    const id = Number(m[1]);
    const line = lineByTaskId[id];
    return ((line != null ? line : `?${id}`) + m[2]).toUpperCase();
  }).join(', ');
}
function predParse(displayString) {
  if (!displayString) return '';
  return String(displayString).split(',').map(s => {
    const m = s.trim().match(/^(\d+)(.*)$/);
    if (!m) return s.trim().toUpperCase();
    const line = Number(m[1]);
    const id = taskIdByLine[line];
    return ((id != null ? id : line) + m[2]).toUpperCase();
  }).join(', ');
}

// Walk HIERARCHY + anchors as if nothing is collapsed. Returns the canonical task ID
// order — used to assign line numbers that stay STABLE across collapse / expand
// operations, so predecessor displays never flip to "?id" just because a section is
// folded up.
function buildCanonicalTaskOrder() {
  const filtered = applyFilters(state.tasks);
  const buckets = {};
  // Mech 1 Release + Machine Power-Up flow through their hierarchy bucket; all
  // other anchors render at fixed spine positions outside the walk.
  const INLINE_ANCHORS = new Set(['mech_release_1', 'machine_power_up']);
  for (const t of filtered) {
    const k = inferredAnchorKey(t);
    if (k && !INLINE_ANCHORS.has(k)) continue;
    const path = groupPath(t.phase_group, t.department, t.sub_department);
    (buckets[path] ||= []).push(t);
  }
  const sortBucket = (arr) => {
    if (state.scheduleView?.sortByStart) {
      arr.sort((a, b) =>
        (a.start_date || '￿').localeCompare(b.start_date || '￿')
        || (a.sort_order || 0) - (b.sort_order || 0));
    } else {
      arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    }
  };
  for (const k in buckets) sortBucket(buckets[k]);

  const candidates = filtered.map(t => [t, inferredAnchorKey(t)]).filter(([, k]) => !!k);
  const pickOldest = (key) => {
    const list = candidates.filter(([, k]) => k === key).map(([t]) => t);
    return list.length ? list.reduce((a, b) => (a.id < b.id ? a : b)) : null;
  };
  const receiptAnchor = pickOldest('receipt_of_po');
  const fatAnchor     = pickOldest('fat');
  const shipAnchor    = pickOldest('ship_machine');

  const order = [];
  if (receiptAnchor) order.push(receiptAnchor.id);
  // Backlog sits BETWEEN Receipt of PO and section 10 in the rendered grid
  // (anchorRowHtml renders it right after PO). Include it in the canonical
  // line order so it gets a stable line number — without this, predecessors
  // that point at backlog (Mechanical Design starts with backlogFS) display
  // as "?id" because lineByTaskId[backlogId] is undefined.
  const backlogTask = filtered.find(t => isBacklogTask(t));
  if (backlogTask) order.push(backlogTask.id);
  for (const group of HIERARCHY) {
    if (state.scheduleView?.flatten) {
      // Same INLINE_ANCHORS rule as the table walk.
      const sectionTasks = filtered.filter(t => {
        if (t.phase_group !== group.key) return false;
        const k = inferredAnchorKey(t);
        return !k || INLINE_ANCHORS.has(k);
      });
      sortBucket(sectionTasks);
      let shipDropped = false;
      for (const t of sectionTasks) {
        if (group.key === 'teardown_install' && shipAnchor && !shipDropped && t.department === 'install') {
          order.push(shipAnchor.id);
          shipDropped = true;
        }
        order.push(t.id);
      }
      if (group.key === 'teardown_install' && shipAnchor && !shipDropped) order.push(shipAnchor.id);
    } else {
      const groupLevelTasks = buckets[groupPath(group.key)] || [];
      for (const t of groupLevelTasks) order.push(t.id);
      for (const dept of group.departments) {
        if (group.key === 'teardown_install' && dept.key === 'install' && shipAnchor) {
          order.push(shipAnchor.id);
        }
        const dPath = groupPath(group.key, dept.key);
        if (dept.subs.length > 0) {
          const deptLevelTasks = buckets[dPath] || [];
          for (const t of deptLevelTasks) order.push(t.id);
          for (const sub of dept.subs) {
            const sPath = groupPath(group.key, dept.key, sub.key);
            for (const t of (buckets[sPath] || [])) order.push(t.id);
          }
        } else {
          for (const t of (buckets[dPath] || [])) order.push(t.id);
        }
      }
    }
    if (group.key === 'machine_testing' && fatAnchor) order.push(fatAnchor.id);
  }
  return order;
}

function updateLineNumbersAndPreds() {
  const tbody = document.getElementById('tasks-tbody');
  if (!tbody) return;
  // Stable canonical line numbers — built from the FULL hierarchy walk so collapsing
  // a section never reshuffles them. Predecessor displays therefore stay locked even
  // when the predecessor's row is currently hidden.
  const canonicalOrder = buildCanonicalTaskOrder();
  lineByTaskId = {};
  taskIdByLine = {};
  canonicalOrder.forEach((id, i) => {
    const line = i + 1;
    lineByTaskId[id] = line;
    taskIdByLine[line] = id;
  });
  // Stamp each currently-visible row's line cell with its canonical line number.
  const taskRows = Array.from(tbody.querySelectorAll('tr[data-id]'));
  taskRows.forEach(tr => {
    const id = Number(tr.dataset.id);
    const line = lineByTaskId[id];
    const numEl = tr.querySelector('td[data-col="line"] .line-num');
    if (numEl && line != null) numEl.textContent = String(line);
  });
  // Translate the predecessors cell using the canonical map.
  taskRows.forEach(tr => {
    const id = Number(tr.dataset.id);
    const task = state.tasks.find(t => t.id === id);
    const cell = tr.querySelector('td[data-col="pred"]');
    if (cell && !cell.classList.contains('editing')) {
      cell.textContent = predDisplay(task?.predecessors || '');
    }
  });
  // v4.39: fill in duration-link badges with a 🔗 emoji + source line.
  // The link icon makes the relationship visible at a glance; the row
  // number lets you trace which task it's tied to without hovering.
  tbody.querySelectorAll('.name-cell-dur-link[data-link-target-id]').forEach(el => {
    const srcId = Number(el.getAttribute('data-link-target-id'));
    const line = lineByTaskId[srcId];
    el.textContent = line != null ? `🔗${line}` : '🔗?';
  });
}

// Frappe-gantt v0.6.1 hard-codes column_width inside update_view_scale based on view mode,
// which clobbers any custom column_width we pass in. Patch the prototype so a per-instance
// _cwOverride survives the reset — that's how we get continuous zoom.
if (window.Gantt && !Gantt.prototype._sdcPatched) {
  const _orig = Gantt.prototype.update_view_scale;
  Gantt.prototype.update_view_scale = function (mode) {
    _orig.call(this, mode);
    if (this.options && this.options._cwOverride) {
      this.options.column_width = this.options._cwOverride;
    }
  };
  Gantt.prototype._sdcPatched = true;
}

// One continuous zoom. Mode (Day / Week / Month) is auto-derived so the user can scroll
// from "show me everything" all the way to "show me one day" without picking a mode.
const VIEW_MODE_BASE_CW = { Day: 38, Week: 140, Month: 120 };
const VIEW_MODE_STEP_DAYS = { Day: 1, Week: 7, Month: 30 };
const ZOOM_MIN = 5;
const ZOOM_MAX = 500;
const ZOOM_STEP = 10;

// 100% = 20 px/day (matches frappe-gantt's Week default of 140 / 7).
function getZoomConfig(zoomPercent) {
  const pxPerDay = (zoomPercent / 100) * 20;
  if (pxPerDay < 3) {
    return { mode: 'Month', cw: Math.max(20, Math.min(400, Math.round(pxPerDay * 30))) };
  } else if (pxPerDay < 28) {
    return { mode: 'Week', cw: Math.max(15, Math.min(400, Math.round(pxPerDay * 7))) };
  } else {
    return { mode: 'Day', cw: Math.max(10, Math.min(200, Math.round(pxPerDay))) };
  }
}

// ---------- Utilities ----------
// Inclusive count between two ISO dates, in CALENDAR days. Used only where the
// calendar span itself matters (e.g. Gantt bar pixel width derives from this on the
// frappe side, but our routing math uses dates directly). Most logic uses business
// days via businessDaysBetween / addBusinessDays below.
function daysBetween(start, end) {
  if (!start || !end) return null;
  const s = new Date(start), e = new Date(end);
  const ms = e - s;
  if (isNaN(ms)) return null;
  return Math.round(ms / 86400000) + 1;
}

// Team members named "* Placeholder" (case-insensitive) act as role-stand-ins on
// templates. They carry through duplicate-project, sit at the bottom of their team
// card, render with a ghost/italic style, and are skipped by the over-allocation
// calc — they're not real people, just role markers waiting to be reassigned.
function isPlaceholder(name) {
  return /\bplaceholder\b/i.test(String(name || ''));
}

// Capacity snapshot for one discipline:
//   - realCount:     number of active, non-placeholder team members in that discipline
//   - scheduledHrs:  total scheduled hours = SUM(duration_days × 8 × allocation%)
//                    across every task currently assigned to someone in that discipline
//                    (placeholders included, since templated work is still "sold")
//   - weeksAhead:    scheduledHrs ÷ (realCount × 40 × 0.9). null when realCount is 0
//                    (no real people → infinite weeks, not meaningful).
// Drives the "X hrs scheduled · Y wks at 90%" line under each discipline's card.
function computeDisciplineCapacity(discKey, members) {
  const memberNames = new Set(members.map(m => m.name));
  const realCount = members.filter(m => !isPlaceholder(m.name) && m.active !== 0).length;
  let hrs = 0;
  for (const t of state.tasks) {
    if (t.is_milestone) continue;
    // Skip tasks from template projects AND Sales-workspace projects —
    // templates are canonical scaffolding cloned into real projects (not
    // real work); Sales schedules are pre-quote work that hasn't been
    // staffed for real yet. Either would inflate the "X hrs scheduled"
    // reading on every discipline.
    if (isTemplateProject(t.project)) continue;
    if (projectWorkspace(t.project) === 'Sales') continue;
    if (!t.assignee || !memberNames.has(t.assignee)) continue;
    const dur = Number(t.duration_days);
    if (!dur || dur <= 0) continue;
    const alloc = t.allocation == null ? 90 : Math.max(0, Math.min(100, Number(t.allocation)));
    hrs += dur * 8 * (alloc / 100);
  }
  const scheduledHrs = Math.round(hrs);
  const weeklyCapacity = realCount * 40 * 0.9;
  const weeksAhead = weeklyCapacity > 0 ? Math.round((scheduledHrs / weeklyCapacity) * 10) / 10 : null;
  const tooltip = realCount > 0
    ? `${scheduledHrs.toLocaleString()} hrs total ÷ (${realCount} × 40 × 90%) = ${weeksAhead} weeks of work. (Template-project tasks excluded.)`
    : `${scheduledHrs.toLocaleString()} hrs scheduled. Add real team members (non-placeholders) to see capacity in weeks.`;
  return { realCount, scheduledHrs, weeksAhead, tooltip };
}

// Which team disciplines plausibly own this task? Drives the filtered assignee
// dropdown so e.g. a CONTROLS ENGINEERING task only surfaces controls engineers.
// Ambiguous buckets (General Engineering, Section 40/50 dept-level rows where
// either engineers OR shop could own it) return multiple disciplines. Unknown
// or missing classification returns ALL disciplines so the dropdown still shows
// every option as a safe default.
function relevantDisciplinesForTask(task) {
  if (!task) return ['mech', 'controls', 'build', 'wire'];
  const pg  = task.phase_group;
  const dep = task.department;
  const sub = task.sub_department;

  // Section 10 — Design & Build: sub-department is highly specific where set.
  if (pg === 'design_build') {
    if (sub === 'mech')     return ['mech'];
    if (sub === 'controls') return ['controls'];
    if (sub === 'build')    return ['build'];
    if (sub === 'wire')     return ['wire'];
    if (sub === 'general')  return ['mech', 'controls'];   // any engineer
    // Department-level rows (no sub) — engineering = either engineer,
    // shop = either trade, procurement = anyone.
    if (dep === 'engineering') return ['mech', 'controls'];
    if (dep === 'shop')        return ['build', 'wire'];
    if (dep === 'procurement') return ['mech', 'controls', 'build', 'wire'];
  }

  // Section 40 — Machine Testing: dept-only, both disciplines under each.
  if (pg === 'machine_testing') {
    if (dep === 'engineering') return ['mech', 'controls'];
    if (dep === 'shop')        return ['build', 'wire'];
  }

  // Section 50 — Teardown & Install. Teardown is shop-only; Install has both.
  if (pg === 'teardown_install') {
    if (dep === 'teardown') return ['build', 'wire'];
    if (dep === 'install') {
      if (sub === 'engineering') return ['mech', 'controls'];
      if (sub === 'shop')        return ['build', 'wire'];
      // Install at the dept level — anyone.
      return ['mech', 'controls', 'build', 'wire'];
    }
  }

  // Anything else (no classification, anchors before they're given a section,
  // etc.) — return all four so the dropdown is unconstrained.
  return ['mech', 'controls', 'build', 'wire'];
}

function isWeekendDate(d) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

// Snap an ISO date to a business day if it's currently Sat/Sun. dir=1 advances
// forward (Sat → Mon), dir=-1 walks backward (Sat → Fri). Idempotent on weekdays.
function snapToBusinessDay(dateStr, dir = 1) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  while (isWeekendDate(d)) {
    d.setUTCDate(d.getUTCDate() + (dir > 0 ? 1 : -1));
  }
  return d.toISOString().slice(0, 10);
}

// Inclusive count of business days (Mon–Fri) between two ISO dates.
function businessDaysBetween(start, end) {
  if (!start || !end) return null;
  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  if (isNaN(s) || isNaN(e) || e < s) return null;
  let count = 0;
  const cur = new Date(s);
  while (cur <= e) {
    if (!isWeekendDate(cur)) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

// Add n business days to an ISO date. n=0 returns the date unchanged.
function addBusinessDays(startISO, n) {
  if (!startISO) return null;
  if (n === 0) return startISO;
  const d = new Date(startISO + 'T00:00:00Z');
  let remaining = Math.abs(n);
  const dir = n >= 0 ? 1 : -1;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + dir);
    if (!isWeekendDate(d)) remaining--;
  }
  return d.toISOString().slice(0, 10);
}

// Duration display in BUSINESS days. The stored task.duration_days is the SOURCE OF
// TRUTH — what the user typed stays exactly that, regardless of how the end_date
// shifts when crossing weekends. Falls back to a fresh business-day count from
// start/end only when duration_days isn't populated (legacy rows pre-migration).
function durationLabel(task) {
  if (!task) return '';
  if (task.is_milestone) return '0';
  let d = (task.duration_days != null) ? Number(task.duration_days) : null;
  if (d == null) d = businessDaysBetween(task.start_date, task.end_date);
  if (d == null) return '';
  if (d === 0) return '0';
  // Whole weeks: 5, 10, 15, ... → "Nw"
  if (d % 5 === 0 && d >= 5) return `${d / 5}w`;
  // Half-week buckets — every duration generated by the estimate-create
  // pipeline lands on one of these: ceil(n × 2.5) for integer n ≥ 1
  // → 3 (0.5w), 8 (1.5w), 13 (2.5w), 18 (3.5w), 23 (4.5w), 28 (5.5w), 33, 38, 43, 48, 53, 58 (11.5w), ...
  // Detect that pattern and label as half-week: 3 → "0.5w", 13 → "2.5w", etc.
  const nHalfWeeks = Math.round(d / 2.5);
  if (nHalfWeeks >= 1 && Math.ceil(nHalfWeeks * 2.5) === d) {
    return `${nHalfWeeks / 2}w`;
  }
  // Fallback for arbitrary day counts: decimal weeks if ≥ 10 days, else "Nd".
  if (d >= 10) return `${(d / 5).toFixed(1)}w`;
  return `${d}d`;
}

function sortByPhaseThenOrder(tasks) {
  const phaseRank = (p) => {
    if (!p) return 99;
    const idx = window.PHASES.findIndex(ph => ph.key === p);
    return idx >= 0 ? idx : 98;
  };
  return [...tasks].sort((a, b) => {
    const pa = phaseRank(a.phase);
    const pb = phaseRank(b.phase);
    if (pa !== pb) return pa - pb;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y.slice(2)}`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// In-app confirm / alert dialogs that match the SDC app styling instead of the
// browser-native white box. Both return a Promise so callers can `await` them.
// Caller passes plain text (which we escape) — line breaks turn into <br>.
function _formatDialogMessage(msg) {
  if (msg == null) return '';
  return escapeHtml(msg).replace(/\n/g, '<br>');
}
function showConfirmDialog(opts = {}) {
  return new Promise(resolve => {
    document.getElementById('app-confirm-dialog')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'app-confirm-dialog';
    overlay.className = 'modal-overlay app-dialog-overlay';
    overlay.innerHTML = `
      <div class="modal-card app-dialog ${opts.danger ? 'app-dialog-danger' : ''}">
        ${opts.title ? `<div class="modal-head"><h2>${escapeHtml(opts.title)}</h2></div>` : ''}
        <div class="modal-body">
          <div class="app-dialog-message">${_formatDialogMessage(opts.message)}</div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn-ghost" data-action="cancel">${escapeHtml(opts.cancelLabel || 'Cancel')}</button>
          <button type="button" class="${opts.danger ? 'btn-danger' : 'btn-primary'}" data-action="ok">${escapeHtml(opts.okLabel || 'OK')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (result) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector('[data-action="cancel"]').onclick = () => done(false);
    overlay.querySelector('[data-action="ok"]').onclick     = () => done(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter')  { e.preventDefault(); done(true);  }
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => overlay.querySelector('[data-action="ok"]')?.focus(), 0);
  });
}
function showAlertDialog(opts = {}) {
  // Accept either an opts object or a plain string. String form mirrors window.alert.
  if (typeof opts === 'string') opts = { message: opts };
  return new Promise(resolve => {
    document.getElementById('app-alert-dialog')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'app-alert-dialog';
    overlay.className = 'modal-overlay app-dialog-overlay';
    overlay.innerHTML = `
      <div class="modal-card app-dialog">
        ${opts.title ? `<div class="modal-head"><h2>${escapeHtml(opts.title)}</h2></div>` : ''}
        <div class="modal-body">
          <div class="app-dialog-message">${_formatDialogMessage(opts.message)}</div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn-primary" data-action="ok">${escapeHtml(opts.okLabel || 'OK')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve();
    };
    overlay.querySelector('[data-action="ok"]').onclick = done;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); done(); }
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => overlay.querySelector('[data-action="ok"]')?.focus(), 0);
  });
}

// v4.64: SDC-themed password prompt (replaces the browser-native prompt()).
// Renders an in-app modal with the SDC blue + lime branding, returns a
// Promise that resolves to the entered string or null on cancel.
function showPasswordDialog(opts = {}) {
  const title = opts.title || 'Manager password';
  const message = opts.message || 'Enter the team password to continue.';
  return new Promise(resolve => {
    document.getElementById('app-password-dialog')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'app-password-dialog';
    overlay.className = 'modal-overlay app-dialog-overlay';
    overlay.innerHTML = `
      <div class="modal-card app-password-card">
        <div class="app-password-head">
          <h2>${escapeHtml(title)}</h2>
        </div>
        <div class="app-password-body">
          <p class="app-password-msg">${escapeHtml(message)}</p>
          <input type="password" class="app-password-input" autocomplete="off" placeholder="Password" />
          <p class="app-password-error hidden">Wrong password.</p>
        </div>
        <div class="app-password-foot">
          <button type="button" class="btn-ghost" data-action="cancel">Cancel</button>
          <button type="button" class="btn-primary" data-action="ok">Unlock</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input  = overlay.querySelector('.app-password-input');
    const errEl  = overlay.querySelector('.app-password-error');
    const done = (value) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector('[data-action="cancel"]').onclick = () => done(null);
    overlay.querySelector('[data-action="ok"]').onclick = () => done(input.value);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => input.focus(), 0);
    // expose for the caller in case they want to surface a "wrong password"
    // shake without reopening — currently unused, kept for future polish.
    overlay._showError = (msg) => {
      errEl.textContent = msg || 'Wrong password.';
      errEl.classList.remove('hidden');
      input.select();
    };
  });
}

function uniqueValues(field) {
  return [...new Set(state.tasks.map(t => t[field]).filter(Boolean))].sort();
}

// Roll up per-project stats for the schedule header pills:
//   - percentComplete: labor-weighted % done = SUM(duration × progress) /
//     SUM(duration) across non-milestone tasks. Returns null when no tasks have
//     durations yet (fresh project).
//   - fatVariance: business-day signed offset between current FAT anchor's
//     start_date and its baseline_start_date. null when no baseline is set.
function computeProjectStats(project) {
  if (!project) return { percentComplete: null, fatVariance: null };
  const tasks = state.tasks.filter(t => t.project === project);
  // % complete (labor-weighted)
  let weighted = 0, total = 0;
  for (const t of tasks) {
    if (t.is_milestone) continue;
    if (inferredAnchorKey(t)) continue;
    const d = Number(t.duration_days);
    if (!d || d <= 0) continue;
    const p = Math.max(0, Math.min(100, Number(t.progress) || 0));
    total += d;
    weighted += d * p;
  }
  const percentComplete = total > 0 ? Math.round(weighted / total) : null;
  // FAT variance — current FAT vs baseline FAT, in business days.
  const fat = tasks.find(t => inferredAnchorKey(t) === 'fat');
  let fatVariance = null;
  if (fat && fat.baseline_start_date && fat.start_date) {
    if (fat.baseline_start_date === fat.start_date) {
      fatVariance = 0;
    } else {
      const sign = fat.start_date > fat.baseline_start_date ? 1 : -1;
      const days = businessDaysBetween(
        sign > 0 ? fat.baseline_start_date : fat.start_date,
        sign > 0 ? fat.start_date           : fat.baseline_start_date,
      );
      fatVariance = sign * Math.max(0, days - 1);
    }
  }
  return { percentComplete, fatVariance };
}

// Compute how far ahead/behind a task is at today's date. Returns business-day
// integer: positive = ahead of plan, negative = behind, 0 = on track / N/A.
// Mirrors the math in drawScheduleStatus so the chip and the filter agree.
function taskScheduleDelta(task) {
  if (!task || task.is_milestone || !task.start_date || !task.end_date) return 0;
  if (inferredAnchorKey(task)) return 0;
  if (isBacklogTask(task)) return 0;
  const totalDays = businessDaysBetween(task.start_date, task.end_date);
  if (!totalDays || totalDays <= 0) return 0;
  const todayISO = new Date().toISOString().slice(0, 10);
  const actualPct = Math.max(0, Math.min(100, Number(task.progress) || 0));
  let elapsedDays;
  if (todayISO < task.start_date)      elapsedDays = 0;
  else if (todayISO > task.end_date)   elapsedDays = totalDays;
  else                                  elapsedDays = businessDaysBetween(task.start_date, todayISO) || 0;
  const actualDays = (actualPct / 100) * totalDays;
  return Math.round(actualDays - elapsedDays);
}

function applyFilters(tasks) {
  const { search, project, phase, assignee, quick } = state.filters;
  const q = (search || '').trim().toLowerCase();
  const qf = quick || {};
  return tasks.filter(t => {
    if (project && t.project !== project) return false;
    if (phase && t.phase !== phase) return false;
    if (assignee && t.assignee !== assignee) return false;
    if (q) {
      const hay = `${t.name||''} ${t.notes||''} ${t.assignee||''} ${t.project||''} ${t.phase||''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    // v4.45: completed tasks HIDE BY DEFAULT now. The Filters chip flipped
    // polarity — "Show completed" (default off = hide) replaces the older
    // "Not complete" (default off = show). Milestones included in the
    // hide-by-default behavior: a done Receipt of PO / FAT / Mech 1 isn't
    // remaining work, so it stays out of view unless the user wants it.
    const isDone = (t.progress || 0) >= 100;
    if (!qf.showCompleted && isDone) return false;
    // Milestones — anchors (PO / Mech 1 / Power-Up / FAT / Ship) AND the
    // smaller non-anchor milestones (Mech 2 Release, BOM Review, etc.) — are
    // always kept regardless of which quick filter is on. They're spine /
    // schedule markers, not "tasks" the user is asking to focus on. So
    // clicking "Behind schedule" doesn't hide your project anchors, clicking
    // "Assigned" doesn't hide unassigned milestone markers, etc.
    const isAnchor = !!inferredAnchorKey(t);
    if (isAnchor || t.is_milestone) return true;
    if (qf.milestones && !t.is_milestone) return false;
    if (qf.assigned && !t.assignee) return false;
    if (qf.behind && taskScheduleDelta(t) >= 0) return false;
    if (qf.ahead  && taskScheduleDelta(t) <= 0) return false;
    if (qf.overallocated) {
      if (!state.overAllocatedTaskIds || !state.overAllocatedTaskIds.has(t.id)) return false;
    }
    return true;
  });
}

function phaseChip(phaseKey) {
  if (!phaseKey) return '<span class="phase-chip" style="background:#f1f5f9;color:#64748b">—</span>';
  const p = PHASE_BY_KEY[phaseKey];
  if (!p) return `<span class="phase-chip" style="background:#f1f5f9;color:#64748b">${escapeHtml(phaseKey)}</span>`;
  return `<span class="phase-chip" style="background:${p.color};color:${p.text}">${escapeHtml(p.label)}</span>`;
}

// ---------- Table rendering ----------
function cellHtml(t, key) {
  const cls = colClass(key);
  switch (key) {
    case 'line':     return `<td class="${cls}" data-col="line"><span class="row-drag" draggable="true" title="Drag to move">⋮⋮</span><span class="line-num"></span></td>`;
    case 'name': {
      // Task column layout:
      //   LEFT:  [✓] name [drift chip]
      //   RIGHT: [% complete pill] for duration tasks, [checkbox] for milestones
      //          (NOTHING for Backlog — it's a duration-only spine task)
      const done = (t.progress || 0) >= 100;
      const isAnchor = !!inferredAnchorKey(t);
      const isBacklog = isBacklogTask(t);
      const drift = taskScheduleDelta(t);
      let driftChip = '';
      // Drift chip is for IN-PROGRESS work only — once a task is 100% done,
      // there's no "ahead" or "behind" anymore, it's just complete. So skip
      // the chip when done (the green name + checkmark pill already say "done").
      if (drift !== 0 && !t.is_milestone && !isAnchor && !isBacklog && !done) {
        const ahead = drift > 0;
        driftChip = ` <span class="name-drift-chip ${ahead ? 'ahead' : 'behind'}">${ahead ? '+' : ''}${drift}d</span>`;
      }
      const pct = Math.max(0, Math.min(100, Number(t.progress) || 0));
      let rightWidget = '';
      if (isBacklog) {
        // Backlog: no widget. It's a calendar block, not a work task.
        rightWidget = '';
      } else if (!t.is_milestone && !isAnchor) {
        // Duration task: pill renders as a small PROGRESS BAR. The fill width
        // tracks the percent (0–100%), color tracks the schedule status:
        //   - is-zero    (0%):      empty pill outline, "0%" text in slate
        //   - is-behind  (1–99% behind): red fill at pct% width, black text
        //   - is-ontrack (1–99% on/ahead): green fill at pct% width, black text
        //   - is-done    (100%):    full green fill, white ✓ text
        // Was a flat solid-colored pill — that felt heavy (especially the
        // dark green 100% state). The bar version visually answers "how far
        // along is this?" without you having to read the number.
        let pctClass = 'is-zero';
        let pctText = `${pct}%`;
        if (pct >= 100) {
          pctClass = 'is-done';
          pctText = '✓';
        } else if (pct > 0) {
          pctClass = drift < 0 ? 'is-behind' : 'is-ontrack';
        }
        // Fill width: clamp to 0–100. At 100% the .is-done rules cover the
        // whole pill via CSS anyway, but we still set width here so 99 → 100
        // transitions render correctly.
        const fillW = Math.max(0, Math.min(100, pct));
        rightWidget = `<span class="name-edit-pill name-pct-pill ${pctClass}" data-edit-pill data-edit-col="progress" data-task-id="${t.id}" title="% complete — click to edit">`
          + `<span class="name-pct-fill" style="width:${fillW}%"></span>`
          + `<span class="name-pct-text">${pctText}</span>`
          + `</span>`;
      } else {
        // Milestones / anchors get a click-to-toggle checkbox. Progress is
        // binary (0 or 100). Anchors already render via anchorRowHtml with a
        // green chip, but non-anchor milestones (Mech 2 Release, BOM Review,
        // Order Long Lead, etc.) need a way to mark them complete.
        rightWidget = `<button type="button" class="name-milestone-check ${done ? 'is-done' : ''}" data-toggle-milestone data-task-id="${t.id}" title="${done ? 'Mark not complete' : 'Mark complete'}">${done ? '✓' : ''}</button>`;
      }
      const classes = [cls];
      if (isBacklog) classes.push('name-backlog');
      // Note: completed duration tasks deliberately do NOT get a "name-done"
      // class — the task name stays black/normal, same as a completed milestone.
      // The green ✓ pill on the right is the sole signal that the row is done,
      // so duration tasks and milestones read consistently when complete.
      if (rightWidget) classes.push('has-pills');
      // v4.39: `has-meta` indicates the row will render the alloc + dash +
      // dur spans (regular tasks only). CSS uses this class to reserve TD
      // padding-left for the absolute-positioned alloc and dur — milestones
      // and anchors that DON'T have meta keep their name flush at the left.
      const hasMeta = !t.is_milestone && !isAnchor && !isBacklog;
      if (hasMeta) classes.push('has-meta');
      // v4.30: Single-line PLAIN-TEXT layout. No more stacked meta row, no
      // more pill-styled allocation/duration. Just inline text:
      //     85%  Task Name - 1w           [% complete pill]
      //     \_/  \_______/ \__/            \_pinned right_/
      //     pre   bold name  dur-post
      //
      // The pre-allocation text is hidden via .hide-alloc-pre on body
      // (controlled by the α icon in the View pill). Both alloc + dur are
      // still click-to-edit via data-edit-pill — they look like plain text
      // but pick up an underline on hover. Skipped for milestones / anchors /
      // backlog (no meaningful allocation × duration there).
      let allocPre = '';
      let dashSep = '';
      let durEl = '';
      if (!t.is_milestone && !isAnchor && !isBacklog) {
        const allocVal = t.allocation == null ? null : Number(t.allocation);
        const durDays  = Number(t.duration_days) || 0;
        const wks = durDays > 0 ? Math.round(durDays / 5 * 10) / 10 : 0;  // 1 decimal week
        const allocText = allocVal != null && allocVal > 0 ? `${allocVal}%` : '—%';
        // v4.43: uppercase W in duration text per user request — "10W" not "10w".
        const wksText   = wks > 0 ? `${wks}W` : '—W';
        // v4.36: Sales-workspace tasks NO LONGER auto-hide allocation in
        // the Task column meta. The α icon in the View pill is now the
        // single authoritative control for alloc visibility — turn it off
        // when presenting to a customer / sales rep (hides alloc across
        // ALL projects regardless of workspace), turn it on otherwise.
        // Earlier (v4.22) Sales tasks hid alloc unconditionally even with
        // α on, which made the toggle look broken when the user was
        // viewing the SDC_Sales_Template.
        allocPre = `<span class="name-cell-alloc-pre" data-edit-pill data-edit-col="allocation" data-task-id="${t.id}" title="Allocation — click to edit">${allocText}</span>`;
        dashSep  = `<span class="name-cell-dash">–</span>`;
        // v4.43: link badge moved BEFORE the duration value so the dur
        // value stays right-aligned at the column's right edge (consistent
        // across all rows whether linked or not). Layout reads as
        // "🔗24 10W" — badge on the left, duration on the right. Badge
        // is still inside .name-cell-dur with pointer-events: none so
        // clicks pass through to the dur for re-editing.
        let linkBadge = '';
        if (t.duration_link_task_id) {
          const earlyLine = lineByTaskId[t.duration_link_task_id];
          const earlyText = earlyLine != null ? `🔗${earlyLine}` : '🔗?';
          linkBadge = `<span class="name-cell-dur-link" data-link-target-id="${t.duration_link_task_id}">${earlyText}</span> `;
        }
        durEl = `<span class="name-cell-dur" data-edit-pill data-edit-col="duration" data-task-id="${t.id}" title="Duration — click to edit (e.g. 5d, 2w, or = then click another row to link)">${linkBadge}${wksText}</span>`;
      }
      // v4.39: dropped the .name-cell-row flex wrapper. alloc, dash, and
      // dur are now ABSOLUTE-POSITIONED inside the TD (deterministic offsets
      // from the column's left/right edges), and the task name flows in
      // the TD's content area between them. CSS controls the TD's
      // padding-left / padding-right so the name doesn't overlap the
      // absolutely-placed siblings. This guarantees that body alloc lines
      // up pixel-for-pixel with the header ALOC label, since both use the
      // same absolute coordinates from the cell edge.
      return `<td class="${classes.join(' ')}" data-col="name">${allocPre}${dashSep}<span class="name-cell-main">${escapeHtml(t.name)}${driftChip}</span>${durEl}${rightWidget ? `<span class="name-cell-pills">${rightWidget}</span>` : ''}</td>`;
    }
    case 'assignee': {
      // SALES workspaces blank out the assignee — pre-quote work isn't
      // staffed yet, and showing "ME Placeholder" or a real name on a sales
      // schedule risks accidentally communicating who'll own the work
      // before the deal is signed.
      if (isSalesProjectTask(t)) {
        return `<td class="${cls} sales-suppressed" data-col="assignee" title="Sales schedules don't carry Assigned To — staff after the project moves to Active."></td>`;
      }
      // When this task is over-allocated for its assignee — i.e. its priority pushes the
      // running daily total over 100% somewhere in its span — flag the cell so the user
      // sees in the Schedule view that this person can't actually accomplish all their
      // higher-priority work plus this one.
      const over = state.overAllocatedTaskIds && state.overAllocatedTaskIds.has(t.id);
      const ph = isPlaceholder(t.assignee);
      const classes = [cls];
      if (over) classes.push('over-allocated');
      if (ph)   classes.push('placeholder-assignee');
      const title = over
        ? 'title="Over-allocated — earlier-priority tasks already fill this person\'s capacity"'
        : (ph ? 'title="Placeholder — replace with a real team member when staffing this task"' : '');
      return `<td class="${classes.join(' ')}" data-col="assignee" ${title}>${escapeHtml(t.assignee || '')}</td>`;
    }
    case 'start':    return `<td class="${cls}" data-col="start">${fmtDate(t.start_date)}</td>`;
    case 'finish':   return `<td class="${cls}" data-col="finish">${fmtDate(t.end_date)}</td>`;
    case 'duration': {
      // v4.84: Backlog row gets a real inline <select> dropdown for picking
      // a common duration (1w through 12w + "Custom…"). The text-input
      // click-to-edit path is still available for non-standard values via
      // the "Custom…" option. Solves the "I don't see how to change this"
      // discoverability problem.
      const isBacklogRow = isBacklogTask(t);
      if (isBacklogRow) {
        const curDays = Number(t.duration_days) || 0;
        const opts = [
          { d: 5,  label: '1w' },
          { d: 10, label: '2w' },
          { d: 15, label: '3w' },
          { d: 20, label: '4w' },
          { d: 25, label: '5w' },
          { d: 30, label: '6w' },
          { d: 40, label: '8w' },
          { d: 50, label: '10w' },
          { d: 60, label: '12w' },
        ];
        // If the current value is one of our presets, mark it selected.
        // Otherwise we render it as a one-off "current" option at the top.
        const hasPreset = opts.some(o => o.d === curDays);
        const optionsHtml = (hasPreset ? '' :
          `<option value="${curDays}" selected>${escapeHtml(durationLabel(t))}</option>`)
          + opts.map(o => `<option value="${o.d}" ${o.d === curDays ? 'selected' : ''}>${o.label}</option>`).join('')
          + '<option value="__custom__">Custom…</option>';
        return `<td class="${cls} is-backlog-duration" data-col="duration" title="Pick a backlog duration — click to choose.">
          <select class="backlog-duration-select" data-id="${t.id}">${optionsHtml}</select>
        </td>`;
      }
      return `<td class="${cls}" data-col="duration">${durationLabel(t)}</td>`;
    }
    case 'pred':     return `<td class="${cls}" data-col="pred"></td>`; /* filled in by updateLineNumbers */
    case 'progress': {
      const p = t.progress || 0;
      return `<td class="${cls}" data-col="progress"><span class="progress-bar"><span style="width:${p}%"></span></span> ${p}%</td>`;
    }
    case 'allocation': {
      // SALES workspaces blank the allocation cell — see meta-row / assignee
      // notes above. Sales work is pre-quote so allocation isn't meaningful.
      if (isSalesProjectTask(t)) {
        return `<td class="${cls} sales-suppressed" data-col="allocation" title="Sales schedules don't carry allocations — set after the project moves to Active."></td>`;
      }
      // Default to 100 for tasks predating this column. Milestones shouldn't show an
      // allocation since they don't consume time — render a dash so they read as N/A.
      const a = t.is_milestone ? '—' : (t.allocation == null ? 90 : t.allocation);
      return `<td class="${cls}" data-col="allocation">${a === '—' ? '—' : `${a}%`}</td>`;
    }
    case 'priority': {
      // Per-assignee priority. Value displayed verbatim — the resources view is the
      // primary editor (drag/click pills there); this column is mostly for visibility.
      const p = t.priority == null ? '—' : t.priority;
      return `<td class="${cls}" data-col="priority">${p}</td>`;
    }
    case 'notes': {
      // Free-text comments. Truncated visually via CSS so long notes don't
      // blow up the row; full content shown on hover via title attribute.
      const text = t.notes || '';
      const safe = escapeHtml(text);
      return `<td class="${cls}" data-col="notes" title="${safe}">${safe}</td>`;
    }
  }
  return `<td data-col="${key}"></td>`;
}

// Pick the color "key" for a task row based on its position in the hierarchy. Sub-dept
// wins (mech/controls/general/build/wire); else the department's combined key
// (eng-combined / shop-combined / procurement) drives the color.
function rowColorKey(task) {
  // Sub-department wins. The sub-depts named 'engineering' / 'shop' (section 50
  // INSTALL has them) share the combined eng/shop palette so they read like
  // section 40's dept-only engineering/shop.
  if (task.sub_department) {
    if (task.sub_department === 'engineering') return 'eng-combined';
    if (task.sub_department === 'shop')        return 'shop-combined';
    return task.sub_department; // mech, controls, general, build, wire
  }
  // Department-level — Engineering and Shop are the combined blend palette.
  // Teardown (section 50, shop-only) reuses the shop palette.
  if (task.department === 'engineering') return 'eng-combined';
  if (task.department === 'shop')        return 'shop-combined';
  if (task.department === 'teardown')    return 'shop-combined';
  if (task.department === 'procurement') return 'procurement';
  return '';
}

function rowHtml(t, depth = 0) {
  const order = state.layout.columnOrder;
  const cells = order.map(k => cellHtml(t, k)).join('');
  const colorKey = rowColorKey(t);
  // The left-edge stripe on the name column uses the HIERARCHY color (mech blue,
  // controls green, build orange, wire yellow, etc.) so every task in a section
  // gets the right stripe — regardless of whether its phase field is set. Falls
  // back to phase color, then to transparent.
  const hier = HIERARCHY_BAR_COLORS && HIERARCHY_BAR_COLORS[colorKey];
  const stripe = (hier && hier.fill) || PHASE_BY_KEY[t.phase]?.color || 'transparent';
  // Row itself is NOT draggable — only the .row-drag handle in the line column is, so the
  // rest of the row is free for click-drag horizontal panning of the grid panel.
  // Non-anchor milestones (e.g. Mech 2 Release, BOM Review) also get the "done"
  // treatment so all 0-duration rows read consistently — green check on the row
  // chip + a diamond fill that matches anchors. Anchors take their own path via
  // anchorRowHtml above; this is for the regular bucket-resident milestones.
  const milestoneDone = t.is_milestone && (t.progress || 0) >= 100 ? ' milestone-done' : '';
  // v4.45: completed DURATION tasks (non-milestone, progress >= 100) get
  // a task-done class so CSS can paint the row with the lime outline +
  // diagonal hash pattern. The Filters popover's "Show completed" toggle
  // controls whether these rows are filtered out entirely.
  const taskDone = !t.is_milestone && (t.progress || 0) >= 100 ? ' task-done' : '';
  // v4.46: action items get is-action so CSS can italicize the task name
  // and (in Combined view) tint the row subtly to differentiate from
  // scheduled work.
  const actionCls = t.is_action ? ' is-action' : '';
  // v4.49: actions past their due date but not marked complete paint
  // RED in both the grid row and (for milestone-style actions) the Gantt
  // diamond. Limited to actions for now — regular scheduled work has its
  // own drift chip system. Today is computed once at render time so we
  // don't re-evaluate per row.
  const todayISO = new Date().toISOString().slice(0, 10);
  const overdueCls = (t.is_action && (t.progress || 0) < 100 && t.end_date && t.end_date < todayISO) ? ' is-overdue' : '';
  return `<tr data-id="${t.id}" class="depth-${depth} ${t.is_milestone ? 'is-milestone' : ''}${milestoneDone}${taskDone}${actionCls}${overdueCls}" data-color-key="${colorKey}" style="--row-phase-color:${stripe}">${cells}</tr>`;
}

function headerRowHtml(level, label, path, collapsed, dataAttrs = {}) {
  const cols = state.layout.columnOrder.length;
  const caret = collapsed ? '▸' : '▾';
  const attrs = Object.entries(dataAttrs)
    .map(([k, v]) => ` data-${k}="${escapeHtml(String(v))}"`).join('');
  // v4.29: wrap the leading "NN " section number (e.g. "10 DESIGN & BUILD")
  // in its own <span> so customer-view CSS can hide just the number portion.
  // SDC team uses the section numbers internally; customers don't care about
  // "10 / 40 / 50" — they just see the section name.
  const labelStr = String(label || '');
  const m = labelStr.match(/^(\d+\s+)(.*)$/);
  const labelHtml = m
    ? `<span class="group-label-num">${escapeHtml(m[1])}</span>${escapeHtml(m[2])}`
    : escapeHtml(labelStr);
  return `
    <tr class="group-header level-${level} ${collapsed ? 'collapsed' : ''}" data-path="${escapeHtml(path)}"${attrs}>
      <td colspan="${cols}">
        <span class="group-caret">${caret}</span>
        <span class="group-label">${labelHtml}</span>
      </td>
    </tr>`;
}

function renderTable() {
  const tbody = document.getElementById('tasks-tbody');
  let filtered = applyFilters(state.tasks);
  // v4.46: Actions mode filter. Default 'schedule' hides action items
  // entirely; 'actions' shows ONLY actions; 'combined' shows both.
  // Anchor rows (Receipt of PO, FAT, Ship Machine, etc.) are always kept
  // because they're project-spine markers, not work items.
  const am = state.scheduleView?.actionsMode || 'schedule';
  if (am === 'schedule') {
    filtered = filtered.filter(t => !t.is_action || inferredAnchorKey(t));
  } else if (am === 'actions') {
    filtered = filtered.filter(t => t.is_action || inferredAnchorKey(t));
  }
  // Only-critical mode: restrict the visible set to tasks on the critical-path
  // chain. Anchor milestones are always kept (Receipt of PO / FAT / Ship Machine)
  // since they're the spine markers — Ship Machine sits outside the path but is
  // still useful context. If the user wants ship-machine hidden too, they can
  // collapse the section.
  if (state.scheduleView?.criticalOnly && state.scheduleView?.criticalPath) {
    const crit = computeCriticalPath();
    filtered = filtered.filter(t => crit.has(String(t.id)) || inferredAnchorKey(t));
  }
  const empty = document.getElementById('empty-state');

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = state.tasks.length === 0
      ? 'No tasks yet. Click + New Task to add one.'
      : 'No tasks match the current filters.';
    return;
  }
  empty.classList.add('hidden');

  // Bucket tasks by hierarchy path. Most anchor milestones render as fixed rows
  // outside the section walk (Receipt of PO above 10, FAT between 40/50, Ship
  // Machine between teardown and install). Mech 1 Release and Machine Power-Up
  // are the exceptions — they live INSIDE the hierarchy buckets (10 → Mech Eng
  // and 10 → Shop → Wire respectively) so they flow with their team's work.
  // Anchor styling is layered on at render time via renderTaskRow's branching.
  const INLINE_ANCHORS = new Set(['mech_release_1', 'machine_power_up']);
  const buckets = {};
  for (const t of filtered) {
    const k = inferredAnchorKey(t);
    if (k && !INLINE_ANCHORS.has(k)) continue;
    const path = groupPath(t.phase_group, t.department, t.sub_department);
    (buckets[path] ||= []).push(t);
  }
  // Sort each bucket — by start_date when the user has flipped the "By date" toggle,
  // otherwise by their manual sort_order so drag-reordering sticks. In BOTH cases,
  // action items (is_action = 1) sort to the BOTTOM of their bucket so scheduled
  // work appears first and actions read as "extras tucked under their section."
  // v4.46 added the is_action secondary sort.
  const sortBucket = (arr) => {
    if (state.scheduleView.sortByStart) {
      arr.sort((a, b) =>
        ((a.is_action ? 1 : 0) - (b.is_action ? 1 : 0))
        || (a.start_date || '￿').localeCompare(b.start_date || '￿')
        || (a.sort_order || 0) - (b.sort_order || 0));
    } else {
      arr.sort((a, b) =>
        ((a.is_action ? 1 : 0) - (b.is_action ? 1 : 0))
        || (a.sort_order || 0) - (b.sort_order || 0));
    }
  };
  for (const k in buckets) sortBucket(buckets[k]);

  // Flatten mode collects every task under each section into one ordered list and
  // skips dept / sub-dept walks. Built once so it's cheap to look up per section.
  // Same INLINE_ANCHORS rule as the bucketed walk: Mech 1 Release and Machine
  // Power-Up flow into their section's flat list; the other anchors render
  // outside the walk regardless of what their stored phase_group says.
  const flatBySection = {};
  if (state.scheduleView.flatten) {
    for (const t of filtered) {
      const k = inferredAnchorKey(t);
      if (k && !INLINE_ANCHORS.has(k)) continue;
      if (!t.phase_group) continue;
      (flatBySection[t.phase_group] ||= []).push(t);
    }
    for (const k in flatBySection) sortBucket(flatBySection[k]);
  }

  let html = '';
  // Anchor milestones (Receipt of PO, FAT, Ship Machine) live OUTSIDE the regular
  // hierarchy as project-spine markers. Receipt of PO sits above section 10; FAT
  // sits between sections 40 and 50; Ship Machine sits between TEARDOWN and INSTALL
  // inside section 50. EXACTLY ONE of each is rendered (oldest wins on duplicates).
  // The row stays plain white — only the task NAME gets the configured anchor color
  // as a small chip, so the marker stands out without flooding the row.
  const anchorRowHtml = (t, opts = {}) => {
    const order = state.layout.columnOrder;
    const isDone = (t.progress || 0) >= 100;
    const isBacklog = !!opts.backlog;
    // v4.84: backlog is "expired" once its end_date is in the past — the
    // calendar time it represented has elapsed. We don't check it off; we
    // just signal with a lime-green border that the backlog window is over.
    const todayMs = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
    const backlogExpired = isBacklog && t.end_date && new Date(t.end_date).getTime() < todayMs;
    const cells = order.map(k => {
      if (k === 'name') {
        const check = (isDone && !isBacklog) ? '<span class="anchor-done-check">✓</span> ' : '';
        const chipCls = `anchor-name-chip${isBacklog ? ' backlog-chip' : ''}${backlogExpired ? ' is-expired' : ''}`;
        return `<td data-col="name"><span class="${chipCls}">${check}${escapeHtml(t.name || '')}</span></td>`;
      }
      return cellHtml(t, k);
    }).join('');
    // groupTop: black border ABOVE the row (default true for unrelated anchors)
    // groupBottom: black border BELOW the row (default true for unrelated anchors)
    // When PO + Backlog are stacked, PO gets groupTop only and Backlog gets
    // groupBottom only — they read as one continuous spine block.
    const groupTop    = opts.groupTop    !== false;
    const groupBottom = opts.groupBottom !== false;
    const cls = `depth-1 anchor-row${isDone && !isBacklog ? ' is-done' : ''}${isBacklog ? ' backlog-row' : ''}${!groupTop ? ' no-top-border' : ''}${!groupBottom ? ' no-bottom-border' : ''}`;
    return `<tr data-id="${t.id}" class="${cls}" data-anchor-key="${escapeHtml(inferredAnchorKey(t) || '')}">${cells}</tr>`;
  };
  const candidates = filtered
    .map(t => [t, inferredAnchorKey(t)])
    .filter(([, k]) => !!k);
  const pickOldest = (key) => {
    const list = candidates.filter(([, k]) => k === key).map(([t]) => t);
    if (list.length === 0) return null;
    return list.reduce((a, b) => (a.id < b.id ? a : b));
  };
  const receiptAnchor = pickOldest('receipt_of_po');
  const fatAnchor     = pickOldest('fat');
  const shipAnchor    = pickOldest('ship_machine');
  // Receipt of PO — top of the schedule, above section 10.
  const backlogTask = filtered.find(t => isBacklogTask(t));
  // If Backlog is present, suppress PO's BOTTOM border so PO + Backlog read as
  // one continuous spine block (border only at the very top of PO and very
  // bottom of Backlog).
  if (receiptAnchor) html += anchorRowHtml(receiptAnchor, { groupBottom: !backlogTask });
  if (backlogTask)   html += anchorRowHtml(backlogTask,   { backlog: true, groupTop: false });

  // Walk the full canonical hierarchy. Every level renders its header even when empty —
  // the skeleton tells the user where to put tasks. Tasks attach at any level: directly
  // under a phase_group (cross-cutting like Perform FAT), under a department, or under a
  // sub-department. Machine Power-Up flows through the bucket walk like any other Wire
  // task — its anchor styling is applied by the row renderer below.
  for (const group of HIERARCHY) {
    const gPath = groupPath(group.key);
    const gCollapsed = collapsedGroups.has(gPath);
    html += headerRowHtml(1, group.label, gPath, gCollapsed, { 'section-key': group.key });
    if (gCollapsed) continue;

    // Flatten mode: drop every dept/sub-dept header, render this section's tasks as
    // one flat list. Ship Machine still sits in section 50 between teardown and
    // install tasks; FAT still closes section 40.
    // Helper — pick the right row renderer for a task. Anchor tasks (currently just
    // Machine Power-Up flows through the bucket walk) get the anchor chip styling
    // so they read as spine markers even while sitting inline with their siblings.
    const renderTaskRow = (t, depth) => inferredAnchorKey(t) ? anchorRowHtml(t) : rowHtml(t, depth);

    if (state.scheduleView.flatten) {
      const sectionTasks = flatBySection[group.key] || [];
      let shipDropped = false;
      for (const t of sectionTasks) {
        // For section 50, splice the Ship Machine anchor in once we cross from
        // teardown work to install work (or as the last row if everything is
        // teardown). Sort-by-date naturally orders it correctly.
        if (group.key === 'teardown_install' && shipAnchor && !shipDropped && t.department === 'install') {
          html += anchorRowHtml(shipAnchor);
          shipDropped = true;
        }
        html += renderTaskRow(t, 2);
      }
      if (group.key === 'teardown_install' && shipAnchor && !shipDropped) {
        html += anchorRowHtml(shipAnchor);
      }
      // FAT at the end of section 40 even in flatten mode (collapses with the section).
      if (group.key === 'machine_testing' && fatAnchor) {
        html += anchorRowHtml(fatAnchor);
      }
      continue;
    }

    // Tasks pinned at the phase_group level (no department)
    const groupLevelTasks = buckets[gPath] || [];
    for (const t of groupLevelTasks) html += renderTaskRow(t, 2);
    for (const dept of group.departments) {
      // Ship Machine sits between TEARDOWN and INSTALL inside section 50 — it's the
      // gate where the disassembled machine leaves SDC for the customer's site.
      if (group.key === 'teardown_install' && dept.key === 'install' && shipAnchor) {
        html += anchorRowHtml(shipAnchor);
      }
      const dPath = groupPath(group.key, dept.key);
      const dCollapsed = collapsedGroups.has(dPath);
      // For section 10, the Engineering and Shop departments are pure containers —
      // every task lives in a sub-department under them. The container header reads as
      // visual noise, so we skip it and let the sub-deps render directly under the
      // section. Procurement (no subs) and the section 40/50 dept-only groups still
      // get headers — those rows hold tasks themselves.
      const skipDeptHeader = group.key === 'design_build' && dept.subs.length > 0;
      if (!skipDeptHeader) {
        html += headerRowHtml(2, dept.label, dPath, dCollapsed,
          { 'section-key': group.key, 'dept-key': dept.key });
        if (dCollapsed) continue;
      }
      if (dept.subs.length > 0) {
        // Tasks pinned at the department level (no sub_department)
        const deptLevelTasks = buckets[dPath] || [];
        for (const t of deptLevelTasks) html += renderTaskRow(t, 3);
        for (const sub of dept.subs) {
          const sPath = groupPath(group.key, dept.key, sub.key);
          const sCollapsed = collapsedGroups.has(sPath);
          html += headerRowHtml(3, sub.label, sPath, sCollapsed,
            { 'section-key': group.key, 'dept-key': dept.key, 'sub-key': sub.key });
          if (sCollapsed) continue;
          const tasks = buckets[sPath] || [];
          for (const t of tasks) html += renderTaskRow(t, 4);
        }
      } else {
        const tasks = buckets[dPath] || [];
        for (const t of tasks) html += renderTaskRow(t, 3);
      }
    }
    // FAT closes section 40 — it's the gate that ends machine testing. Rendered INSIDE
    // section 40's iteration so that collapsing the section also tucks FAT away. Falls
    // after every dept walk so it's the last row in section 40.
    if (group.key === 'machine_testing' && fatAnchor) {
      html += anchorRowHtml(fatAnchor);
    }
  }

  // No UNASSIGNED bucket and no orphan auto-promote. Orphans (tasks with no phase_group
  // and not an anchor) simply don't render — server-side dedupe handles cleanup.

  tbody.innerHTML = html;
  if (state.layout) applyColumnVisibility();

  updateLineNumbersAndPreds();

  tbody.querySelectorAll('tr.group-header').forEach(tr => {
    tr.addEventListener('click', () => {
      const path = tr.dataset.path;
      if (collapsedGroups.has(path)) collapsedGroups.delete(path);
      else collapsedGroups.add(path);
      // Re-render BOTH grid and Gantt — the Gantt filters by collapsed groups too,
      // so its bars hide / re-appear in lockstep with the grid rows.
      renderTable();
      renderGantt();
    });
  });

  // v4.84: Backlog duration <select> — picking a preset (1w / 2w / ...) sets
  // duration_days directly. "Custom…" falls back to the inline text editor.
  tbody.querySelectorAll('.backlog-duration-select').forEach(sel => {
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('mousedown', (e) => e.stopPropagation());
    sel.addEventListener('change', async (e) => {
      e.stopPropagation();
      const id = Number(sel.dataset.id);
      if (sel.value === '__custom__') {
        // Restore visible select then open the underlying duration edit.
        const td = sel.closest('td[data-col="duration"]');
        if (td) enterCellEdit(td, id, 'duration');
        return;
      }
      const days = Math.max(0, Number(sel.value) || 0);
      await api.update(id, { duration_days: days });
      await loadTasks();
    });
  });

  attachRowDragHandlers(tbody);
}

// Drag a task row onto a section header / another task to move it into that section.
// Within-section drops (onto a sibling task) reorder; cross-section drops reclassify.
function attachRowDragHandlers(tbody) {
  let draggedId = null;

  const clearDropMarkers = () => {
    tbody.querySelectorAll('.drop-target, .drop-after, .drop-before').forEach(el => {
      el.classList.remove('drop-target', 'drop-after', 'drop-before');
    });
  };

  // Drag is initiated from the .row-drag handle in the line column, not the whole row.
  tbody.querySelectorAll('.row-drag[draggable]').forEach(handle => {
    const tr = handle.closest('tr[data-id]');
    if (!tr) return;
    handle.addEventListener('dragstart', (e) => {
      draggedId = Number(tr.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(draggedId));
      tr.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => {
      tr.classList.remove('dragging');
      clearDropMarkers();
      draggedId = null;
    });
  });

  // Headers, add-rows, and task rows are valid drop targets.
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('dragover', (e) => {
      if (!draggedId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropMarkers();
      tr.classList.add('drop-target');
      if (tr.dataset.id) {
        // Task row — pick before/after based on cursor position.
        const rect = tr.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        tr.classList.add(after ? 'drop-after' : 'drop-before');
      }
    });
    tr.addEventListener('drop', async (e) => {
      if (!draggedId) return;
      e.preventDefault();
      const movedId = draggedId;
      draggedId = null;
      clearDropMarkers();

      // Resolve target section + reorder anchor.
      let phase_group = null, department = null, sub_department = null, anchorId = null, anchorBefore = false;
      if (tr.classList.contains('group-header')) {
        const [pg, d, s] = (tr.dataset.path || '').split('/');
        phase_group = pg || null; department = d || null; sub_department = s || null;
      } else if (tr.dataset.id) {
        const target = state.tasks.find(t => t.id === Number(tr.dataset.id));
        if (!target || target.id === movedId) return;
        phase_group = target.phase_group; department = target.department; sub_department = target.sub_department;
        anchorId = target.id;
        anchorBefore = tr.classList.contains('drop-before') || (e.clientY - tr.getBoundingClientRect().top) <= tr.getBoundingClientRect().height / 2;
      } else {
        return;
      }

      // 1) Reclassify the moved task.
      await api.update(movedId, { phase_group, department, sub_department });

      // 2) If dropped near a sibling task, splice the order.
      if (anchorId) {
        const fresh = await api.list();
        const inSection = fresh
          .filter(t => t.phase_group === phase_group && t.department === department && t.sub_department === sub_department)
          .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        const filtered = inSection.filter(t => t.id !== movedId);
        const idx = filtered.findIndex(t => t.id === anchorId);
        const insertAt = idx + (anchorBefore ? 0 : 1);
        filtered.splice(insertAt, 0, fresh.find(t => t.id === movedId));
        // Build full id list preserving everyone else's existing order.
        const movedSet = new Set(filtered.map(t => t.id));
        const others = fresh.filter(t => !movedSet.has(t.id)).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        const fullOrder = [...others.map(t => t.id)];
        // Splice the section's reordered ids back into the position of the first section task.
        const firstIdx = fresh.findIndex(t => movedSet.has(t.id));
        fullOrder.splice(firstIdx >= 0 ? firstIdx : fullOrder.length, 0, ...filtered.map(t => t.id));
        await fetch('/api/tasks/reorder', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ order: fullOrder }),
        });
      }

      await loadTasks();
    });
  });
}

function handleCellClick(e) {
  const delBtn = e.target.closest('.row-delete');
  if (delBtn) {
    e.stopPropagation();
    deleteTaskById(Number(delBtn.dataset.taskId));
    return;
  }
  // Editable pill inside the Task column (allocation / % complete). Intercept first
  // so the broader name-cell edit handler doesn't try to edit the task name.
  const pill = e.target.closest('[data-edit-pill]');
  if (pill) {
    e.stopPropagation();
    const taskId = Number(pill.dataset.taskId);
    const col = pill.dataset.editCol;
    enterPillEdit(pill, taskId, col);
    return;
  }
  // Milestone / anchor checkbox — toggle progress between 0 and 100.
  const mcheck = e.target.closest('[data-toggle-milestone]');
  if (mcheck) {
    e.stopPropagation();
    const taskId = Number(mcheck.dataset.taskId);
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    const newProgress = (task.progress || 0) >= 100 ? 0 : 100;
    api.update(taskId, { progress: newProgress }).then(() => loadTasks());
    return;
  }
  // v4.84: Backlog duration select handles its own clicks — don't open the
  // generic enterCellEdit path on top of it.
  if (e.target.closest('.backlog-duration-select')) return;
  const td = e.target.closest('td[data-col]');
  if (!td) return;
  const tr = td.closest('tr[data-id]');
  if (!tr) return;
  const id = Number(tr.dataset.id);
  const col = td.dataset.col;
  if (col === 'line') return; // auto-computed, not editable
  // Sales-workspace tasks have allocation + assignee suppressed (v4.22).
  // Clicking those blank cells should be a no-op — the tooltip on the cell
  // explains why it's empty.
  if (td.classList.contains('sales-suppressed')) return;
  enterCellEdit(td, id, col);
}

// Mini-editor for the right-side pills inside the Task column. Same machinery as
// enterCellEdit (uses createEditInput + saveCellEdit) but contained inside the
// pill so the surrounding name cell layout doesn't reflow.
function enterPillEdit(pill, taskId, col) {
  if (pill.querySelector('input, select')) return;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  const original = currentCellValue(task, col);
  const input = createEditInput(col, original, task);
  input.classList.add('name-pill-input');
  // v4.32: pin the input's width to the column's expected content size.
  // Without this, the browser-default <input> width (~150px) blows up the
  // flex layout (alloc/dur) or the absolute-positioned % pill — the editor
  // appears in a totally different spot than the text the user clicked.
  // The three editable columns all have short values; 44px fits any of them.
  if (col === 'allocation') input.style.width = '36px';
  else if (col === 'duration') input.style.width = '44px';
  else if (col === 'progress') input.style.width = '40px';
  pill.classList.add('editing');
  pill.innerHTML = '';
  pill.appendChild(input);
  input.focus();
  if (typeof input.select === 'function') input.select();

  let done = false;
  // v4.25: click-outside dismissal. blur() alone doesn't fire when the user
  // clicks on the SVG Gantt (SVG elements aren't focusable by default), so
  // the pill editor would just sit there even though the user clearly
  // wanted to dismiss it. A document-level mousedown listener catches the
  // click ANYWHERE outside the input and finalizes (commits) — same as if
  // they'd hit Enter.
  const onOutsideMousedown = (e) => {
    if (input.contains(e.target)) return;
    finalize(true);
  };
  const finalize = async (commit) => {
    if (done) return;
    done = true;
    document.removeEventListener('mousedown', onOutsideMousedown, true);
    if (commit && input.value !== original) {
      try { await saveCellEdit(taskId, col, input.value, task); }
      catch (err) { console.error(err); }
    }
    await loadTasks();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finalize(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finalize(false); }
    // v4.42: when editing a DURATION cell, pressing "=" enters CLICK-PICK
    // mode — the editor closes WITHOUT saving and the user can click any
    // OTHER row's duration cell to link to it. This is the UX the user
    // asked for ("click the duration, hit equals, click another duration").
    // Cancelable with Escape or by clicking somewhere that isn't a dur cell.
    else if (col === 'duration' && e.key === '=') {
      e.preventDefault();
      // Discard the source-side edit — we're not saving a typed duration,
      // we're starting a link pick.
      finalize(false);
      enterDurationLinkPickMode(taskId);
    }
  });
  input.addEventListener('blur', () => finalize(true));
  // Capture phase so we beat any stopPropagation that Gantt / other handlers
  // might do on their own mousedowns.
  document.addEventListener('mousedown', onOutsideMousedown, true);
}

// v4.42: Duration LINK click-pick mode.
// Flow: user clicks dur on row A → editor opens → user hits "=" → editor
// closes, app shows visual pick-mode hint → user clicks dur on row B →
// row A links to row B (duration_link_task_id = B.id, duration_days copied
// from B). Pressing Escape or clicking somewhere that isn't a dur cell
// cancels without linking.
function enterDurationLinkPickMode(sourceTaskId) {
  const source = state.tasks.find(t => t.id === sourceTaskId);
  if (!source) return;
  document.body.classList.add('duration-link-pick-mode');

  const cleanup = () => {
    document.removeEventListener('mousedown', onPickMousedown, true);
    document.removeEventListener('keydown', onPickKey);
    document.body.classList.remove('duration-link-pick-mode');
  };

  const onPickMousedown = (e) => {
    // Find the dur cell that was clicked (if any).
    const dur = e.target.closest('.name-cell-dur[data-task-id]');
    if (!dur) {
      // Clicked outside any duration cell — cancel.
      cleanup();
      return;
    }
    const targetTaskId = Number(dur.getAttribute('data-task-id'));
    if (!targetTaskId || targetTaskId === sourceTaskId) {
      cleanup();
      return;
    }
    const target = state.tasks.find(t => t.id === targetTaskId);
    if (!target) {
      cleanup();
      return;
    }
    // Beat the regular click handler (which would open an editor on the
    // target dur). Capture-phase + preventDefault + stopPropagation.
    e.preventDefault();
    e.stopPropagation();

    const days = Number(target.duration_days) || 0;
    const data = {
      duration_link_task_id: targetTaskId,
      duration_days: days,
    };
    const today = new Date().toISOString().slice(0, 10);
    const startStr = snapToBusinessDay(source.start_date || today, 1);
    if (startStr !== source.start_date) data.start_date = startStr;
    if (days === 0) {
      data.is_milestone = true;
      data.end_date = startStr;
    } else if (days > 0) {
      if (source.is_milestone) data.is_milestone = false;
      data.end_date = addBusinessDays(startStr, days - 1);
    }
    console.log('[duration link] click-pick: linking task', sourceTaskId, '→ task', targetTaskId, '(', days, 'days )');
    api.update(sourceTaskId, data).then(() => loadTasks()).finally(cleanup);
  };
  const onPickKey = (e) => {
    if (e.key === 'Escape') cleanup();
  };
  document.addEventListener('mousedown', onPickMousedown, true);
  document.addEventListener('keydown', onPickKey);
}


function enterCellEdit(td, taskId, col) {
  if (td.querySelector('input, select')) return;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  const original = currentCellValue(task, col);
  const input = createEditInput(col, original, task);
  td.classList.add('editing');
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  if (typeof input.select === 'function') input.select();

  let done = false;
  // v4.25: same click-outside dismissal as enterPillEdit — blur misses
  // clicks on non-focusable SVG Gantt elements, so we attach an explicit
  // document-level mousedown listener that commits on any outside click.
  const onOutsideMousedown = (e) => {
    if (input.contains(e.target)) return;
    finalize(true);
  };
  const finalize = async (commit) => {
    if (done) return;
    done = true;
    document.removeEventListener('mousedown', onOutsideMousedown, true);
    if (commit && input.value !== original) {
      try { await saveCellEdit(taskId, col, input.value, task); }
      catch (err) { console.error(err); }
    }
    await loadTasks();
  };
  document.addEventListener('mousedown', onOutsideMousedown, true);

  // First printable keystroke after entering edit mode replaces the entire cell value
  // — so click-then-type overwrites without the user having to select-all first.
  // Date inputs are skipped (they have their own keyboard handling).
  let firstType = true;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finalize(true); return; }
    if (e.key === 'Escape') { e.preventDefault(); finalize(false); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      finalize(true).then(() => {
        // Move focus to next/prev cell of the SAME row in current column order.
        const order = state.layout.columnOrder.filter(k => state.layout.visibleCols.includes(k));
        const i = order.indexOf(col);
        const nextKey = order[i + (e.shiftKey ? -1 : 1)];
        if (!nextKey || nextKey === 'id') return;
        const nextRow = document.querySelector(`tr[data-id="${taskId}"]`);
        const nextTd = nextRow?.querySelector(`td[data-col="${nextKey}"]`);
        if (nextTd) enterCellEdit(nextTd, taskId, nextKey);
      });
      return;
    }
    // Single printable character (no modifier other than Shift), and we haven't typed
    // yet → wipe the existing value so the keystroke becomes the entire new content.
    const isPrintable = e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (firstType && isPrintable && input.type !== 'date') {
      input.value = '';
    }
    firstType = false;
  });
  input.addEventListener('blur', () => finalize(true));
}

function currentCellValue(task, col) {
  switch (col) {
    case 'name':     return task.name || '';
    case 'assignee': return task.assignee || '';
    case 'start':    return task.start_date || '';
    case 'finish':   return task.end_date || '';
    case 'duration': {
      // v4.37: pre-fill the editor with "=N" when the task is linked,
      // so the user can see + edit the link target directly. Re-saving
      // "=N" with the same N is a no-op; replacing with a duration like
      // "2w" unlinks.
      if (task.duration_link_task_id) {
        const line = lineByTaskId[task.duration_link_task_id];
        if (line) return `=${line}`;
      }
      return durationLabel(task);
    }
    case 'pred':     return predDisplay(task.predecessors || '');
    case 'progress': return String(task.progress || 0);
    case 'allocation': return String(task.allocation == null ? 90 : task.allocation);
    case 'priority': return String(task.priority == null ? 1 : task.priority);
    case 'notes':    return task.notes || '';
  }
  return '';
}

function createEditInput(col, value, task) {
  if (col === 'assignee') {
    // Constrained to active team members in the disciplines that plausibly own
    // this task. CONTROLS ENGINEERING task → only controls engineers. BUILD task
    // → only builders. Ambiguous buckets (General Engineering, Section 40/50
    // dept-level) widen to every relevant discipline. Cross-discipline
    // assignment isn't offered here — use the Resources view if you really need
    // to assign across boundaries.
    //
    // One nuance: if the task is ALREADY assigned to someone from a discipline
    // outside the filter, we expand the filter just enough to include them so
    // they don't disappear from the dropdown when the user opens it.
    const sel = document.createElement('select');
    sel.className = 'cell-edit-input';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— unassigned —';
    sel.appendChild(blank);
    const relevant = new Set(relevantDisciplinesForTask(task));
    const currentMember = value ? state.team.find(m => m.name === value && m.active !== 0) : null;
    if (currentMember) relevant.add(currentMember.discipline);
    const seen = new Set();
    for (const disc of DISCIPLINES) {
      if (!relevant.has(disc.key)) continue;
      const members = state.team.filter(m => m.discipline === disc.key && m.active !== 0);
      if (members.length === 0) continue;
      const og = document.createElement('optgroup');
      og.label = disc.label;
      for (const m of members) {
        const o = document.createElement('option');
        o.value = m.name;
        o.textContent = m.name;
        og.appendChild(o);
        seen.add(m.name);
      }
      sel.appendChild(og);
    }
    // Legacy assignees that aren't on the team list at all — show them so old
    // data is still editable, but flag the row clearly.
    if (value && !seen.has(value)) {
      const og = document.createElement('optgroup');
      og.label = 'Not on team';
      const o = document.createElement('option');
      o.value = value;
      o.textContent = `${value} (not on team)`;
      og.appendChild(o);
      sel.appendChild(og);
    }
    sel.value = value || '';
    return sel;
  }
  const input = document.createElement('input');
  input.className = 'cell-edit-input';
  if (col === 'start' || col === 'finish') {
    input.type = 'date';
  } else if (col === 'progress' || col === 'allocation' || col === 'priority') {
    // type="text" with inputmode=numeric — looks like a plain text field (no spinner
    // arrows ever, in any browser) but mobile keyboards still pop the number pad.
    // Validation happens in saveCellEdit.
    input.type = 'text';
    input.inputMode = 'numeric';
  } else {
    input.type = 'text';
  }
  input.value = value;
  return input;
}

async function saveCellEdit(id, col, value, task) {
  const data = {};
  switch (col) {
    case 'name':     data.name = (value || '').trim(); break;
    case 'assignee': data.assignee = (value || '').trim() || null; break;
    case 'start': {
      // Snap to a business day — we don't work weekends, so a Saturday start always
      // means the user wants Monday. Duration NEVER changes on a start edit; only the
      // finish shifts to honor whatever working-days the task already had.
      const snapped = value ? snapToBusinessDay(value, 1) : null;
      data.start_date = snapped;
      if (snapped && !task.is_milestone) {
        const dur = task.duration_days != null
          ? Number(task.duration_days)
          : businessDaysBetween(task.start_date, task.end_date);
        if (dur && dur > 0) {
          data.end_date = addBusinessDays(snapped, dur - 1);
        }
      } else if (task.is_milestone) {
        data.end_date = snapped; // milestones: start === end
      }
      break;
    }
    case 'finish': {
      // Editing the finish manually overrides duration — recompute it from the new
      // span so the duration column matches what the user just set.
      data.end_date = value || null;
      if (task.is_milestone) data.start_date = value || null;
      else if (value && task.start_date) {
        const newDur = businessDaysBetween(task.start_date, value);
        if (newDur != null && newDur > 0) data.duration_days = newDur;
      }
      break;
    }
    case 'duration': {
      // v4.41: "=N" LINKS this task's duration to the row on line N.
      // Regex is permissive — accepts "=24", "=24w", "= 24", "=24 some text",
      // anything starting with "=" followed by digits. We extract the
      // digits and look up the line. If the line isn't found, log a
      // warning and bail (saves nothing — leaves the task untouched).
      // Typing a duration WITHOUT a leading "=" clears the link.
      const trimmed = String(value || '').trim();
      if (trimmed.startsWith('=')) {
        const digitsMatch = trimmed.slice(1).match(/(\d+)/);
        if (!digitsMatch) {
          console.warn('[duration link] expected digits after "=", got:', trimmed);
          break;
        }
        const targetLine = Number(digitsMatch[1]);
        const targetTaskId = taskIdByLine[targetLine];
        if (!targetTaskId) {
          console.warn('[duration link] no task at line', targetLine, '(lineByTaskId keys:', Object.keys(taskIdByLine).slice(0, 10), '...)');
          break;
        }
        if (targetTaskId === id) {
          console.warn('[duration link] self-link ignored — task can\'t link to itself');
          break;
        }
        const sourceTask = state.tasks.find(t => t.id === targetTaskId);
        if (!sourceTask) {
          console.warn('[duration link] source task id', targetTaskId, 'not found in state.tasks');
          break;
        }
        const days = Number(sourceTask.duration_days) || 0;
        data.duration_link_task_id = targetTaskId;
        data.duration_days = days;
        const today = new Date().toISOString().slice(0, 10);
        let startStr = snapToBusinessDay(task.start_date || today, 1);
        if (startStr !== task.start_date) data.start_date = startStr;
        if (days === 0) {
          data.is_milestone = true;
          data.end_date = startStr;
        } else if (days > 0) {
          if (task.is_milestone) data.is_milestone = false;
          data.end_date = addBusinessDays(startStr, days - 1);
        }
        console.log('[duration link] linking task', id, '→ task', targetTaskId, '(line', targetLine, ') duration', days, 'days');
        break;
      }
      // No "=" prefix: standard duration parsing + UNLINK any prior link.
      const days = parseDurationInput(trimmed); // business days
      if (days == null) break;
      data.duration_days = days;
      // Clear the link (idempotent — server treats null = "no link").
      data.duration_link_task_id = null;
      const today = new Date().toISOString().slice(0, 10);
      let startStr = snapToBusinessDay(task.start_date || today, 1);
      if (startStr !== task.start_date) data.start_date = startStr;
      if (days === 0) {
        data.is_milestone = true;
        data.end_date = startStr;
      } else if (days > 0) {
        if (task.is_milestone) data.is_milestone = false;
        // N business days INCLUSIVE → end = start + (N-1) business days.
        data.end_date = addBusinessDays(startStr, days - 1);
      }
      break;
    }
    case 'pred':     data.predecessors = predParse((value || '').trim()) || null; break;
    case 'progress':   data.progress   = Math.max(0, Math.min(100, Number(value) || 0)); break;
    case 'allocation': data.allocation = Math.max(0, Math.min(100, Number(value) || 0)); break;
    case 'priority':   data.priority   = Math.max(1, Math.min(99, Number(value) || 1)); break;
    case 'notes':      data.notes      = (value || '').trim() || null; break;
  }
  if (Object.keys(data).length > 0) {
    // Snapshot the task BEFORE the change so the toolbar Undo button can roll
    // it back. We snapshot just the fields we know we might write, so undo
    // restores precisely what the edit changed — not unrelated columns.
    pushUndoSnapshot(task, Object.keys(data), `Edit ${col} on "${task.name || 'task'}"`);
    await api.update(id, data);
  }
}

// ---------- Undo ----------
// Simple undo stack — records the BEFORE-state of any task field the user
// edits via the grid (cell edits, pill edits) or the lag editor on the Gantt
// arrows. Click the Undo button in the toolbar to pop the top entry and
// restore that task's snapshot.
// Stack is capped at 20 entries; older edits drop off the bottom.
const UNDO_STACK_MAX = 20;
function pushUndoSnapshot(task, fields, description) {
  if (!task || !Array.isArray(fields) || fields.length === 0) return;
  // Capture only the fields we're about to overwrite — keeps undo precise.
  const before = {};
  for (const f of fields) {
    // Map saveCellEdit's `col` keys to actual task fields.
    const mapped = ({
      'name': 'name',
      'start_date': 'start_date',
      'end_date': 'end_date',
      'duration_days': 'duration_days',
      'progress': 'progress',
      'allocation': 'allocation',
      'priority': 'priority',
      'predecessors': 'predecessors',
      'assignee': 'assignee',
      'notes': 'notes',
    })[f] || f;
    if (mapped in task) before[mapped] = task[mapped];
  }
  if (Object.keys(before).length === 0) return;
  state.undoStack.push({ taskId: task.id, before, description });
  while (state.undoStack.length > UNDO_STACK_MAX) state.undoStack.shift();
  // A new edit invalidates the redo history — otherwise redo would re-apply
  // a "future" state that conflicts with what the user just did.
  state.redoStack = [];
  syncUndoButton();
  syncRedoButton();
}

async function performUndo() {
  const entry = state.undoStack.pop();
  if (!entry) { syncUndoButton(); return; }
  // Capture current state of the changed fields BEFORE we revert so redo can
  // re-apply them. Look up the task fresh from state.tasks (entry only holds
  // taskId + the original `before` snapshot, not the post-edit values).
  const task = state.tasks.find(t => t.id === entry.taskId);
  if (task) {
    const after = {};
    for (const f of Object.keys(entry.before)) {
      if (f in task) after[f] = task[f];
    }
    if (Object.keys(after).length > 0) {
      state.redoStack.push({ taskId: entry.taskId, before: after, description: entry.description });
      while (state.redoStack.length > UNDO_STACK_MAX) state.redoStack.shift();
    }
  }
  try {
    await api.update(entry.taskId, entry.before);
    await loadTasks();
  } catch (err) {
    console.error('undo failed', err);
  }
  syncUndoButton();
  syncRedoButton();
}

async function performRedo() {
  const entry = state.redoStack.pop();
  if (!entry) { syncRedoButton(); return; }
  // Capture current state as a new undo entry, then apply the redo snapshot.
  const task = state.tasks.find(t => t.id === entry.taskId);
  if (task) {
    const before = {};
    for (const f of Object.keys(entry.before)) {
      if (f in task) before[f] = task[f];
    }
    if (Object.keys(before).length > 0) {
      state.undoStack.push({ taskId: entry.taskId, before, description: entry.description });
      while (state.undoStack.length > UNDO_STACK_MAX) state.undoStack.shift();
    }
  }
  try {
    await api.update(entry.taskId, entry.before);
    await loadTasks();
  } catch (err) {
    console.error('redo failed', err);
  }
  syncUndoButton();
  syncRedoButton();
}

function syncUndoButton() {
  const btn = document.getElementById('btn-undo');
  if (!btn) return;
  const stack = state.undoStack || [];
  const last = stack[stack.length - 1];
  btn.disabled = !last;
  if (last) {
    btn.title = `Undo: ${last.description}\n(${stack.length} change${stack.length === 1 ? '' : 's'} in history)`;
  } else {
    btn.title = 'Nothing to undo — no edits in this session yet.';
  }
}

function syncRedoButton() {
  const btn = document.getElementById('btn-redo');
  if (!btn) return;
  const stack = state.redoStack || [];
  const last = stack[stack.length - 1];
  btn.disabled = !last;
  if (last) {
    btn.title = `Redo: ${last.description}\n(${stack.length} change${stack.length === 1 ? '' : 's'} ready to re-apply)`;
  } else {
    btn.title = 'Nothing to redo — undo something first.';
  }
}

function parseDurationInput(s) {
  s = String(s || '').trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([wd])?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] || 'd';
  // Duration is in BUSINESS days. "1w" = 5 business days (Mon–Fri), "3d" = 3.
  return Math.round(unit === 'w' ? n * 5 : n);
}

// ---------- Column reorder (drag-and-drop) ----------
function setupColumnReorder() {
  const ths = document.querySelectorAll('#tasks-table thead th[data-col]');
  ths.forEach(th => {
    th.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', th.dataset.col);
      e.dataTransfer.effectAllowed = 'move';
      th.classList.add('dragging');
    });
    th.addEventListener('dragend', () => th.classList.remove('dragging'));
    th.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      th.classList.add('drag-over');
    });
    th.addEventListener('dragleave', () => th.classList.remove('drag-over'));
    th.addEventListener('drop', (e) => {
      e.preventDefault();
      th.classList.remove('drag-over');
      const fromKey = e.dataTransfer.getData('text/plain');
      const toKey = th.dataset.col;
      if (!fromKey || fromKey === toKey) return;
      const order = [...state.layout.columnOrder];
      const fromIdx = order.indexOf(fromKey);
      if (fromIdx === -1) return;
      order.splice(fromIdx, 1);
      const toIdx = order.indexOf(toKey);
      order.splice(toIdx === -1 ? order.length : toIdx, 0, fromKey);
      state.layout.columnOrder = order;
      saveLayout();
      renderHeaders();
      renderTable();
    });
  });
}

// ---------- Gantt rendering ----------
// Muted hierarchy palette — drives BOTH the Gantt bar colors and the grid header pill
// colors. Keyed by rowColorKey() / data-color-key. Each entry has a fill (background)
// and a text/stroke shade. Defaults are configurable on Setup → Hierarchy Colors.
const HIERARCHY_COLOR_DEFAULTS = {
  // Sub-department-level (only section 10 has sub-departments).
  mech:           { label: 'Mechanical Engineering', fill: '#cfdcef', text: '#1e3a8a' },
  controls:       { label: 'Controls Engineering',   fill: '#cfe6d2', text: '#14532d' },
  general:        { label: 'General Engineering',    fill: '#ddd0eb', text: '#581c87' },
  build:          { label: 'Build',                  fill: '#f1d4ad', text: '#7c2d12' },
  wire:           { label: 'Wire',                   fill: '#fef08a', text: '#713f12' }, // clear yellow
  // Department-level (used directly in sections 40 / 50, and as the section-10 dept-row color).
  'eng-combined': { label: 'Engineering (combined)', fill: '#b6e5dc', text: '#134e4a' },
  'shop-combined':{ label: 'Shop (combined)',        fill: '#fbc97a', text: '#78350f' }, // distinct amber, not orange-pink
  procurement:    { label: 'Procurement',            fill: '#d6dde6', text: '#334155' },
};
const HIERARCHY_KEYS = Object.keys(HIERARCHY_COLOR_DEFAULTS);

// Live store — populated from settings on load. Read by injectPhaseStyles + the grid CSS
// (via custom properties). The keys never change; only fill/text per key are editable.
let HIERARCHY_BAR_COLORS = { ...HIERARCHY_COLOR_DEFAULTS };

function injectPhaseStyles() {
  const id = 'phase-bar-styles';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  // Phase-based bar colors (legacy / fallback for tasks without a hierarchy match).
  // Progress fill is the bar's text/stroke color at 0.4 opacity — solid but not
  // bold. The hierarchy/phase color always reflects WHAT the task is; the
  // darker progress portion reflects HOW MUCH is done.
  const phaseRules = PHASES.map(p =>
    `.gantt .bar-wrapper.phase-${p.key} .bar { fill: ${p.color}; stroke: ${p.text}; stroke-width: 1; }
     .gantt .bar-wrapper.phase-${p.key} .bar-progress { fill: ${p.text}; opacity: 0.4; }
     .gantt .bar-wrapper.phase-${p.key} .bar-label { fill: ${p.text}; font-weight: 600; }`
  ).join('\n');

  // Hierarchy-based bar colors — listed AFTER phase rules so they win on equal specificity.
  // Tasks pick the deepest match (sub-dept > combined dept > procurement).
  const hierarchyRules = Object.entries(HIERARCHY_BAR_COLORS).map(([key, c]) =>
    `.gantt .bar-wrapper.bar-color-${key} .bar { fill: ${c.fill}; stroke: ${c.text}; stroke-width: 1; }
     .gantt .bar-wrapper.bar-color-${key} .bar-progress { fill: ${c.text}; opacity: 0.4; }
     .gantt .bar-wrapper.bar-color-${key} .bar-label { fill: ${c.text}; font-weight: 600; }`
  ).join('\n');

  // Over-allocated overrides — listed before critical so the critical-path outline
  // wins when both apply (so a critical+over-allocated task still reads as on the
  // critical path).
  const overAlloc = `
    .gantt .bar-wrapper.over-allocated .bar { fill: #fee2e2; stroke: #dc2626; stroke-width: 2; }
    .gantt .bar-wrapper.over-allocated .bar-progress { fill: #dc2626; opacity: 0.45; }
    .gantt .bar-wrapper.over-allocated .bar-label { fill: #b91c1c; font-weight: 800; }
  `;

  // Critical path — bars and milestone diamonds on the binding chain from Receipt
  // of PO to FAT get a BOLD red outline (3.5px). The fill stays whatever the
  // hierarchy / phase rules computed, so existing color coding is preserved
  // underneath. Anchor diamonds bump even thicker so they really stand out.
  const critical = `
    .gantt .bar-wrapper.on-critical .bar { stroke: #b91c1c; stroke-width: 3.5; }
    .gantt .bar-wrapper.on-critical .milestone-diamond.anchor-inner { stroke: #b91c1c; stroke-width: 3; }
    .gantt .bar-wrapper.on-critical .milestone-diamond { stroke: #b91c1c; stroke-width: 2.5; }
  `;

  // 100% complete DURATION bars get a lime green border — preserves the
  // hierarchy color underneath (so a finished Build task still reads as
  // "Build") but adds an unmistakable visual cue that it's done. Lime matches
  // the anchor-color palette so the "done" visual language is consistent
  // across tasks and anchors. Critical-path red border still wins (it's
  // declared after and uses the same selector specificity).
  const doneRule = `
    .gantt .bar-wrapper.is-done .bar { stroke: #befa4f !important; stroke-width: 2.5 !important; }
  `;

  el.textContent = phaseRules + '\n' + hierarchyRules + '\n' + doneRule + '\n' + overAlloc + '\n' + critical;
}

function renderGanttLegend() {
  // v4.38: legend element removed from the DOM. Function kept as a no-op
  // so existing call sites (renderGantt + a few others) don't need to be
  // touched. If the legend ever needs to come back, restoring the markup
  // in index.html is enough.
  const legend = document.getElementById('gantt-legend');
  if (!legend) return;
  const present = new Set(state.tasks.map(t => t.phase).filter(Boolean));
  const items = PHASES.filter(p => present.has(p.key));
  legend.innerHTML = items.map(p => `
    <span class="legend-item">
      <span class="legend-swatch" style="background:${p.color};border:1px solid ${p.text}"></span>
      ${escapeHtml(p.label)}
    </span>`).join('');
}

// True when a task lives inside a collapsed section / department / sub-department —
// any ancestor on its hierarchy path being collapsed counts. Used by renderGantt to
// hide bars whose grid row is currently hidden behind a collapsed group, so
// collapsing a section in the grid also tucks its bars away on the Gantt.
function isTaskInCollapsedGroup(task) {
  if (!task) return false;
  // Spine-floater anchors (no phase_group) collapse with the section they render
  // adjacent to:
  //   - FAT closes section 40 → hides when MACHINE TESTING is collapsed.
  //   - Ship Machine sits inside section 50 → hides when TEARDOWN & INSTALL collapses.
  //   - Receipt of PO is at the very top, above any section — always visible.
  // Machine Power-Up has a phase_group (10 → Shop → Wire) so it follows the normal
  // collapse rules at the bottom of this function.
  const anchor = inferredAnchorKey(task);
  if (anchor === 'fat') {
    return collapsedGroups.has(groupPath('machine_testing'));
  }
  if (anchor === 'ship_machine') {
    return collapsedGroups.has(groupPath('teardown_install'));
  }
  if (anchor && !task.phase_group) return false;
  if (!task.phase_group) return false;
  const paths = [
    groupPath(task.phase_group),
    task.department    ? groupPath(task.phase_group, task.department) : null,
    task.sub_department ? groupPath(task.phase_group, task.department, task.sub_department) : null,
  ].filter(Boolean);
  return paths.some(p => collapsedGroups.has(p));
}

function renderGantt() {
  const container = document.getElementById('gantt-container');
  const empty = document.getElementById('gantt-empty');
  // Same task ordering as the grid so rows align side-by-side. Tasks inside a
  // collapsed group are dropped here so the Gantt mirrors the grid's visibility.
  // Tasks that don't belong to any current section (and aren't anchors) are also
  // dropped — those are leftovers from old data structures that the grid hides;
  // the Gantt should hide them too so no ghost bars appear.
  const validSectionKeys = new Set(HIERARCHY.map(g => g.key));
  // v4.50: when NOT in sortByStart mode, use the GRID's canonical order
  // (buildCanonicalTaskOrder) so the Gantt bars sort the same way the
  // grid rows do — Receipt of PO at top, Backlog under it, section 10
  // bucket walk, FAT closing section 40, Ship Machine inside section 50.
  // The previous sortByPhaseThenOrder ranked anchors / orphans by their
  // `phase` field, which has anchors phase=null → rank 99 → bottom of
  // chart. That's why FAT appeared above PO and Ship above Power-Up in
  // Gantt-only view.
  // buildCanonicalTaskOrder() ALREADY applies filters internally, so we
  // don't call applyFilters again.
  let ordered;
  if (state.scheduleView?.sortByStart) {
    ordered = [...applyFilters(state.tasks)].sort((a, b) =>
      (a.start_date || '￿').localeCompare(b.start_date || '￿')
      || (a.sort_order || 0) - (b.sort_order || 0));
  } else {
    const canonicalIds = buildCanonicalTaskOrder();
    const byId = Object.fromEntries(state.tasks.map(t => [t.id, t]));
    ordered = canonicalIds.map(id => byId[id]).filter(Boolean);
  }
  // Same Only-critical filter renderTable applies, mirrored here so the Gantt only
  // shows the critical bars + anchor markers when the toggle is on.
  const onlyCrit = state.scheduleView?.criticalOnly && state.scheduleView?.criticalPath;
  const critForFilter = onlyCrit ? computeCriticalPath() : null;
  // v4.47: mirror the Schedule/Combined/Actions filter from renderTable —
  // the Gantt must always show the SAME row set as the grid. Without this
  // filter, the Gantt drew every task regardless of actionsMode, so "Actions
  // only" in the grid still showed scheduled bars on the chart.
  const am = state.scheduleView?.actionsMode || 'schedule';
  const filtered = ordered
    .filter(t => t.start_date && t.end_date)
    .filter(t => !isTaskInCollapsedGroup(t))
    .filter(t => inferredAnchorKey(t) || isBacklogTask(t) || (t.phase_group && validSectionKeys.has(t.phase_group)))
    .filter(t => !critForFilter || critForFilter.has(String(t.id)) || inferredAnchorKey(t))
    .filter(t => {
      // Anchors always render. Otherwise honor the actionsMode toggle:
      //   schedule → drop is_action tasks
      //   actions  → drop non-action tasks
      //   combined → keep both
      if (inferredAnchorKey(t)) return true;
      if (am === 'schedule') return !t.is_action;
      if (am === 'actions')  return !!t.is_action;
      return true; // combined
    });

  renderGanttLegend();

  if (filtered.length === 0) {
    container.innerHTML = '';
    empty && empty.classList.remove('hidden');
    state.gantt = null;
    return;
  }
  empty && empty.classList.add('hidden');
  injectPhaseStyles();

  // Critical-path mode: compute the binding-predecessor chain so we can tag those
  // bars + their drawn arrows with the on-critical class. Empty set when off.
  const criticalIds = state.scheduleView?.criticalPath ? computeCriticalPath() : new Set();
  state._criticalIds = criticalIds;

  const ganttTasks = filtered.map(t => {
    const classes = [];
    if (t.phase) classes.push(`phase-${t.phase}`);
    // Hierarchy color (sub-department / combined-department) — overrides the phase color.
    const colorKey = rowColorKey(t);
    if (colorKey) classes.push(`bar-color-${colorKey}`);
    if (t.is_milestone) classes.push('is-milestone');
    if (isBacklogTask(t)) {
      classes.push('is-backlog');
      // v4.84: backlog with end_date in the past gets is-backlog-expired so
      // the bar picks up the lime-green border styling. No checkbox; just a
      // visual signal that the calendar time has elapsed.
      const todayMs = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
      if (t.end_date && new Date(t.end_date).getTime() < todayMs) {
        classes.push('is-backlog-expired');
      }
    }
    // Milestones at 100%: still tagged milestone-done — drawMilestoneDiamonds
    // uses it to paint the ✓ overlay glyph. As of v4.4 milestones keep their
    // normal fill color (lime for anchors, slate for non-anchors) when done;
    // only the ✓ overlay differs. Done is the EXTRA — color is consistent.
    if (t.is_milestone && (t.progress || 0) >= 100) classes.push('milestone-done');
    // 100% complete DURATION task: tag .is-done. CSS adds a LIME BORDER around
    // the bar — preserves the hierarchy color underneath (Build task stays
    // Build-tan when done, etc.) and the lime stroke makes "complete" pop
    // visually without recoloring the bar.
    if (!t.is_milestone && !isBacklogTask(t) && (t.progress || 0) >= 100) classes.push('is-done');
    if (state.overAllocatedTaskIds.has(t.id)) classes.push('over-allocated');
    if (criticalIds.has(String(t.id))) classes.push('on-critical');
    return {
      id: String(t.id),
      name: t.name,
      start: t.start_date,
      end: t.end_date,
      progress: t.progress || 0,
      dependencies: '', // custom arrows below
      custom_class: classes.join(' '),
    };
  });

  // Invisible phantom tasks 6 months before the earliest task and 6 months after
  // the latest. Symmetric padding lets the user scroll equally past either edge —
  // previously the pre-task pad was 30 days, which meant on a project starting in
  // May you couldn't scroll back to April. 6 months is enough to comfortably
  // bring any edge bar into the center of the viewport.
  const minStart = Math.min(...filtered.map(t => new Date(t.start_date).getTime()));
  const maxEnd   = Math.max(...filtered.map(t => new Date(t.end_date).getTime()));
  const PAD_MS = 183 * 86400000; // ~6 months
  const padBefore = new Date(minStart - PAD_MS).toISOString().slice(0, 10);
  const padAfter  = new Date(maxEnd   + PAD_MS).toISOString().slice(0, 10);
  ganttTasks.unshift({ id: '_pad_before', name: '', start: padBefore, end: padBefore, progress: 0, dependencies: '', custom_class: 'phantom-pad' });
  ganttTasks.push   ({ id: '_pad_after',  name: '', start: padAfter,  end: padAfter,  progress: 0, dependencies: '', custom_class: 'phantom-pad' });

  // Auto fit-to-viewport whenever this is the first render OR the active project just
  // changed. Manual wheel/zoom adjustments stick — we only re-fit on a real navigation.
  const projectKey = state.filters.project || '_all_';
  const fitNow = state._fitOnNextRender === true || state._lastFitProject !== projectKey;
  if (fitNow) {
    const visiblePanel = document.getElementById('schedule-gantt');
    const target = Math.max(300, (visiblePanel ? visiblePanel.clientWidth : 0) - 24);
    const projectDays = Math.max(1, (maxEnd - minStart) / 86400000 + 1);
    const PAD_DAYS = 14;
    if (target > 0) {
      const requiredPxPerDay = target / (projectDays + PAD_DAYS);
      state.zoomPercent = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (requiredPxPerDay / 20) * 100));
    }
    state._lastFitProject = projectKey;
    state._fitOnNextRender = false;
  }

  const { mode, cw } = getZoomConfig(state.zoomPercent);
  state.viewMode = mode;
  const oldScroller = document.querySelector('#gantt-container .gantt-container');
  const scrollLeft = oldScroller ? oldScroller.scrollLeft : 0;
  container.innerHTML = '';
  const { bar_height, padding } = getGanttBarMetrics();
  state.gantt = new Gantt(container, ganttTasks, {
    view_mode: mode,
    column_width: cw,
    _cwOverride: cw,
    bar_height,
    padding,
    header_height: 38,
    on_click: (task) => {
      const tr = document.querySelector(`tr[data-id="${task.id}"]`);
      if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
    on_date_change: (task, start, end) => {
      const startStr = start.toISOString().slice(0, 10);
      const endStr = end.toISOString().slice(0, 10);
      api.update(Number(task.id), { start_date: startStr, end_date: endStr }).then(() => loadTasks());
    },
    on_progress_change: (task, progress) => {
      api.update(Number(task.id), { progress: Math.round(progress) }).then(() => loadTasks());
    },
  });
  const newScroller = document.querySelector('#gantt-container .gantt-container');
  if (newScroller) {
    if (oldScroller) {
      newScroller.scrollLeft = scrollLeft;
    } else {
      // First render: skip past the leading phantom-pad so we land on the earliest real task.
      const earliest = filtered.reduce((min, t) =>
        new Date(t.start_date).getTime() < new Date(min.start_date).getTime() ? t : min);
      const wrap = document.querySelector(`#gantt-container .bar-wrapper[data-id="${earliest.id}"]`);
      const bar = wrap && wrap.querySelector('.bar');
      if (bar) newScroller.scrollLeft = Math.max(0, +bar.getAttribute('x') - 24);
    }
  }

  // Keep the topbar zoom-mode picker in sync with whatever mode the current zoom maps to.
  const zoomModeEl = document.getElementById('zoom-mode');
  if (zoomModeEl && zoomModeEl.value !== mode) zoomModeEl.value = mode;

  cleanGanttHeaders();
  // alignGanttToGrid relies on the grid's row offsetTops to position bars row-by-row.
  // In Gantt-only mode the grid is hidden (display:none) so its offsets are zero —
  // skip alignment and let frappe-gantt's natural layout drive bar positions.
  if (!state.scheduleView?.ganttOnly) alignGanttToGrid();
  // Arrows render FIRST (behind everything) — bars and labels cover them visually.
  drawCustomArrows();
  drawBaselineGhosts();
  drawTodayLine();
  drawMilestoneDiamonds();
  drawMilestoneLabels();
  clipBarLabels();
  drawScheduleStatus();
  drawFinancialOverlay();
  drawBarMeta();
  renderProjectStatsPopup();
}

// Per-bar allocation + duration labels on the Gantt. Renders ONE compact label
// per task bar — combining allocation % and duration (in weeks) — placed
// BELOW the bar by default, but flipped ABOVE when an arrow passes through
// the below-bar gap (otherwise the label sits right on top of the arrow line
// and you can't read it).
//
// Format: "50% · 3w"  (middle-dot separator; either side is omitted when
// that value is 0 or missing).
//
// Placement priority:
//   1. Below the bar — preferred, sits in its own row's below-gap so
//      adjacent rows never collide.
//   2. Above the bar — fallback when an arrow would cross the below position.
//   3. Skip — last resort, when both above and below would collide with
//      arrows (rare; only happens when the bar has an arrow entering its top
//      AND an arrow exiting its bottom).
//
// Skipped for milestones, anchors, and backlog. Runs AFTER drawCustomArrows
// so the arrow <path> elements exist in the DOM and we can query their bboxes
// for collision detection.
function drawBarMeta() {
  const svg = document.querySelector('#gantt-container .gantt');
  if (!svg) return;
  // Tear down any prior labels so toggling off cleanly removes them.
  svg.querySelectorAll('.sdc-bar-meta').forEach(el => el.remove());
  // v4.75 BUGFIX: only reset visibility/opacity on NON-MILESTONE bar-labels.
  // drawMilestoneDiamonds sets opacity=0 on milestone bar-labels because
  // drawMilestoneLabels renders its own text — so undoing that here was
  // causing milestone names to render TWICE (one from frappe-gantt, one
  // from drawMilestoneLabels) when the % toggle was on.
  //
  // v4.79: also reset style.textAnchor so the "shifted right" state from a
  // previous render doesn't accumulate. clipBarLabels positions the label
  // via setAttribute, which won't override an inline style.textAnchor.
  svg.querySelectorAll('.bar-wrapper:not(.is-milestone) .bar-label').forEach(el => {
    el.style.opacity = '';
    el.style.visibility = '';
    el.style.textAnchor = '';
    el.style.transform = '';
    el.style.fill = '';
  });
  if (state.scheduleView?.showBarMeta !== true) return;

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'sdc-bar-meta');
  group.style.pointerEvents = 'none';
  svg.appendChild(group);

  // Parse each arrow line into axis-aligned segments and collision-check
  // labels against the SEGMENTS, not the path's bounding box. Why: an L-shape
  // arrow's getBBox() encloses both legs PLUS the L's empty corner area, which
  // wrongly marks most bars sitting INSIDE that corner zone as colliding even
  // though the arrow line is on the edges only (v3.56 had this issue — 2/3 of
  // labels ended up suppressed because every bar near a long L-shape looked
  // "occupied"). Per-segment intersection is exact for axis-aligned arrows
  // (all our arrow segments are pure horizontal or vertical by construction
  // in computeArrowPath).
  const arrowSegments = [];
  svg.querySelectorAll('.sdc-arrows path.arrow').forEach(p => {
    const d = p.getAttribute('d');
    if (!d || /Z/i.test(d)) return;  // skip arrowhead triangles (closed with Z)
    const nums = d.match(/-?\d+(\.\d+)?/g);
    if (!nums || nums.length < 4) return;
    // Path is "M x y L x y [L x y]" — pair consecutive points to form segments.
    for (let i = 0; i + 3 < nums.length; i += 2) {
      arrowSegments.push({
        x1: +nums[i],   y1: +nums[i+1],
        x2: +nums[i+2], y2: +nums[i+3],
      });
    }
  });
  // Rect-vs-segment intersection. Each segment is axis-aligned, so its bbox
  // is the segment itself; bbox-overlap therefore exactly equals "the
  // segment passes through the rect". A small pad (2px) is added around the
  // rect so labels don't sit flush against an arrow line.
  const overlapsArrow = (rect, pad = 2) => {
    const rx1 = rect.x - pad, rx2 = rect.x + rect.w + pad;
    const ry1 = rect.y - pad, ry2 = rect.y + rect.h + pad;
    return arrowSegments.some(s => {
      const sx1 = Math.min(s.x1, s.x2), sx2 = Math.max(s.x1, s.x2);
      const sy1 = Math.min(s.y1, s.y2), sy2 = Math.max(s.y1, s.y2);
      return !(sx2 < rx1 || sx1 > rx2 || sy2 < ry1 || sy1 > ry2);
    });
  };

  const LABEL_H = 11;  // 9px font + small descent / breathing room
  const GAP     = 2;   // bar → label vertical offset

  for (const task of state.tasks) {
    if (task.is_milestone) continue;
    if (inferredAnchorKey(task)) continue;
    if (isBacklogTask(task)) continue;
    if (!task.start_date || !task.end_date) continue;

    const wrap = svg.querySelector(`.bar-wrapper[data-id="${task.id}"]`);
    if (!wrap) continue;
    const bar = wrap.querySelector('.bar');
    if (!bar) continue;

    const barX = +bar.getAttribute('x');
    const barY = +bar.getAttribute('y');
    const barW = +bar.getAttribute('width');
    const barH = +bar.getAttribute('height');
    const cx = barX + barW / 2;

    const alloc = Math.max(0, Math.min(100, Number(task.allocation == null ? 90 : task.allocation)));
    const durDays = Number(task.duration_days) || 0;
    const wks = Math.round(durDays / 5);

    // v4.58: SINGLE COMBINED LABEL — "85% · 8w" — feels like one pill.
    // Placement priority changed to match user feedback:
    //   1. INSIDE the bar at the right end (halo so it reads on any color).
    //   2. JUST OUTSIDE on the LEFT of the bar — preferred outside slot
    //      because frappe-gantt drops the bar's NAME outside-right when
    //      the bar is too narrow. Putting our label to the right would
    //      collide with the name; putting it to the left is clear.
    //   3. BELOW the bar at the right end (right-aligned).
    //   4. ABOVE the bar at the right end (right-aligned).
    // For OUTSIDE placements we draw a white "occluder" rect behind the
    // text so any arrow segment passing through the label visually
    // disappears under it. Reads cleanly even when an arrow enters the
    // bar from the left right where our left-label sits.
    const allocText = (alloc > 0) ? `${alloc}%` : '';
    const durText   = (wks > 0)   ? `${wks}w`   : '';
    if (!allocText && !durText) continue;
    const metaText = [allocText, durText].filter(Boolean).join(' · ');

    // v4.98 LAYOUT CASCADE — Step 2 uses CSS transform, plus per-step fill color.
    //
    //   Across v4.85-v4.93 the bug was the same: my width measurements for
    //   the SVG <text> elements were under-reporting compared to what the
    //   browser actually rendered. Every API I tried (getBBox,
    //   getComputedTextLength, getBoundingClientRect, canvas measureText
    //   with various fonts) returned widths smaller than reality. The
    //   overlap check then said "no overlap" when there obviously was one.
    //
    //   v4.94 stops predicting where the name will land. By the time this
    //   function runs, clipBarLabels has already positioned the bar-label
    //   and the browser has laid it out. So we READ the bar-label's actual
    //   rendered rect via getBoundingClientRect (reliable for already-
    //   placed-and-laid-out elements) and compare it to the bar's rect.
    //   The gap between the bar's left edge and the rendered name's left
    //   edge IS the available space for the meta.
    //
    //   Algorithm:
    //     1. Read barLabel.getBoundingClientRect() → real name position.
    //     2. Compute meta width via canvas measureText + small safety pad.
    //     3. If (nameLeft - barLeft) ≥ metaW + INSIDE_PADDING + INSIDE_GAP,
    //        Step 1 works: place meta inside-left, name stays put.
    //     4. Else if (barW - metaW) is large enough to center name between
    //        meta-right and bar-right with ≥INSIDE_GAP each side, Step 2:
    //        place meta inside-left, RE-position name centered in available.
    //     5. Else if name fits centered in full bar with ≥INSIDE_GAP each
    //        side, Step 3: meta outside, name centered in bar.
    //     6. Else Step 4: both outside.
    const INSIDE_PADDING = 3;
    const INSIDE_GAP     = 3;
    const OUTSIDE_GAP    = 3;
    const PILL_PAD       = 2;
    // text right edge = barX - SAME_ROW_GAP, pill right edge = barX - OUTSIDE_GAP.
    const SAME_ROW_GAP   = OUTSIDE_GAP + PILL_PAD;

    const barLabel = wrap.querySelector('.bar-label');
    if (!barLabel) continue;

    // Force a known font on the meta SO IT MATCHES what canvas measures.
    // Via inline style so it beats any CSS rule (frappe-gantt's stylesheet
    // sets font-family on .gantt text — would override a presentation
    // attribute).
    const metaEl = document.createElementNS(SVG_NS, 'text');
    metaEl.setAttribute('class', 'sdc-bar-meta');
    metaEl.setAttribute('x', String(barX + INSIDE_PADDING));
    metaEl.setAttribute('y', String(barY + barH / 2));
    metaEl.setAttribute('text-anchor', 'start');
    metaEl.setAttribute('dominant-baseline', 'central');
    metaEl.setAttribute('fill', '#1e293b');
    metaEl.setAttribute('paint-order', 'stroke');
    metaEl.setAttribute('stroke', 'rgba(255,255,255,0.9)');
    metaEl.setAttribute('stroke-width', '2.5');
    metaEl.setAttribute('stroke-linejoin', 'round');
    metaEl.style.fontFamily = 'sans-serif';
    metaEl.style.fontSize   = '9px';
    metaEl.style.fontWeight = '700';
    metaEl.style.pointerEvents = 'none';
    metaEl.textContent = metaText;
    group.appendChild(metaEl);

    // Center name inside the bar — sets the bar-label to its natural
    // centered-in-bar position. Used for Step 1 (default) and Step 3.
    const centerNameInBar = () => {
      barLabel.setAttribute('x', String(barX + barW / 2));
      barLabel.setAttribute('text-anchor', 'middle');
      barLabel.style.textAnchor = '';
      barLabel.style.transform = '';  // Clear any prior Step-2 shift transform.
      barLabel.classList.remove('bar-label-outside');
    };

    // Move metaEl from inside-left to outside-left + swap halo for pill occluder.
    const moveMetaOutside = () => {
      metaEl.setAttribute('x', String(barX - SAME_ROW_GAP));
      metaEl.setAttribute('text-anchor', 'end');
      metaEl.removeAttribute('paint-order');
      metaEl.removeAttribute('stroke');
      metaEl.removeAttribute('stroke-width');
      metaEl.removeAttribute('stroke-linejoin');
      addPillOccluder(group, metaEl, PILL_PAD);
    };

    // Meta width — PER-CHARACTER estimate. v4.95's first-pass values were
    // about 20 % too generous (visible by the magenta debug tick sitting
    // well past the rendered meta's right edge), so v4.96 trims them
    // proportionally. The meta text is bounded — digits, "%", spaces, "·",
    // "w" — so a per-char table works better than any browser measurement
    // API. Deterministic, slightly conservative, safe from overlap.
    const metaCharW = (ch) => {
      if (/[0-9]/.test(ch)) return 5.5;   // digits 0–9 (was 7)
      if (ch === '%')        return 6.5;   // percent sign (was 8)
      if (ch === ' ')        return 2.5;   // space (was 3)
      if (ch === '·')        return 3;     // middle dot (was 4)
      if (ch === 'w')        return 6.5;   // weeks marker (was 8)
      return 5.5;                          // any other char (was 7)
    };
    let metaTextW = 0;
    for (const ch of metaText) metaTextW += metaCharW(ch);
    // + 3 px = stroke halo (~2.5 px) + tiny safety margin.
    const metaW = metaTextW + 3;

    // Center the bar-label as Step 1 would. clipBarLabels may have placed it
    // outside if the bar is narrower than nameW + PAD — force back to center
    // so we can read its real centered-in-bar position. The browser does a
    // layout pass when we read getBoundingClientRect below.
    centerNameInBar();

    // === READ THE NAME'S ACTUAL RENDERED POSITION ===
    // This is the key change from prior versions: we don't COMPUTE where the
    // name will be from a (potentially wrong) measured width — we READ where
    // the browser actually placed it. getBoundingClientRect on the already-
    // laid-out bar-label is reliable.
    const barRect   = bar.getBoundingClientRect();
    const nameRect  = barLabel.getBoundingClientRect();
    // Gap from bar's left edge to the rendered name's left edge — this is
    // the space available for the meta on the inside-left.
    const availLeftPx = nameRect.left - barRect.left;
    // Gap from the rendered name's right edge to bar's right edge — used
    // for Step 2 "does the name still fit if we re-center it?" check below.
    const availRightPx = barRect.right - nameRect.right;
    const nameWidthPx = nameRect.width;

    // === CASCADE — decide which step ===
    const step1Works = availLeftPx >= metaW + INSIDE_PADDING + INSIDE_GAP;
    const step2AvailableForName = barW - INSIDE_PADDING - metaW;
    const step2Works = step2AvailableForName >= nameWidthPx + 2 * INSIDE_GAP;
    const step3Works = barW >= nameWidthPx + 2 * INSIDE_GAP;

    let chosenStep;
    if (step1Works) {
      chosenStep = 1;
      // Name already centered (centerNameInBar above), meta at default
      // inside-left position. Nothing more to do.
    } else if (step2Works) {
      chosenStep = 2;
      // Meta stays inside-left. Re-center name between meta-right and bar-right.
      const metaInsideRight = barX + INSIDE_PADDING + metaW;
      const barRightEdge    = barX + barW;
      const nameCenterX     = (metaInsideRight + barRightEdge) / 2;
      // BUG IN PRIOR VERSIONS: setAttribute('x', ...) on the bar-label was
      // updating the DOM attribute (getBoundingClientRect returned the new
      // position) but the rendered glyphs visually stayed at the centered
      // position — looked like Step 2 wasn't firing. Use CSS transform
      // instead: it's picked up directly by the SVG paint pipeline. We keep
      // the x attribute at the centered position and shift the rendered
      // text via translate.
      const shiftX = nameCenterX - (barX + barW / 2);
      barLabel.setAttribute('x', String(barX + barW / 2));
      barLabel.setAttribute('text-anchor', 'middle');
      barLabel.style.textAnchor = '';
      barLabel.style.transform = `translateX(${shiftX}px)`;
      barLabel.classList.remove('bar-label-outside');
    } else if (step3Works) {
      chosenStep = 3;
      // Meta OUTSIDE-left. Name centered in bar (it now has full width to use).
      moveMetaOutside();
      centerNameInBar();
    } else {
      chosenStep = 4;
      // Both outside.
      moveMetaOutside();
      barLabel.setAttribute('x', String(barX + barW + 6));
      barLabel.setAttribute('text-anchor', 'start');
      barLabel.style.textAnchor = '';
      barLabel.style.transform = '';
      barLabel.classList.add('bar-label-outside');
    }

    // DEBUG: tint the name's fill based on which step fired, so we can
    // visually verify the cascade is doing what it claims. Disable when
    // satisfied via the same SDC_HIDE_BARMETA_DEBUG flag as the ticks.
    if (!window.SDC_HIDE_BARMETA_DEBUG) {
      const stepFills = { 2: '#dc2626', 3: '#1d4ed8', 4: '#ea580c' };
      if (stepFills[chosenStep]) barLabel.style.fill = stepFills[chosenStep];
    }

    // DEBUG TICKS — drawn AFTER the cascade has placed everything, so the
    // ticks reflect the FINAL rendered positions, not the pre-cascade ones.
    //   ▸ MAGENTA = computed meta right edge (only shown when meta is inside).
    //   ▸ BLUE    = name's ACTUAL rendered left edge after cascade decision.
    // Hide both via `window.SDC_HIDE_BARMETA_DEBUG = true` in DevTools.
    if (!window.SDC_HIDE_BARMETA_DEBUG) {
      const drawTick = (x, color) => {
        const tick = document.createElementNS(SVG_NS, 'line');
        tick.setAttribute('class', 'sdc-bar-meta');
        tick.setAttribute('x1', String(x));
        tick.setAttribute('x2', String(x));
        tick.setAttribute('y1', String(barY));
        tick.setAttribute('y2', String(barY + barH));
        tick.setAttribute('stroke', color);
        tick.setAttribute('stroke-width', '1');
        tick.setAttribute('stroke-dasharray', '2 1');
        tick.style.pointerEvents = 'none';
        group.appendChild(tick);
      };
      // Magenta — only meaningful when meta is inside the bar (Step 1 & 2).
      if (chosenStep === 1 || chosenStep === 2) {
        drawTick(barX + INSIDE_PADDING + metaW, '#e11d48');
      }
      // Blue — re-read the name's rect AFTER the cascade so the tick lands
      // at the actual final left edge.
      const finalNameRect = barLabel.getBoundingClientRect();
      drawTick(barX + (finalNameRect.left - barRect.left), '#1d4ed8');
    }
  }
}

// Floating stat card in the top-right of the Gantt area. Shows project stats:
// Duration (PO→FAT in calendar weeks), labor-weighted % Complete, and FAT
// date with an optional baseline-variance chip. Hidden on All-projects since
// these are per-project.
//
// (View options used to live here too — moved to the View pill in the toolbar
// in v3.50 so this popup stays focused on read-only project stats.)
function renderProjectStatsPopup() {
  const split = document.getElementById('schedule-split');
  if (!split) return;
  let popup = split.querySelector('#project-stats-popup');
  const project = state.filters.project;
  if (!project) {
    if (popup) popup.remove();
    return;
  }
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'project-stats-popup';
    popup.className = 'project-stats-popup';
    split.appendChild(popup);
  }
  const stats = computeProjectStats(project);
  // Duration: PO → FAT (calendar weeks, rounded). Falls back to "—" if either
  // anchor doesn't have a date yet.
  const tasks = state.tasks.filter(t => t.project === project);
  const po  = tasks.find(t => inferredAnchorKey(t) === 'receipt_of_po');
  const fat = tasks.find(t => inferredAnchorKey(t) === 'fat');
  let durationLabel = '—';
  if (po && fat && po.start_date && fat.start_date) {
    const days = Math.round((new Date(fat.start_date + 'T00:00:00') - new Date(po.start_date + 'T00:00:00')) / 86400000);
    const weeks = Math.max(0, Math.round(days / 7));
    durationLabel = `${weeks} wk${weeks === 1 ? '' : 's'}`;
  }
  const pctLabel = stats.percentComplete != null ? `${stats.percentComplete}%` : '—';
  // FAT row: show the actual date plus an optional variance chip when a
  // baseline is set. Variance rounds DAYS → WEEKS (5 business days per week)
  // so the chip reads as "+1 wk / -2 wks / 0 wks" instead of "+3d late /
  // -7d early" — matches how everything else in this app talks about time
  // (estimate sheets, durations, etc. are all weekly). Rounding is to-nearest:
  //   0 days → 0 wks
  //   1-2 days → 0 wks (rounds down)
  //   3-7 days → 1 wk
  //   8-12 days → 2 wks
  //   ...
  let fatDateLabel = fat?.start_date ? fmtDate(fat.start_date) : '—';
  let fatVarChip = '';
  if (stats.fatVariance != null) {
    const wks = Math.round(stats.fatVariance / 5);  // 5 business days = 1 week
    if (wks === 0)       fatVarChip = '<span class="popup-fat-var stat-ok">0 wks</span>';
    else if (wks > 0)    fatVarChip = `<span class="popup-fat-var stat-late">+${wks} wk${wks === 1 ? '' : 's'}</span>`;
    else                  fatVarChip = `<span class="popup-fat-var stat-early">${wks} wk${wks === -1 ? '' : 's'}</span>`;
  }

  popup.innerHTML = `
    <div class="popup-row">
      <span class="popup-label">Duration</span>
      <span class="popup-value" title="Receipt of PO → FAT, in calendar weeks (rounded).">${durationLabel}</span>
    </div>
    <div class="popup-row">
      <span class="popup-label">Complete</span>
      <span class="popup-value" title="Labor-weighted: SUM(duration × progress) ÷ SUM(duration) across non-milestone tasks.">${pctLabel}</span>
    </div>
    <div class="popup-row">
      <span class="popup-label">FAT</span>
      <span class="popup-value" title="FAT anchor start date (M/D/YY). The chip on the right shows baseline variance in business days, if a baseline is set.">
        ${fatDateLabel}${fatVarChip}
      </span>
    </div>
  `;
}

// ---------- Today line ----------
// Vertical dotted red line at today's date, spanning from the date header to the
// bottom of the chart. Lets the user see at a glance "where are we right now?"
// vs every bar. Hidden when today falls outside the rendered date range (e.g.
// archived projects far in the past).
function drawTodayLine() {
  const svg = document.querySelector('#gantt-container .gantt');
  if (!svg) return;
  svg.querySelectorAll('.today-line, .today-line-label').forEach(el => el.remove());
  if (!state.gantt || !state.gantt.gantt_start) return;

  const g = state.gantt;
  const startMs = new Date(g.gantt_start).getTime();
  const cw = g.options.column_width;
  const mode = g.options.view_mode || 'Week';
  const step = mode === 'Day' ? 1 : mode === 'Week' ? 7 : 30;
  const pxPerDay = cw / step;

  // Snap "today" to the same UTC start-of-day frappe-gantt uses internally so
  // the line lands at the same X position the date-axis ticks are anchored to.
  const todayMs = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  const days = (todayMs - startMs) / 86400000;
  if (days < 0) return; // today is BEFORE the chart's earliest date
  const x = days * pxPerDay;
  const svgW = +svg.getAttribute('width') || 8000;
  if (x > svgW) return;  // today is past the right edge of the chart

  // Find the topmost bar to determine where the chart content starts. yTop sits
  // just below the date header — same approach the financial overlay uses.
  let firstBarY = Infinity;
  for (const bar of svg.querySelectorAll('.bar-wrapper:not(.phantom-pad) .bar')) {
    const y = +bar.getAttribute('y');
    if (y < firstBarY) firstBarY = y;
  }
  const yTop = Number.isFinite(firstBarY) ? Math.max(40, firstBarY - 16) : 50;
  const svgH = +svg.getAttribute('height') || 600;

  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('class', 'today-line');
  line.setAttribute('x1', x);
  line.setAttribute('x2', x);
  line.setAttribute('y1', yTop);
  line.setAttribute('y2', svgH);
  // SDC blue — primary brand color. Distinct from the lime anchor diamonds
  // and the green financial overlay lines.
  line.setAttribute('stroke', '#1574c4');
  line.setAttribute('stroke-width', '1.4');
  line.setAttribute('stroke-dasharray', '3 3');
  line.setAttribute('opacity', '0.85');
  line.setAttribute('pointer-events', 'none');
  svg.appendChild(line);

  // Tiny "Today" label at the top of the line. SDC navy text on a white halo
  // so it stays readable wherever it lands.
  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('class', 'today-line-label');
  label.setAttribute('x', x + 4);
  label.setAttribute('y', yTop + 11);
  label.setAttribute('font-size', '10');
  label.setAttribute('font-weight', '700');
  label.setAttribute('fill', '#061d39');     // SDC navy
  label.setAttribute('stroke', '#ffffff');
  label.setAttribute('stroke-width', '3');
  label.setAttribute('paint-order', 'stroke');
  label.setAttribute('pointer-events', 'none');
  label.textContent = 'Today';
  svg.appendChild(label);
}

// ---------- Baseline ghosts ----------
// For every task with baseline_start_date + baseline_end_date set, draw a dashed
// outline at the baseline's date range, behind the current bar. The outline
// uses the SAME color family as the task itself (fill for the dashed stroke,
// stroke shade for the drift label) so it reads as a ghost of THAT specific
// task, not a generic purple overlay. A bare "+Nd" / "−Nd" label sits adjacent
// to the bar — no pill background, no "vs baseline" wording.
function drawBaselineGhosts() {
  const svg = document.querySelector('#gantt-container .gantt');
  if (!svg) return;
  svg.querySelectorAll('.baseline-ghost, .baseline-drift-label').forEach(el => el.remove());
  if (!state.showBaseline) return;
  if (!state.gantt || !state.gantt.gantt_start) return;

  const g = state.gantt;
  const startMs = new Date(g.gantt_start).getTime();
  const cw = g.options.column_width;
  const mode = g.options.view_mode || 'Week';
  const step = mode === 'Day' ? 1 : mode === 'Week' ? 7 : 30;
  const pxPerDay = cw / step;

  // Signed business-day offset between two ISO dates. Returns 0 for same-day
  // (businessDaysBetween itself is inclusive, hence the -1 correction).
  const driftDays = (fromISO, toISO) => {
    if (!fromISO || !toISO || fromISO === toISO) return 0;
    const sign = toISO > fromISO ? 1 : -1;
    const days = businessDaysBetween(
      sign > 0 ? fromISO : toISO,
      sign > 0 ? toISO   : fromISO,
    );
    return sign * Math.max(0, days - 1);
  };

  for (const task of state.tasks) {
    if (!task.baseline_start_date || !task.baseline_end_date) continue;
    if (!task.start_date || !task.end_date) continue;
    const wrap = svg.querySelector(`.bar-wrapper[data-id="${task.id}"]`);
    if (!wrap) continue;
    const bar = wrap.querySelector('.bar');
    if (!bar) continue;

    const barY = +bar.getAttribute('y');
    const barH = +bar.getAttribute('height');
    const barX = +bar.getAttribute('x');
    const barW = +bar.getAttribute('width');

    const bsMs = new Date(task.baseline_start_date + 'T00:00:00').getTime();
    const beMs = new Date(task.baseline_end_date + 'T00:00:00').getTime();
    if (Number.isNaN(bsMs) || Number.isNaN(beMs)) continue;

    const ghostX = ((bsMs - startMs) / 86400000) * pxPerDay;
    const ghostW = Math.max(2, ((beMs - bsMs) / 86400000 + 1) * pxPerDay);

    const startDrift = driftDays(task.baseline_start_date, task.start_date);
    const endDrift   = driftDays(task.baseline_end_date,   task.end_date);
    if (startDrift === 0 && endDrift === 0) continue;

    // Pull live colors off the bar so the ghost matches THIS task's hue. Fill
    // = the light shade (used as the dashed stroke); stroke = the dark shade
    // (used as the drift-label text). Falls back to neutral slate if the bar
    // somehow doesn't have computed colors.
    const cs = window.getComputedStyle(bar);
    const ghostStroke = (cs.fill && cs.fill !== 'none' && cs.fill !== 'rgb(0, 0, 0)')
      ? cs.fill : '#64748b';
    const labelFill = (cs.stroke && cs.stroke !== 'none' && cs.stroke !== 'rgb(0, 0, 0)')
      ? cs.stroke : '#334155';

    const ghost = document.createElementNS(SVG_NS, 'rect');
    ghost.setAttribute('class', 'baseline-ghost');
    ghost.setAttribute('x', ghostX);
    ghost.setAttribute('y', barY);
    ghost.setAttribute('width', ghostW);
    ghost.setAttribute('height', barH);
    ghost.setAttribute('rx', 3);
    ghost.setAttribute('ry', 3);
    ghost.setAttribute('fill', 'none');
    ghost.setAttribute('stroke', ghostStroke);
    ghost.setAttribute('stroke-width', '1.5');
    ghost.setAttribute('stroke-dasharray', '5 3');
    ghost.setAttribute('pointer-events', 'none');
    wrap.insertBefore(ghost, wrap.firstChild);

    // Drift label — bare "+Nd" / "−Nd" in the task's dark color. No pill, no
    // "baseline" wording. ALWAYS placed to the LEFT of the bar (anchored to the
    // bar's left edge) so it never collides with the schedule-status chip on
    // the right. SKIPPED for milestones (anchors + regular) because the diamond
    // shape extends well past the bar's bbox — the label would land on top of
    // the diamond. The ghost shape alone is enough to read the drift on those.
    const driftMag = Math.abs(startDrift);
    if (driftMag > 0 && !task.is_milestone) {
      const isLate = startDrift > 0;
      const labelText = `${isLate ? '+' : '−'}${driftMag}d`;
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'baseline-drift-label');
      text.setAttribute('x', barX - 4);
      text.setAttribute('y', barY + barH / 2 + 3);
      text.setAttribute('text-anchor', 'end');
      text.setAttribute('font-size', '10');
      text.setAttribute('font-weight', '700');
      text.setAttribute('fill', labelFill);
      text.setAttribute('stroke', '#ffffff');
      text.setAttribute('stroke-width', '3');
      text.setAttribute('paint-order', 'stroke');
      text.setAttribute('pointer-events', 'none');
      text.textContent = labelText;
      svg.appendChild(text);
    }
  }
}

// ---------- Financial overlay ----------
// When the $ Financial toggle is on, draw a vertical line through the whole chart
// at each financial milestone's date. Line is DASHED for not-yet-sent invoices
// and SOLID once the Sent checkbox is on (the `paid` DB field is reused for this
// flag — name's legacy). A small label at the top names the milestone + percent.
// Renders ON TOP of bars/arrows so it's always readable.
function drawFinancialOverlay() {
  const svg = document.querySelector('#gantt-container .gantt');
  if (!svg) return;
  // Always clear so toggling off clears the overlay even when re-render is skipped.
  svg.querySelectorAll('.financial-marker').forEach(d => d.remove());
  if (!state.showFinancials) return;
  if (!state.gantt || !state.gantt.gantt_start) return;

  // Collect markers for every project currently rendering bars. Skips projects whose
  // bars are all filtered out (so the All-projects view shows everything, a single
  // project tab shows just that one).
  const visibleProjects = new Set();
  for (const t of state.tasks) {
    if (!t.start_date) continue;
    if (svg.querySelector(`.bar-wrapper[data-id="${t.id}"]`)) {
      visibleProjects.add(t.project || '');
    }
  }
  const markers = [];
  for (const project of visibleProjects) {
    const list = state.financials[project] || [];
    for (const f of list) {
      // Predecessor-derived date wins; manual due_date is the fallback. Computed
      // at render time so anchor/task edits update the overlay without needing a
      // round-trip to the server.
      const derived = computeFinancialTriggerDate(f.predecessors, project);
      const due = derived || f.due_date;
      if (!due) continue;
      markers.push({ ...f, due_date: due, project });
    }
  }
  if (markers.length === 0) return;

  // Date → x. gantt_start is the leftmost calendar date the Gantt knows about.
  // step = calendar days per column for the current view mode.
  const g = state.gantt;
  const startMs = new Date(g.gantt_start).getTime();
  const cw = g.options.column_width;
  const mode = g.options.view_mode || 'Week';
  const step = mode === 'Day' ? 1 : mode === 'Week' ? 7 : 30;
  const pxPerDay = cw / step;

  // Lines span the full chart height. yTop has to land BELOW the date header
  // (including the day-number row). The header elements are <g> groups, not
  // <rect>s, so their getAttribute('height') is null — using header_height as a
  // proxy underestimates the actual rendered band. Instead we find the topmost
  // task bar's Y: bars always start AFTER the entire header, so first_bar.y - 16
  // is guaranteed to be in the gap above the first row, comfortably past the
  // dates.
  const svgH = +svg.getAttribute('height') || svg.viewBox?.baseVal?.height || 600;
  let firstBarY = Infinity;
  for (const bar of svg.querySelectorAll('.bar-wrapper:not(.phantom-pad) .bar')) {
    const y = +bar.getAttribute('y');
    if (y < firstBarY) firstBarY = y;
  }
  const yTop = Number.isFinite(firstBarY) ? Math.max(40, firstBarY - 16) : 50;
  const yBottom = svgH;

  const layer = document.createElementNS(SVG_NS, 'g');
  layer.setAttribute('class', 'financial-marker financial-overlay-layer');
  svg.appendChild(layer);

  // Lane assignment — each lane is a horizontal "row" of labels just below the
  // date header. If a label's X overlaps another label's right edge in the same
  // lane, it spills to the next lane down so the labels never sit on top of each
  // other. Markers sorted by date so the lane walk is left-to-right.
  const sortedMarkers = [...markers].sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
  const APPROX_CHAR = 5.8;
  const LANE_H = 17;       // ~3px breathing room between stacked pills
  const LANE_GAP_X = 10;   // min horizontal gap before two labels can share a lane
  const laneEndX = [];
  const laneByMarker = new Map();
  for (const m of sortedMarkers) {
    const date = new Date(m.due_date + 'T00:00:00');
    if (Number.isNaN(date.getTime())) continue;
    const x = ((date.getTime() - startMs) / (86400 * 1000)) * pxPerDay;
    const pct = m.percent != null ? ` ${Number(m.percent)}%` : '';
    const labelW = ((m.name || '').length + pct.length) * APPROX_CHAR + 12; // +pill padding
    let lane = 0;
    for (; lane < laneEndX.length; lane++) {
      if (laneEndX[lane] + LANE_GAP_X < x) break;
    }
    laneEndX[lane] = x + labelW;
    laneByMarker.set(m, lane);
  }

  for (const m of markers) {
    const date = new Date(m.due_date + 'T00:00:00');
    if (Number.isNaN(date.getTime())) continue;
    const days = (date.getTime() - startMs) / (86400 * 1000);
    const x = days * pxPerDay;
    const sent = !!m.paid;
    const lane = laneByMarker.get(m) || 0;
    // Labels sit BELOW the dates (yTop already accounts for both header rows),
    // shifted into their assigned lane.
    const labelY = yTop + 12 + lane * LANE_H;

    // Vertical line through the whole chart — bolder than v1.9.x so it reads
    // clearly against busy bars. Dashed when pending, solid when sent.
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'financial-marker financial-line' + (sent ? ' is-sent' : ''));
    line.setAttribute('x1', x);
    line.setAttribute('x2', x);
    line.setAttribute('y1', yTop);
    line.setAttribute('y2', yBottom);
    line.setAttribute('stroke', '#16a34a');
    line.setAttribute('stroke-width', sent ? '2.2' : '1.6');
    if (!sent) line.setAttribute('stroke-dasharray', '5 4');
    layer.appendChild(line);

    // Build label text first so we can measure for the pill backdrop.
    const pct = m.percent != null ? ` ${Number(m.percent)}%` : '';
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', x + 6);
    text.setAttribute('y', labelY);
    text.setAttribute('class', 'financial-marker financial-label');
    text.setAttribute('font-size', '11');
    text.setAttribute('font-weight', '700');
    text.setAttribute('fill', '#14532d');         // green-900 — strong contrast
    text.textContent = (m.name || '') + pct;
    layer.appendChild(text);

    // White pill backdrop behind each label so the label is readable even when
    // it lands over a task label or another visual element. Sized to the text's
    // measured bbox so it hugs the text exactly.
    const tb = text.getBBox();
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('class', 'financial-marker financial-label-bg');
    bg.setAttribute('x', tb.x - 4);
    bg.setAttribute('y', tb.y - 1);
    bg.setAttribute('width',  tb.width + 8);
    bg.setAttribute('height', tb.height + 2);
    bg.setAttribute('rx', 3);
    bg.setAttribute('fill', '#ffffff');
    bg.setAttribute('stroke', '#16a34a');
    bg.setAttribute('stroke-width', '0.75');
    layer.insertBefore(bg, text);

    // Hover title for full info — attached to the line so the whole vertical hit area works.
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${m.project ? m.project + ' · ' : ''}${m.name}${pct} (${m.due_date})${sent ? ' — SENT' : ''}`;
    line.appendChild(title);
  }
}

// Compute the critical path — the chain of tasks that drives the schedule from
// Receipt of PO to FAT. We walk BACKWARD from FAT: at each step we pick the
// predecessor whose date drives this task's start/end (the latest-finishing FS
// predecessor, the latest-starting SS one, etc.) Slipping any task in the returned
// set delays FAT. Returns a Set of task ids (including FAT and Receipt of PO).
function computeCriticalPath() {
  const projectFilter = state.filters.project;
  const tasks = projectFilter ? state.tasks.filter(t => t.project === projectFilter) : state.tasks;
  const fat = tasks.find(t => inferredAnchorKey(t) === 'fat');
  if (!fat) return new Set();
  // Stringify IDs throughout — bar elements expose IDs via data-id (always string),
  // so storing strings keeps the Set comparable with the lookup site in
  // drawCustomArrows without per-call Number() conversions slipping past.
  const taskById = Object.fromEntries(tasks.map(t => [String(t.id), t]));
  const critical = new Set([String(fat.id)]);
  const visit = [fat];
  while (visit.length > 0) {
    const cur = visit.pop();
    if (!cur.predecessors) continue;
    const refs = String(cur.predecessors)
      .split(',')
      .map(s => parsePredecessor(s.trim()))
      .filter(Boolean);
    if (refs.length === 0) continue;
    // Find the binding predecessor — the one whose driven date is latest. That's
    // the one pinning this task's start; everyone else has slack.
    let bound = null, boundMs = -Infinity;
    for (const ref of refs) {
      const pred = taskById[String(ref.id)];
      if (!pred) continue;
      const drivenDate = (ref.type === 'SS' || ref.type === 'SF')
        ? pred.start_date
        : pred.end_date;
      if (!drivenDate) continue;
      const ms = new Date(drivenDate + 'T00:00:00Z').getTime();
      if (ms > boundMs) { boundMs = ms; bound = pred; }
    }
    if (bound && !critical.has(String(bound.id))) {
      critical.add(String(bound.id));
      visit.push(bound);
    }
  }
  return critical;
}

// For every in-progress non-milestone task, compare ACTUAL progress (% complete) to
// EXPECTED progress at today's date. A small chip is drawn just to the right of the
// task bar showing how many working days the task is ahead (green) or behind (red).
// On-track tasks (|diff| < 1d) get no chip — keeps the chart clean.
function drawScheduleStatus() {
  const svg = document.querySelector('#gantt-container .gantt');
  if (!svg) return;
  // Clear any prior chips before re-drawing (each render rebuilds them).
  svg.querySelectorAll('.sdc-status-chip').forEach(el => el.remove());
  const todayISO = new Date().toISOString().slice(0, 10);
  for (const task of state.tasks) {
    if (task.is_milestone) continue;
    if (!task.start_date || !task.end_date) continue;
    if (inferredAnchorKey(task)) continue;
    if (isBacklogTask(task)) continue; // backlog is not "behind", it's by design
    const wrap = svg.querySelector(`.bar-wrapper[data-id="${task.id}"]`);
    if (!wrap) continue;
    const bar = wrap.querySelector('.bar');
    if (!bar) continue;
    // Days math — business-day aware so "2 weeks ahead" actually reads as 10, not 14.
    const totalDays = businessDaysBetween(task.start_date, task.end_date);
    if (!totalDays || totalDays <= 0) continue;
    const actualPct = Math.max(0, Math.min(100, Number(task.progress) || 0));
    let elapsedDays;
    if (todayISO < task.start_date) {
      // Not yet started. Any progress here = ahead. Expected = 0.
      elapsedDays = 0;
    } else if (todayISO > task.end_date) {
      // Past end date — should be 100% by now.
      elapsedDays = totalDays;
    } else {
      elapsedDays = businessDaysBetween(task.start_date, todayISO) || 0;
    }
    const expectedPct = (elapsedDays / totalDays) * 100;
    const actualDays  = (actualPct   / 100) * totalDays;
    const diffDays = Math.round(actualDays - elapsedDays); // + ahead, − behind
    if (Math.abs(diffDays) < 1) continue;
    const ahead = diffDays > 0;
    const barX = +bar.getAttribute('x');
    const barY = +bar.getAttribute('y');
    const barW = +bar.getAttribute('width');
    const barH = +bar.getAttribute('height');
    const cx = barX + barW + 6;       // 6px gap to the right of the bar
    const cy = barY + barH / 2;
    const label = `${ahead ? '+' : '−'}${Math.abs(diffDays)}d`;
    const padX = 5, chipH = Math.max(12, barH - 2);
    // Estimate width — text is short, ~7px per char + padding.
    const w = label.length * 6.5 + padX * 2;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'sdc-status-chip');
    g.setAttribute('data-state', ahead ? 'ahead' : 'behind');
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', cx);
    rect.setAttribute('y', cy - chipH / 2);
    rect.setAttribute('width', w);
    rect.setAttribute('height', chipH);
    rect.setAttribute('rx', 3);
    rect.setAttribute('ry', 3);
    rect.setAttribute('fill', ahead ? '#16a34a' : '#dc2626');
    rect.setAttribute('opacity', '0.95');
    g.appendChild(rect);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', cx + padX);
    text.setAttribute('y', cy);
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('font-size', '10');
    text.setAttribute('font-weight', '700');
    text.setAttribute('fill', '#fff');
    text.setAttribute('pointer-events', 'none');
    text.textContent = label;
    g.appendChild(text);
    // Tooltip for the chip — extra context on hover.
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = ahead
      ? `${Math.abs(diffDays)} working day${Math.abs(diffDays) === 1 ? '' : 's'} AHEAD of schedule (${actualPct.toFixed(0)}% complete, expected ${expectedPct.toFixed(0)}%)`
      : `${Math.abs(diffDays)} working day${Math.abs(diffDays) === 1 ? '' : 's'} BEHIND schedule (${actualPct.toFixed(0)}% complete, expected ${expectedPct.toFixed(0)}%)`;
    g.appendChild(title);
    wrap.appendChild(g);
  }
}

// Shift each Gantt bar so its row aligns with the corresponding task row in the grid.
// The grid has group headers and add-task rows that don't exist in the Gantt, so bars
// would otherwise sit at smaller y values than their grid rows.
function alignGanttToGrid() {
  const tasksTable = document.getElementById('tasks-table');
  const ganttSvg = document.querySelector('#gantt-container .gantt');
  if (!tasksTable || !ganttSvg) return;

  // Map task id -> y offset within the table
  const gridYs = {};
  tasksTable.querySelectorAll('tbody tr[data-id]').forEach(tr => {
    gridYs[tr.dataset.id] = tr.offsetTop;
  });

  // Make the SVG at least as tall as the grid so shifted bars stay visible.
  const gridHeight = tasksTable.offsetHeight;
  const svgHeight = +ganttSvg.getAttribute('height') || 0;
  if (gridHeight > svgHeight) {
    ganttSvg.setAttribute('height', gridHeight);
    // Also extend the viewBox so content past the original height isn't clipped.
    const vb = ganttSvg.getAttribute('viewBox');
    if (vb) {
      const [vx, vy, vw, vh] = vb.split(/\s+/).map(Number);
      if (vh < gridHeight) ganttSvg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${gridHeight}`);
    }
  }

  const rowH = state.layout.rowHeight;
  ganttSvg.querySelectorAll('.bar-wrapper[data-id]').forEach(wrap => {
    const id = wrap.getAttribute('data-id');
    const targetTop = gridYs[id];
    if (targetTop === undefined) return;
    const bar = wrap.querySelector('.bar');
    if (!bar) return;
    const currentY = +bar.getAttribute('y');
    const barH = +bar.getAttribute('height');
    const desiredY = targetTop + (rowH - barH) / 2;
    const dy = desiredY - currentY;
    if (Math.abs(dy) < 0.5) return;
    shiftElementY(wrap, dy);
  });

  // Clear any old custom stripes — keep the gantt background plain white.
  const oldStripes = ganttSvg.querySelector('.sdc-row-stripes');
  if (oldStripes) oldStripes.remove();
  const finalSvgHeight = +ganttSvg.getAttribute('height') || gridHeight;

  // Draw fresh full-height vertical tick lines at every date column. We use the lower-text
  // x positions (which we know exist — the date label numbers) as the column anchors. This
  // doesn't depend on frappe-gantt's internal tick rendering, which may be lines/paths/rects.
  let tickGroup = ganttSvg.querySelector('.sdc-tick-fill');
  if (tickGroup) tickGroup.remove();
  const lowerTexts = [...ganttSvg.querySelectorAll('.lower-text')];
  if (lowerTexts.length > 1) {
    tickGroup = document.createElementNS(SVG_NS, 'g');
    tickGroup.setAttribute('class', 'sdc-tick-fill');
    ganttSvg.insertBefore(tickGroup, ganttSvg.firstChild);
    // Header bottom = 60 (matches the th height we set). Vertical lines from there to bottom.
    const tickTop = 60;
    lowerTexts.forEach(t => {
      const x = +t.getAttribute('x') || 0;
      const ln = document.createElementNS(SVG_NS, 'line');
      ln.setAttribute('x1', x);
      ln.setAttribute('x2', x);
      ln.setAttribute('y1', tickTop);
      ln.setAttribute('y2', finalSvgHeight);
      ln.setAttribute('stroke', '#f1f5f9');
      ln.setAttribute('stroke-width', '1');
      tickGroup.appendChild(ln);
    });
  }
}

function shiftElementY(root, dy) {
  root.querySelectorAll('rect, polygon, text, line, circle').forEach(el => {
    const y = el.getAttribute('y');
    if (y !== null) el.setAttribute('y', +y + dy);
    const y1 = el.getAttribute('y1');
    if (y1 !== null) el.setAttribute('y1', +y1 + dy);
    const y2 = el.getAttribute('y2');
    if (y2 !== null) el.setAttribute('y2', +y2 + dy);
    const cy = el.getAttribute('cy');
    if (cy !== null) el.setAttribute('cy', +cy + dy);
    const points = el.getAttribute('points');
    if (points) {
      el.setAttribute('points', points.split(/\s+/).map(p => {
        const [x, y] = p.split(',').map(Number);
        return `${x},${y + dy}`;
      }).join(' '));
    }
  });
}

// Frappe-gantt sometimes puts the month name into the lower (day-level) header
// at month boundaries (e.g. "02 May"), which then duplicates the upper header's
// month label and looks like there are two month rows. Strip the month word
// from the lower-text so day numbers stay alone in the lower row.
function cleanGanttHeaders() {
  const svg = document.querySelector('#gantt-container .gantt');
  if (!svg) return;
  // In Month view, the lower-text IS the month name (Jan / Feb / etc.) and the
  // upper-text is the year — we have to keep both. The de-duplication below was
  // designed for Week view, where the upper-text is "January" and the lower-
  // text used to repeat it ("Jan 12") creating noise; stripping months in
  // Month view leaves the row blank, which is what the user just hit.
  const mode = state.gantt?.options?.view_mode;
  if (mode === 'Month') return;
  const monthRe = /\s*(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*/g;
  svg.querySelectorAll('.lower-text').forEach(t => {
    const cleaned = (t.textContent || '').replace(monthRe, ' ').trim();
    if (cleaned !== t.textContent) t.textContent = cleaned;
  });
}

// frappe-gantt creates an inner `.gantt-container` div around the SVG that owns the
// horizontal scroll. The outer #gantt-container and #schedule-gantt panel never grow
// past their own clientWidth, so their scrollLeft is a no-op.
function getGanttScroller() {
  return document.querySelector('#gantt-container .gantt-container');
}

function setZoom(percent) {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, percent));
  if (Math.abs(next - state.zoomPercent) < 0.01) return;

  // Capture the DATE under the viewport center BEFORE we re-render. We can't
  // just scale pixel positions linearly (the old code did `factor * oldCenterPx`)
  // because getZoomConfig may flip the view mode at certain zoom thresholds —
  // and when the mode flips, the gantt's start date, column width formula, and
  // px-per-day all change discontinuously. A pixel that meant "Aug 10" in Week
  // mode might map to "Nov 3" in Month mode after the rebuild, which is what
  // made the chart appear to jump way off to the side at the Week→Month
  // boundary. Converting to a date and back is mode-independent.
  let centerDateMs = null;
  const oldScroller = getGanttScroller();
  const viewW = oldScroller ? oldScroller.clientWidth : 0;
  if (oldScroller && state.gantt?.gantt_start) {
    const oldCenterPx = oldScroller.scrollLeft + viewW / 2;
    const g = state.gantt;
    const oldStartMs = new Date(g.gantt_start).getTime();
    const cw = g.options.column_width;
    const mode = g.options.view_mode || 'Week';
    const step = mode === 'Day' ? 1 : mode === 'Week' ? 7 : 30;
    const pxPerDay = cw / step;
    if (pxPerDay > 0) {
      const daysFromStart = oldCenterPx / pxPerDay;
      centerDateMs = oldStartMs + daysFromStart * 86400000;
    }
  }

  state.zoomPercent = next;
  renderGantt();

  // Now find that same date on the new chart and scroll so it sits at the
  // viewport center. If gantt_start changed (mode flip can shift the padding
  // boundary), the math still works because we re-derive everything from the
  // new gantt's start + cw + step.
  const newScroller = getGanttScroller();
  if (newScroller && centerDateMs != null && state.gantt?.gantt_start) {
    const g = state.gantt;
    const newStartMs = new Date(g.gantt_start).getTime();
    const cw = g.options.column_width;
    const mode = g.options.view_mode || 'Week';
    const step = mode === 'Day' ? 1 : mode === 'Week' ? 7 : 30;
    const pxPerDay = cw / step;
    if (pxPerDay > 0) {
      const targetPx = ((centerDateMs - newStartMs) / 86400000) * pxPerDay;
      newScroller.scrollLeft = Math.max(0, targetPx - viewW / 2);
    }
  }
  // v4.55: Keep the Zoom dropdown's displayed value in sync with any zoom
  // change — wheel zoom, Zoom-to-fit, time-scale switch, and the dropdown's
  // own +/− buttons all flow through here. renderZoomMenu bails if the
  // menu element isn't in the DOM yet, so this is safe on init.
  if (typeof renderZoomMenu === 'function') renderZoomMenu();
}


function zoomToFit() {
  const visiblePanel = document.getElementById('schedule-gantt');
  const target = Math.max(300, visiblePanel.clientWidth - 24);
  const filtered = applyFilters(state.tasks).filter(t => t.start_date && t.end_date);
  if (filtered.length === 0 || target <= 0) return;

  const minStart = Math.min(...filtered.map(t => new Date(t.start_date).getTime()));
  const maxEnd   = Math.max(...filtered.map(t => new Date(t.end_date).getTime()));
  const projectDays = Math.max(1, (maxEnd - minStart) / 86400000 + 1);

  const PAD_DAYS = 14;
  const requiredPxPerDay = target / (projectDays + PAD_DAYS);
  state.zoomPercent = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (requiredPxPerDay / 20) * 100));
  renderGantt();

  // Synchronously scroll so the earliest real task sits near the left edge.
  const earliest = filtered.reduce((min, t) =>
    new Date(t.start_date).getTime() < new Date(min.start_date).getTime() ? t : min);
  const wrap = document.querySelector(`#gantt-container .bar-wrapper[data-id="${earliest.id}"]`);
  const bar = wrap && wrap.querySelector('.bar');
  if (bar) {
    const firstX = +bar.getAttribute('x');
    const scroller = getGanttScroller();
    if (scroller) scroller.scrollLeft = Math.max(0, firstX - 24);
  }
}

// ---------- Milestone diamonds ----------
function drawMilestoneDiamonds() {
  const svg = document.querySelector('#gantt-container .gantt');
  if (!svg) return;

  // Clear previous
  svg.querySelectorAll('.milestone-diamond, .milestone-check').forEach(d => d.remove());

  // Checkmark color for done milestones. The diamond itself keeps its normal
  // anchor / non-anchor fill — only the ✓ glyph overlay tells you it's done.
  // (Earlier versions flipped the whole diamond to a deep-green "done" color;
  // that made done anchors look completely different from undone ones, which
  // was confusing when two anchors of the same type — e.g. Receipt of PO not
  // done vs Mech 1 Release done — sat in the same view.)
  const CHECK_COLOR = '#1e293b';   // slate-800; reads against both lime + slate diamonds

  for (const task of state.tasks) {
    if (!task.is_milestone) continue;
    const wrap = svg.querySelector(`.bar-wrapper[data-id="${task.id}"]`);
    if (!wrap) continue;
    const bar = wrap.querySelector('.bar');
    if (!bar) continue;

    const x = +bar.getAttribute('x');
    const y = +bar.getAttribute('y');
    const w = +bar.getAttribute('width');
    const h = +bar.getAttribute('height');
    const cx = x + Math.max(w / 2, 0); // milestones often have w≈step; center of bar
    const cy = y + h / 2;
    // Anchor milestones (Receipt of PO, Mech 1 Release, Machine Power-Up, FAT,
    // Ship Machine) render as a CONCENTRIC double-diamond: a smaller filled
    // inner diamond INSIDE an outline ring that matches the size of a regular
    // non-anchor milestone. So anchors and non-anchors have the same total
    // visual footprint — what distinguishes them is the ring (anchor only) and
    // the color (lime-green fill vs slate).
    //
    // v4.23 hotfix: DECOUPLED milestone size from bar_height. The bar ratio
    // bumped 0.5 → 0.7 in v4.23 (so task bars dominate their rows), which
    // also blew up the diamond ~40% because it was sized off `h` directly
    // and looked oversized for milestones. Now we compute a separate
    // diamondRef at the OLD 0.5 ratio so diamonds stay the same size they
    // always were even though task bars grew.
    //
    // Sizing (against diamondRef, not h):
    //   - Non-anchor diamond:   diamondRef × 1.20 wide.
    //   - Anchor OUTER ring:    diamondRef × 1.20 wide.
    //   - Anchor INNER diamond: diamondRef × 0.75 wide.
    const diamondRef = Math.max(BAR_H_MIN, Math.round(state.layout.rowHeight * 0.5));
    const isAnchor = !!inferredAnchorKey(task);
    const isDone   = (task.progress || 0) >= 100;
    const size = isAnchor ? diamondRef * 0.75 : diamondRef * 1.20;

    bar.style.opacity = '0';
    wrap.querySelectorAll('.bar-progress').forEach(el => el.style.opacity = '0');
    // Hide frappe-gantt's bar-label — we render our own in drawMilestoneLabels (after arrows
    // so the pill background obscures any arrow line that runs underneath).
    const lbl = wrap.querySelector('.bar-label');
    if (lbl) lbl.style.opacity = '0';

    // Anchor color comes from settings (Setup → Anchor Color). Falls back to the
    // green default when settings haven't loaded yet.
    const ac = state.settings?.anchor_color || ANCHOR_COLOR_DEFAULTS;

    if (isAnchor) {
      // Outer ring — pure outline at diamondRef × 1.20 (same size as a non-anchor
      // diamond), in the anchor text/stroke shade. The clear gap between this
      // outer ring and the smaller inner diamond is what makes the anchor
      // visually distinct without making it any larger than other milestones.
      // v4.23 hotfix: uses diamondRef (not h) so anchors stay sized off the
      // OLD bar ratio even though task bars grew when ratio bumped to 0.7.
      const outerSize = diamondRef * 1.20;
      const outerPts = `${cx},${cy - outerSize/2} ${cx + outerSize/2},${cy} ${cx},${cy + outerSize/2} ${cx - outerSize/2},${cy}`;
      const outer = document.createElementNS(SVG_NS, 'polygon');
      outer.setAttribute('points', outerPts);
      outer.setAttribute('class', 'milestone-diamond anchor-outer');
      outer.setAttribute('fill', 'none');
      // Outer ring on a "done" anchor uses the dark-green stroke so the whole
      // double-diamond reads as completed (otherwise the outer ring still looks
      // "pending" while the inner is filled green).
      // Outer ring uses the same anchor text/stroke color whether or not the
      // milestone is done. Done state is signaled by the ✓ overlay added below,
      // not a color flip — so a done Receipt of PO and an undone Receipt of PO
      // are unambiguously the same milestone, just one with a checkmark on top.
      outer.setAttribute('stroke', ac.text);
      outer.setAttribute('stroke-width', '1.75');
      outer.setAttribute('stroke-linejoin', 'miter');
      wrap.appendChild(outer);
    }

    const points = `${cx},${cy - size/2} ${cx + size/2},${cy} ${cx},${cy + size/2} ${cx - size/2},${cy}`;
    const diamond = document.createElementNS(SVG_NS, 'polygon');
    diamond.setAttribute('points', points);
    diamond.setAttribute('class', 'milestone-diamond' + (isAnchor ? ' anchor-inner' : '') + (isDone ? ' done' : '') + (task.is_action ? ' action-milestone' : ''));
    // v4.47/v4.49: action-item milestones get SDC blue (default) or RED
    // (overdue + not done). Grid + Gantt paint the same red so the user
    // immediately sees overdue actions without applying a filter.
    //   - Anchors: lime fill + dark green stroke (from anchor_color settings)
    //   - Action milestones overdue: red-300 fill + red-600 stroke
    //   - Action milestones normal: SDC primary blue
    //   - Regular non-anchor milestones: slate fill + darker slate stroke
    let dFill = '#475569';
    let dStroke = '#334155';
    let dStrokeW = '1';
    const todayISOForDiamond = new Date().toISOString().slice(0, 10);
    const isOverdueAction = task.is_action && !isDone && task.end_date && task.end_date < todayISOForDiamond;
    if (isAnchor) {
      dFill = ac.fill;
      dStroke = ac.text;
      dStrokeW = '1.5';
    } else if (isOverdueAction) {
      dFill = '#fca5a5';  // red-300
      dStroke = '#dc2626'; // red-600
      dStrokeW = '1.5';
    } else if (task.is_action) {
      dFill = '#3a8edc';  // SDC primary lighter
      dStroke = '#1574c4'; // SDC primary
      dStrokeW = '1.5';
    }
    diamond.setAttribute('fill',   dFill);
    diamond.setAttribute('stroke', dStroke);
    diamond.setAttribute('stroke-width', dStrokeW);
    wrap.appendChild(diamond);

    // Checkmark glyph rendered on top of the diamond for done milestones.
    // Sized to fit comfortably inside the inner shape, centered. Color is
    // slate-800 — reads cleanly on both the lime anchor fill and the slate
    // non-anchor fill (both have enough luminance difference from dark slate).
    if (isDone) {
      const check = document.createElementNS(SVG_NS, 'text');
      check.setAttribute('x', cx);
      check.setAttribute('y', cy);
      check.setAttribute('class', 'milestone-check');
      check.setAttribute('text-anchor', 'middle');
      check.setAttribute('dominant-baseline', 'central');
      check.setAttribute('fill', isAnchor ? CHECK_COLOR : '#ffffff');
      check.setAttribute('font-size', String(Math.round(size * 0.9)));
      check.setAttribute('font-weight', '900');
      check.setAttribute('pointer-events', 'none');
      check.textContent = '✓';
      wrap.appendChild(check);
    }
  }
}

// Detect arrow lines that cross a milestone's label pill and toggle the pill side override.
// Returns true if any pill was flipped (caller should re-render labels + arrows once).
// Bar labels stay INSIDE the bar — if the task name doesn't fit at the current zoom, we
// truncate with an ellipsis and stash the full text in a <title> for hover tooltip.
// No pills, no spillover, no obstacles for routing to worry about.
function clipBarLabels() {
  const svg = document.querySelector('#gantt-container .gantt');
  if (!svg) return;
  // v4.28: SVG width drives the "would this overflow label clip off the right
  // edge?" check below. Fall back to clientWidth, then Infinity (always-right)
  // if neither is set.
  const svgWidth =
    (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) ||
    +svg.getAttribute('width') ||
    svg.clientWidth ||
    Infinity;

  for (const task of state.tasks) {
    if (task.is_milestone) continue;
    const wrap = svg.querySelector(`.bar-wrapper[data-id="${task.id}"]`);
    if (!wrap) continue;
    const bar = wrap.querySelector('.bar');
    const label = wrap.querySelector('.bar-label');
    if (!bar || !label) continue;
    const barX = +bar.getAttribute('x');
    const barW = +bar.getAttribute('width');
    const barY = +bar.getAttribute('y');
    const barH = +bar.getAttribute('height');
    // Scale font down for short bars so descenders (g, y, p, S) don't clip below
    // the bar. Visible text-with-descender height ≈ font-size, so cap font-size
    // at barH - 2 to leave 1px breathing room top + bottom.
    //  - barH=10 → 8px  (smallest legible)
    //  - barH=12 → 10px
    //  - barH=14 → 12px
    //  - barH≥14 → 12px (capped to match grid font)
    // IMPORTANT: set via style.fontSize (inline style), NOT setAttribute. The
    // frappe-gantt CDN CSS rule `.gantt .bar-label { font-size: 12px }` has
    // higher CSS specificity than a presentation attribute, so attribute-based
    // font-size gets ignored. Inline style wins.
    const fontSize = Math.max(8, Math.min(12, barH - 2));
    label.style.fontSize = fontSize + 'px';

    const fullText = task.name || '';
    // Measure unconstrained.
    label.textContent = fullText;
    label.classList.remove('bar-label-outside');
    let labelW;
    try { labelW = label.getBBox().width; }
    catch (_) { labelW = fullText.length * 6.5; }
    const PAD = 8; // breathing room inside the bar

    if (labelW + PAD <= barW) {
      // Fits INSIDE — center label in bar (dominant-baseline 'central' keeps
      // descenders inside the bar instead of dropping below).
      label.setAttribute('x', barX + barW / 2);
      label.setAttribute('y', barY + barH / 2);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      // Drop any prior tooltip — full text is visible.
      const t = wrap.querySelector('title');
      if (t) t.remove();
      continue;
    }

    // v4.28: doesn't fit INSIDE — render OUTSIDE the bar (like milestone
    // labels do). Default placement is to the RIGHT of the bar. If the
    // right-side label would clip past the SVG edge AND there's room on
    // the left, place LEFT instead. Otherwise stays right (still readable
    // because the Gantt panel scrolls horizontally).
    //
    // Previously this branch ellipsis-truncated inside the bar ("Configure
    // Mac…"), which for short bars like "Configure Machine" at Week zoom
    // ended up rendering as just "…" or nothing — useless. Out-of-bar
    // labels solve that the same way milestone labels do.
    const labelOffset = 6;
    const rightStartX = barX + barW + labelOffset;
    const leftEndX    = barX - labelOffset;
    const wouldClipRight = (rightStartX + labelW) > svgWidth;
    const fitsLeft       = (leftEndX - labelW) > 0;
    const placeLeft = wouldClipRight && fitsLeft;

    label.textContent = fullText;
    if (placeLeft) {
      label.setAttribute('x', leftEndX);
      label.setAttribute('text-anchor', 'end');
    } else {
      label.setAttribute('x', rightStartX);
      label.setAttribute('text-anchor', 'start');
    }
    label.setAttribute('y', barY + barH / 2);
    label.setAttribute('dominant-baseline', 'central');
    label.classList.add('bar-label-outside');

    // Outside labels render the full task name — no tooltip needed.
    const t = wrap.querySelector('title');
    if (t) t.remove();
  }
}

function drawMilestoneLabels() {
  const svg = document.querySelector('#gantt-container .gantt');
  if (!svg) return;
  let group = svg.querySelector('.milestone-labels');
  if (group) group.remove();
  group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'milestone-labels');
  svg.appendChild(group);

  // Milestone labels: name text to the right of the diamond. For ANCHOR
  // milestones (Receipt of PO, Mech 1 Release, Machine Power-Up, FAT, Ship
  // Machine) also paint the date on the OPPOSITE side (left of the diamond)
  // so the spine dates are always visible in Both view without scrolling.
  // Anchor diamonds have a concentric outer ring (~75% larger than inner);
  // labels must clear THAT outer edge, not just the inner diamond.
  for (const task of state.tasks) {
    if (!task.is_milestone) continue;
    const wrap = svg.querySelector(`.bar-wrapper[data-id="${task.id}"]`);
    if (!wrap) continue;
    const bar = wrap.querySelector('.bar');
    if (!bar) continue;
    const x = +bar.getAttribute('x');
    const y = +bar.getAttribute('y');
    const w = +bar.getAttribute('width');
    const h = +bar.getAttribute('height');
    const cx = x + Math.max(w / 2, 0);
    const cy = y + h / 2;
    const isAnchor = !!inferredAnchorKey(task);
    // Anchor outer ring and non-anchor diamond both have the same outer
    // radius. v4.23 hotfix: sized off diamondRef (OLD bar ratio of 0.5×rh)
    // not the current h, since bars grew but milestones stay the same.
    const diamondRef = Math.max(BAR_H_MIN, Math.round(state.layout.rowHeight * 0.5));
    const r = diamondRef * 1.20 / 2;
    const labelOffset = 6;
    const lbl = document.createElementNS(SVG_NS, 'text');
    lbl.setAttribute('x', cx + r + labelOffset);
    lbl.setAttribute('y', cy);
    lbl.setAttribute('dominant-baseline', 'middle');
    lbl.setAttribute('text-anchor', 'start');
    lbl.setAttribute('font-size', '11');
    lbl.setAttribute('font-weight', '600');
    lbl.setAttribute('fill', '#061d39');
    lbl.style.pointerEvents = 'none';
    lbl.textContent = task.name || '';
    group.appendChild(lbl);
    // v4.60: milestone labels NO LONGER get the pill occluder — user
    // prefers seeing the arrow pass through the text. Bar-meta keeps the
    // pill (arrows can't otherwise be distinguished from the meta text).
    // Date label on the LEFT side of the diamond for the 5 spine anchors.
    if (inferredAnchorKey(task) && task.start_date) {
      const dateLbl = document.createElementNS(SVG_NS, 'text');
      dateLbl.setAttribute('x', cx - r - labelOffset);
      dateLbl.setAttribute('y', cy);
      dateLbl.setAttribute('dominant-baseline', 'middle');
      dateLbl.setAttribute('text-anchor', 'end');
      dateLbl.setAttribute('font-size', '11');
      dateLbl.setAttribute('font-weight', '700');
      dateLbl.setAttribute('fill', '#061d39');
      dateLbl.style.pointerEvents = 'none';
      dateLbl.textContent = fmtDate(task.start_date);
      group.appendChild(dateLbl);
    }
  }
}

// v4.58: insert an invisible white "occluder" rect behind a freshly-appended
// SVG text element so any arrow line passing through that area visually
// disappears under it. The rect has no stroke and matches the chart
// background (white), so it reads as if the arrow naturally stops at the
// label edge and continues out the other side. Reused by drawBarMeta and
// drawMilestoneLabels. Caller must have already appended the text element
// to the group — we use getBBox to measure the actual rendered glyph box.
// Shared canvas 2D context for text measurement. Created lazily.
// Canvas measureText is the most reliable way to get text widths in CSS
// pixels — it works directly off the browser's font metrics, doesn't
// require the element to be in the DOM or laid out, and returns
// synchronously. Used by drawBarMeta to size the meta/name labels before
// deciding the cascade step.
let _metaCanvasCtx = null;
function ensureMetaCanvasCtx() {
  if (!_metaCanvasCtx) {
    const c = document.createElement('canvas');
    _metaCanvasCtx = c.getContext('2d');
  }
  return _metaCanvasCtx;
}

function addPillOccluder(parent, textEl, pad = 2) {
  try {
    const bbox = textEl.getBBox();
    if (!bbox || bbox.width <= 0) return;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', bbox.x - pad);
    rect.setAttribute('y', bbox.y - pad);
    rect.setAttribute('width',  bbox.width + pad * 2);
    rect.setAttribute('height', bbox.height + pad * 2);
    rect.setAttribute('fill', 'white');
    rect.setAttribute('stroke', 'none');
    rect.setAttribute('rx', '2');
    rect.style.pointerEvents = 'none';
    parent.insertBefore(rect, textEl);
  } catch (_) { /* getBBox can throw if not laid out; safe to skip */ }
}

function parsePredecessor(s) {
  // Accepts "5", "5FS", "5FF -2w", "5SS +1d", "5SF -3w" etc.
  // Returns { id, type: 'FS'|'SS'|'FF'|'SF', lagDays: number } or null
  const m = String(s).trim().match(/^(\d+)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+)\s*([wd])?$|^(\d+)\s*(FS|SS|FF|SF)?$/i);
  if (!m) return null;
  const id = Number(m[1] || m[5]);
  const type = (m[2] || m[6] || 'FS').toUpperCase();
  let lagDays = 0;
  if (m[3]) {
    const n = Number(m[3].replace(/\s+/g, ''));
    lagDays = (m[4] || 'd').toLowerCase() === 'w' ? n * 7 : n;
  }
  return { id, type, lagDays };
}

// Compute the SVG path for one predecessor arrow.
//
// Rules (per ARROW_ROUTING_RULES.md, simplified routing pass):
//   - Arrows render BEHIND bars/labels via z-order, so they may pass through bars; we
//     don't try to avoid them. Bars and labels paint on top.
//   - Path is at most TWO segments: either a single straight drop / horizontal, or an
//     L-shape (one corner). No U-routes, no corridors, no loops.
//   - Exit point on pred is whichever side keeps the path simplest:
//       * If the target entry x falls within pred's x range, exit STRAIGHT DOWN/UP from
//         pred's bottom/top edge at the target x.
//       * Otherwise, exit horizontally from pred's left/right side at center y.
//   - Final segment direction sets the arrowhead orientation (LEFT, RIGHT, UP, DOWN).
// v4.56: arrow head shrunk from 6 → 3 (half size) per user feedback —
// the previous head filled the whole vertical gap between adjacent rows
// at default row heights, which looked clunky. Now it's a small marker
// that points without dominating.
const ARROW_DEFAULTS = { headSize: 3 };
function computeArrowPath(pred, succ, type, opts = {}) {
  const headSize = opts.headSize ?? ARROW_DEFAULTS.headSize;

  const predLeft  = pred.x;
  const predRight = pred.x + pred.w;
  const predTop   = pred.y;
  const predBot   = pred.y + pred.h;
  const succLeft  = succ.x;
  const succRight = succ.x + succ.w;
  const succTop   = succ.y;
  const succBot   = succ.y + succ.h;

  // Vertical relationship by row CENTER. Anything more than 1px difference is treated
  // as a different row — that catches consecutive-row pairs whose bars happen to overlap
  // by a pixel or two.
  const predCy = pred.y + pred.h / 2;
  const succCy = succ.y + succ.h / 2;
  const goingDown = succCy > predCy + 1;
  const goingUp   = succCy < predCy - 1;

  // ----- Pick entry point on succ -----
  // Milestone: entry x is the diamond center; y depends on direction (top/bottom vertex).
  // Bar: entry x defaults by type (FS/SS = left edge; FF/SF = right edge), but when pred
  // sits roughly above/below succ we override to enter from succ's TOP/BOTTOM edge so a
  // straight vertical drop lands cleanly on it.
  let entryX, entryY, headDir;
  if (succ.milestone) {
    entryX = succ.x + succ.w / 2;
    if (goingDown)      { entryY = succTop; headDir = 'DOWN'; }
    else if (goingUp)   { entryY = succBot; headDir = 'UP'; }
    else if (predRight <= succLeft) { entryX = succLeft;  entryY = succ.y + succ.h / 2; headDir = 'RIGHT'; }
    else                            { entryX = succRight; entryY = succ.y + succ.h / 2; headDir = 'LEFT'; }
  } else {
    const enterFromLeft = type === 'FS' || type === 'SS';
    const sideEntryX = enterFromLeft ? succLeft : succRight;
    if (goingDown) {
      entryY = succTop; headDir = 'DOWN';
      // Land just inside the bar on the FS/SS-near side, so the arrowhead nests on succ
      // rather than at the very edge.
      entryX = enterFromLeft
        ? Math.min(sideEntryX + 4, succRight - 2)
        : Math.max(sideEntryX - 4, succLeft + 2);
    } else if (goingUp) {
      entryY = succBot; headDir = 'UP';
      entryX = enterFromLeft
        ? Math.min(sideEntryX + 4, succRight - 2)
        : Math.max(sideEntryX - 4, succLeft + 2);
    } else {
      // Same row — approach from the side, final segment horizontal.
      entryX = sideEntryX;
      entryY = succ.y + succ.h / 2;
      headDir = enterFromLeft ? 'RIGHT' : 'LEFT';
    }
  }

  // ----- Pick exit point on pred -----
  let exitX, exitY;
  if (pred.milestone) {
    if (goingDown)    { exitX = pred.x + pred.w / 2; exitY = predBot; }
    else if (goingUp) { exitX = pred.x + pred.w / 2; exitY = predTop; }
    else if (entryX > pred.x + pred.w / 2) { exitX = predRight; exitY = pred.y + pred.h / 2; }
    else                                    { exitX = predLeft;  exitY = pred.y + pred.h / 2; }
  } else {
    if (goingDown || goingUp) {
      // Straight drop possible if entryX is within pred's x range — exit through the
      // top/bottom edge at entryX. Otherwise exit from the side closest to entryX.
      if (entryX >= predLeft && entryX <= predRight) {
        exitX = entryX;
        exitY = goingDown ? predBot : predTop;
      } else {
        exitX = entryX > predRight ? predRight : predLeft;
        exitY = pred.y + pred.h / 2;
      }
    } else {
      // Same row — exit horizontal from the side.
      const exitingRight = type === 'FS' || type === 'FF';
      exitX = exitingRight ? predRight : predLeft;
      exitY = pred.y + pred.h / 2;
    }
  }

  // Stagger when this pred has multiple successors exiting from the same SIDE edge so
  // their horizontals don't all sit at center y. Straight drops naturally don't overlap
  // (each at its own succ's entryX) so they don't need staggering.
  const total = opts.outgoingTotal || 1;
  const idx   = opts.outgoingIdx   || 0;
  const exitOnSide = !pred.milestone && exitY === pred.y + pred.h / 2 && (exitX === predLeft || exitX === predRight);
  if (exitOnSide && total > 1) {
    const slot = (pred.h * (idx + 1)) / (total + 1);
    exitY = predTop + slot;
  }

  // ----- Build the path: 1 segment if aligned, else L-shape (2 segments) -----
  // Pull the line endpoint back by headSize so the arrowhead's tip lands exactly on
  // the chosen entry point.
  const adj = (() => {
    if (headDir === 'DOWN')  return { x: entryX, y: entryY - headSize };
    if (headDir === 'UP')    return { x: entryX, y: entryY + headSize };
    if (headDir === 'RIGHT') return { x: entryX - headSize, y: entryY };
    return                          { x: entryX + headSize, y: entryY }; // LEFT
  })();

  let linePath;
  // labelAnchor: where a lag label (e.g., "+2 wks") should sit on the arrow.
  // For single-segment arrows it's the midpoint. For L-shape arrows we pick
  // the midpoint of the LONGER segment so the label sits on the visually
  // dominant leg of the route, which is usually the most readable spot.
  let labelAnchor;
  if (Math.abs(exitX - adj.x) < 0.5) {
    linePath = `M ${exitX} ${exitY} L ${exitX} ${adj.y}`;
    labelAnchor = { x: exitX, y: (exitY + adj.y) / 2 };
  } else if (Math.abs(exitY - adj.y) < 0.5) {
    linePath = `M ${exitX} ${exitY} L ${adj.x} ${exitY}`;
    labelAnchor = { x: (exitX + adj.x) / 2, y: exitY };
  } else if (headDir === 'DOWN' || headDir === 'UP') {
    // Final segment is vertical → corner at (entryX, exitY): horizontal then vertical.
    linePath = `M ${exitX} ${exitY} L ${entryX} ${exitY} L ${entryX} ${adj.y}`;
    const horizLen = Math.abs(entryX - exitX);
    const vertLen  = Math.abs(adj.y - exitY);
    labelAnchor = horizLen >= vertLen
      ? { x: (exitX + entryX) / 2, y: exitY }
      : { x: entryX, y: (exitY + adj.y) / 2 };
  } else {
    // Final segment is horizontal → corner at (exitX, entryY): vertical then horizontal.
    linePath = `M ${exitX} ${exitY} L ${exitX} ${entryY} L ${adj.x} ${entryY}`;
    const vertLen  = Math.abs(entryY - exitY);
    const horizLen = Math.abs(adj.x - exitX);
    labelAnchor = vertLen >= horizLen
      ? { x: exitX, y: (exitY + entryY) / 2 }
      : { x: (exitX + adj.x) / 2, y: entryY };
  }

  // ----- Arrowhead -----
  const t = headSize * 0.7;
  let headPath;
  if (headDir === 'DOWN') {
    headPath = `M ${entryX} ${entryY} L ${entryX - t} ${entryY - headSize} L ${entryX + t} ${entryY - headSize} Z`;
  } else if (headDir === 'UP') {
    headPath = `M ${entryX} ${entryY} L ${entryX - t} ${entryY + headSize} L ${entryX + t} ${entryY + headSize} Z`;
  } else if (headDir === 'RIGHT') {
    headPath = `M ${entryX} ${entryY} L ${entryX - headSize} ${entryY - t} L ${entryX - headSize} ${entryY + t} Z`;
  } else {
    headPath = `M ${entryX} ${entryY} L ${entryX + headSize} ${entryY - t} L ${entryX + headSize} ${entryY + t} Z`;
  }

  return { linePath, headPath, labelAnchor };
}

function drawCustomArrows() {
  const svg = document.querySelector('#gantt-container .gantt');
  if (!svg) return;

  // Clean any previous frappe-gantt arrows and our group from prior renders.
  svg.querySelectorAll(':scope > .arrow').forEach(el => el.remove());
  let group = svg.querySelector('.sdc-arrows');
  if (group) group.remove();
  group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'sdc-arrows');
  // Insert BEFORE the first bar-wrapper so arrows render BEHIND bars and labels
  // (z-order: later siblings paint on top in SVG). frappe-gantt nests the bar-wrappers
  // inside a parent <g>, so we attach to that parent — not the SVG root.
  const firstBar = svg.querySelector('.bar-wrapper');
  if (firstBar && firstBar.parentNode) firstBar.parentNode.insertBefore(group, firstBar);
  else svg.appendChild(group);

  // Index every bar's geometry. Milestones use the DIAMOND bbox so arrows
  // terminate at the visible outer edge, not the underlying bar-wrapper rect.
  // Anchor diamonds have an OUTER RING ~75% larger than the inner — arrows
  // must terminate at that outer edge, otherwise they pierce the ring.
  const taskById = Object.fromEntries(state.tasks.map(t => [String(t.id), t]));
  const bars = [...svg.querySelectorAll('.bar-wrapper')].map(w => {
    const rect = w.querySelector('.bar');
    const id = String(w.getAttribute('data-id'));
    const x = +rect.getAttribute('x');
    const y = +rect.getAttribute('y');
    const ww = +rect.getAttribute('width');
    const hh = +rect.getAttribute('height');
    const task = taskById[id];
    if (task?.is_milestone) {
      const cx = x + ww / 2;
      const cy = y + hh / 2;
      // Anchor outer ring and non-anchor diamond both have outer radius
      // diamondRef × 1.20 / 2 (v4.23 hotfix: decoupled from h). Arrows
      // terminate at this exact boundary so they don't pierce or miss the
      // diamond now that the diamond is smaller than the bar height.
      const diamondRef = Math.max(BAR_H_MIN, Math.round(state.layout.rowHeight * 0.5));
      const r = diamondRef * 1.20 / 2;
      return { id, x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, milestone: true };
    }
    return { id, x, y, w: ww, h: hh, milestone: false };
  });
  const barById = Object.fromEntries(bars.map(b => [b.id, b]));

  const arrowColor = '#334155';
  const headSize = 3; // v4.56: half size (was 6)

  // Build the job list, then group by pred + direction so successors leaving the same
  // side of one pred can stagger their exit y values.
  const arrowJobs = [];
  // Lag-label rendering deferred to a second pass after all arrows are drawn —
  // see end of this function. Collecting jobs here avoids a per-arrow forward
  // declaration.
  const lagLabelJobs = [];
  for (const task of state.tasks) {
    if (!task.predecessors) continue;
    const succ = barById[String(task.id)];
    if (!succ) continue;
    const preds = String(task.predecessors).split(',').map(s => s.trim()).filter(Boolean);
    for (const raw of preds) {
      const parsed = parsePredecessor(raw);
      if (!parsed) continue;
      const pred = barById[String(parsed.id)];
      if (!pred) continue;
      arrowJobs.push({ pred, succ, parsed });
    }
  }

  const groups = new Map();
  for (const job of arrowJobs) {
    const dir = job.succ.y > job.pred.y ? 'down' : 'up';
    const key = String(job.pred.id) + '_' + dir;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  for (const [, group] of groups) {
    // Closest-succ-first: nearest succ takes the most-direct slot.
    group.sort((a, b) => Math.abs(a.succ.y - a.pred.y) - Math.abs(b.succ.y - b.pred.y));
    group.forEach((job, i) => {
      job.outgoingIdx = i;
      job.outgoingTotal = group.length;
    });
  }

  for (const job of arrowJobs) {
    const { linePath, headPath, labelAnchor } = computeArrowPath(job.pred, job.succ, job.parsed.type, {
      headSize,
      outgoingIdx: job.outgoingIdx,
      outgoingTotal: job.outgoingTotal,
    });

    // Arrow color: deep red and bolder ONLY when BOTH endpoints sit on the
    // critical path. That's what makes the segment actually part of the chain —
    // an arrow leaving a critical task to a non-critical successor isn't critical
    // (the successor has slack). Read directly from the bar-wrappers' class so
    // we share the exact source of truth that's already painting the bars red.
    const predEl = svg.querySelector(`.bar-wrapper[data-id="${String(job.pred.id)}"]`);
    const succEl = svg.querySelector(`.bar-wrapper[data-id="${String(job.succ.id)}"]`);
    const onCritical = !!(predEl && predEl.classList.contains('on-critical')
                       && succEl && succEl.classList.contains('on-critical'));

    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', linePath);
    line.setAttribute('class', 'arrow' + (onCritical ? ' on-critical' : ''));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', onCritical ? '#b91c1c' : arrowColor);
    line.setAttribute('stroke-width', onCritical ? '3' : '1.4');
    line.setAttribute('stroke-linecap', 'square');
    line.setAttribute('stroke-linejoin', 'miter');
    if (onCritical) line.setAttribute('data-on-critical', '1');
    group.appendChild(line);

    const head = document.createElementNS(SVG_NS, 'path');
    head.setAttribute('d', headPath);
    head.setAttribute('class', 'arrow' + (onCritical ? ' on-critical' : ''));
    head.setAttribute('fill', onCritical ? '#b91c1c' : arrowColor);
    if (onCritical) head.setAttribute('data-on-critical', '1');
    group.appendChild(head);

    // Collect lag-label data for this arrow if it carries a non-zero lag and
    // the user has lag labels enabled. We render labels AFTER all arrows are
    // drawn, in a separate group on top of bars, so they don't get covered.
    const lagDays = Number(job.parsed.lagDays) || 0;
    if (state.scheduleView?.showArrowLags !== false && Math.abs(lagDays) >= 7 && labelAnchor) {
      const wks = Math.round(lagDays / 7);
      if (wks !== 0) {
        lagLabelJobs.push({
          job,
          wks,
          onCritical,
          anchor: { x: labelAnchor.x, y: labelAnchor.y },
        });
      }
    }
  }

  // ----- Render lag labels in a separate group ABOVE bars -----
  // Two reasons to render here, after the arrows loop, rather than inline:
  //   1. Z-order: the .sdc-arrows group sits BEHIND bars on purpose (so
  //      arrows duck under bars when routes overlap). Lag labels need to sit
  //      ABOVE bars so the user can read them — bars covered the labels
  //      otherwise (user feedback: "−2 weeks from designer view is underneath
  //      mechanical design").
  //   2. Overlap avoidance: once we have ALL label positions, we can detect
  //      colliding labels and shift them along the segment so they don't sit
  //      directly on top of each other (user feedback: "robot vision and
  //      robot programming labels are on top of each other").
  if (lagLabelJobs.length > 0) renderArrowLagLabels(svg, lagLabelJobs);
}

// Render the lag labels for every arrow that has a non-zero lag, in a group
// that paints ABOVE bars (so labels are always visible). Also runs an
// overlap-resolution pass: any label whose pill bbox would collide with a
// previously-placed label gets shifted vertically by one pill-height (with a
// small gap) until it no longer collides. We keep the original anchor.x so
// the label still reads as belonging to its arrow segment.
function renderArrowLagLabels(svg, jobs) {
  // Tear down any previous labels group so we start clean each render.
  svg.querySelectorAll(':scope > .sdc-arrow-labels').forEach(el => el.remove());
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'sdc-arrow-labels');
  // Append AT THE END of the SVG's children so we paint over bars/labels.
  svg.appendChild(group);

  // Precompute the placed bboxes so we can avoid overlap as we lay each one
  // out. Pills are roughly the same size, so a simple AABB collision check
  // is enough.
  const placed = [];
  const PILL_H = 14;
  const GAP    = 2;
  const overlaps = (a, b) =>
    !(a.x + a.w + GAP <= b.x || b.x + b.w + GAP <= a.x ||
      a.y + a.h + GAP <= b.y || b.y + b.h + GAP <= a.y);

  for (const { job, wks, onCritical, anchor } of jobs) {
    const labelText = (wks > 0 ? '+' : '−') + Math.abs(wks) + ' wk' + (Math.abs(wks) === 1 ? '' : 's');
    const pillW = labelText.length * 6 + 10;

    // Shift the label vertically until it no longer collides with any
    // previously-placed pill. Max ~10 shifts (so a worst-case label still
    // lands within a couple of rows of its anchor). Alternate up/down to
    // keep the label as close to its arrow as possible.
    let cy = anchor.y;
    for (let attempt = 0; attempt < 12; attempt++) {
      const candX = anchor.x - pillW / 2;
      const candY = cy - PILL_H / 2;
      const cand = { x: candX, y: candY, w: pillW, h: PILL_H };
      const hit = placed.some(p => overlaps(cand, p));
      if (!hit) {
        // Place here.
        placePill({
          group, job, wks, onCritical, labelText, pillW,
          x: anchor.x, y: cy,
        });
        placed.push(cand);
        break;
      }
      // Try one slot up, then one slot down, expanding outward.
      const slot = Math.ceil((attempt + 1) / 2);
      const dir  = attempt % 2 === 0 ? -1 : 1;
      cy = anchor.y + dir * slot * (PILL_H + GAP);
    }
  }
}

// Actually paint one pill + text into the labels group, with a click handler
// that opens the inline lag editor.
function placePill({ group, job, wks, onCritical, labelText, pillW, x, y }) {
  const pillH = 14;
  const pill = document.createElementNS(SVG_NS, 'rect');
  pill.setAttribute('x', x - pillW / 2);
  pill.setAttribute('y', y - pillH / 2);
  pill.setAttribute('width',  pillW);
  pill.setAttribute('height', pillH);
  pill.setAttribute('rx', 3);
  pill.setAttribute('ry', 3);
  pill.setAttribute('class', 'arrow-lag-pill');
  pill.setAttribute('fill', '#ffffff');
  pill.setAttribute('stroke', onCritical ? '#b91c1c' : '#475569');
  pill.setAttribute('stroke-width', '1');
  pill.style.cursor = 'pointer';
  pill.dataset.taskId = String(job.succ.id);
  pill.dataset.predIdx = String(job.parsed.id);
  group.appendChild(pill);

  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('x', x);
  label.setAttribute('y', y);
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('dominant-baseline', 'central');
  label.setAttribute('font-size', '10');
  label.setAttribute('font-weight', '700');
  label.setAttribute('fill', onCritical ? '#b91c1c' : '#1e293b');
  label.setAttribute('class', 'arrow-lag-label');
  label.style.pointerEvents = 'none';
  label.textContent = labelText;
  group.appendChild(label);

  pill.addEventListener('click', (ev) => {
    ev.stopPropagation();
    editArrowLag({
      taskId: Number(job.succ.id),
      predId: Number(job.parsed.id),
      currentWks: wks,
      clientX: ev.clientX,
      clientY: ev.clientY,
    });
  });
}

// Inline editor for an arrow lag. Pops a tiny number input near the click point,
// reads a new weeks value, rewrites the predecessor string on the successor task,
// and reloads. Empty input or "0" removes the lag entirely (predecessor becomes
// the base form like "5FS").
function editArrowLag({ taskId, predId, currentWks, clientX, clientY }) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  // Tear down any previous editor.
  document.getElementById('arrow-lag-edit')?.remove();
  const box = document.createElement('div');
  box.id = 'arrow-lag-edit';
  box.className = 'arrow-lag-edit';
  box.innerHTML = `
    <label>Lag (wks)</label>
    <input type="number" step="1" value="${currentWks}" />
    <button type="button" class="confirm-popup-cancel">Cancel</button>
    <button type="button" class="confirm-popup-ok">Save</button>
  `;
  document.body.appendChild(box);
  const w = box.offsetWidth || 220;
  const h = box.offsetHeight || 56;
  box.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, clientX - w / 2)) + 'px';
  box.style.top  = Math.min(window.innerHeight - h - 8, Math.max(8, clientY + 12)) + 'px';
  const input = box.querySelector('input');
  input.focus();
  input.select();

  const close = () => {
    box.remove();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const save = async () => {
    const v = input.value.trim();
    const newWks = v === '' ? 0 : Math.round(Number(v));
    if (!Number.isFinite(newWks)) { close(); return; }
    // Rewrite the predecessor segment that points at predId. Preserve the
    // FS/SS/FF/SF type; replace any existing [+-]Nw/d lag suffix with the
    // new weeks value (or remove the suffix entirely when newWks === 0).
    const parts = String(task.predecessors || '').split(',').map(s => s.trim()).filter(Boolean);
    let changed = false;
    const updated = parts.map(p => {
      const m = p.match(/^(\d+)(FS|SS|FF|SF)?(\s*[+-]\s*\d+\s*[wd]?)?$/i);
      if (!m) return p;
      if (Number(m[1]) !== predId) return p;
      changed = true;
      const id = m[1];
      const type = (m[2] || 'FS').toUpperCase();
      if (newWks === 0) return `${id}${type}`;
      const sign = newWks > 0 ? '+' : '-';
      return `${id}${type} ${sign}${Math.abs(newWks)}w`;
    });
    close();
    if (!changed) return;
    pushUndoSnapshot(task, ['predecessors'], `Edit lag on "${task.name || 'task'}"`);
    await api.update(taskId, { predecessors: updated.join(', ') });
    await loadTasks();
  };
  const onOutside = (ev) => { if (!box.contains(ev.target)) close(); };
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); save(); }
  };
  box.querySelector('.confirm-popup-cancel').addEventListener('click', close);
  box.querySelector('.confirm-popup-ok').addEventListener('click', save);
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}


// ---------- Filter controls ----------
function renderFilters() {
  // Datalists for any free-text inputs elsewhere that autocomplete from current data.
  const projects = uniqueValues('project');
  document.getElementById('dl-projects').innerHTML = projects.map(p => `<option value="${escapeHtml(p)}">`).join('');
  document.getElementById('dl-assignees').innerHTML = uniqueValues('assignee').map(a => `<option value="${escapeHtml(a)}">`).join('');

  const qf = state.filters.quick || {};
  // Active-filter chip count next to the topbar button. Counts every active quick
  // chip so the user sees at a glance how many filters are on.
  const activeCount = Object.values(qf).filter(Boolean).length;
  const chip = document.getElementById('filter-chip-count');
  if (chip) {
    chip.textContent = activeCount ? String(activeCount) : '';
    chip.hidden = activeCount === 0;
  }

  const pop = document.getElementById('filters-popover');
  if (!pop) return;
  // Quick-chip filters — single-click toggles that focus the schedule on a state
  // ("behind", "ahead", "milestones only", etc.). Anchors AND non-anchor
  // milestones are always exempt so the schedule spine stays visible
  // regardless of which chips are on.
  //
  // Critical Path lives here too (alongside other quick filters):
  //   - "Critical path"     = highlight mode (red bars + arrows on the chain)
  //   - "Critical path only" = filter mode (hide everything not on the chain;
  //                             auto-enables highlight too).
  const sv = state.scheduleView || {};
  const chipDefs = [
    { key: 'showCompleted', label: 'Show completed',    source: 'quick' },
    { key: 'behind',        label: 'Behind schedule',   source: 'quick' },
    { key: 'ahead',         label: 'Ahead of schedule', source: 'quick' },
    { key: 'milestones',    label: 'Milestones only',   source: 'quick' },
    { key: 'assigned',      label: 'Assigned (real work)', source: 'quick' },
    { key: 'overallocated', label: 'Over-allocated',    source: 'quick' },
    { key: 'criticalPath',  label: 'Critical path',     source: 'view',  active: !!sv.criticalPath },
    { key: 'criticalOnly',  label: 'Critical path only', source: 'view', active: !!sv.criticalOnly },
  ];
  // v4.54: Filters popover uses CHECKBOXES (not pills). Each filter is a
  // row with checkbox + label. Easier to scan as a list. For Customer mode
  // is just another checkbox in the same list under a VIEW section.
  const inCustomerView = document.body.classList.contains('customer-view');
  pop.innerHTML = `
    <div class="filters-popover-title">Quick filters</div>
    <div class="filters-check-list">
      ${chipDefs.map(c => {
        const active = c.source === 'view' ? !!c.active : !!qf[c.key];
        return `
          <label class="filters-check-row">
            <input type="checkbox" data-quick="${c.key}" data-source="${c.source}" ${active ? 'checked' : ''}>
            <span>${escapeHtml(c.label)}</span>
          </label>
        `;
      }).join('')}
    </div>
    <div class="filters-popover-sep"></div>
    <div class="filters-popover-title">View</div>
    <label class="filters-check-row">
      <input type="checkbox" id="filters-customer-view-toggle" ${inCustomerView ? 'checked' : ''}>
      <span>For Customer mode</span>
    </label>
    <div class="filters-popover-actions">
      <button type="button" id="btn-clear-filters" class="btn-ghost btn-tight">Clear all</button>
    </div>
  `;
  // Stop propagation on every click inside the popover so the document-level
  // close handler doesn't see "click outside" and dismiss the popover. Users
  // want to toggle multiple filters in one session without re-opening.
  pop.querySelectorAll('input[type="checkbox"][data-quick]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const k = cb.dataset.quick;
      const src = cb.dataset.source;
      if (src === 'view' && k === 'criticalPath') {
        const turningOff = state.scheduleView.criticalPath;
        state.scheduleView.criticalPath = !turningOff;
        if (turningOff) state.scheduleView.criticalOnly = false;
        saveScheduleView();
        applyScheduleView();
      } else if (src === 'view' && k === 'criticalOnly') {
        const turningOn = !state.scheduleView.criticalOnly;
        state.scheduleView.criticalOnly = turningOn;
        if (turningOn) state.scheduleView.criticalPath = true;
        saveScheduleView();
        applyScheduleView();
      } else {
        if (!state.filters.quick) state.filters.quick = {};
        state.filters.quick[k] = !state.filters.quick[k];
      }
      render();
    });
  });
  // Stop propagation on label clicks so the popover doesn't auto-close.
  pop.querySelectorAll('.filters-check-row').forEach(row => {
    row.addEventListener('click', (e) => e.stopPropagation());
  });
  pop.querySelector('#btn-clear-filters').addEventListener('click', (e) => {
    e.stopPropagation();
    state.filters.quick = { behind: false, ahead: false, milestones: false, assigned: false, overallocated: false, showCompleted: false };
    // Also clear Critical path since it lives among quick filters now.
    state.scheduleView.criticalPath = false;
    state.scheduleView.criticalOnly = false;
    saveScheduleView();
    applyScheduleView();
    render();
  });
  // v4.51: For Customer mode toggle (moved out of toolbar into Filters).
  // Drives the existing enterCustomerView / exitCustomerView flow so the
  // flatten + zoom-to-fit side effects still fire. Falls back to a no-op
  // alert if no project is selected (the customer view is per-project).
  const cvToggle = pop.querySelector('#filters-customer-view-toggle');
  if (cvToggle) {
    cvToggle.addEventListener('change', (e) => {
      e.stopPropagation();
      if (cvToggle.checked) {
        if (!state.filters.project) {
          cvToggle.checked = false;
          showAlertDialog('Pick a project tab first — customer view is per-project.');
          return;
        }
        enterCustomerView();
      } else {
        exitCustomerView();
      }
    });
  }
}

// ---------- Project tabs (open schedules) ----------
// Open projects persist in localStorage so reloads remember them. The empty string ""
// is the canonical "All projects" pseudo-tab — always present, can't be closed. Switching
// tabs sets state.filters.project which the existing applyFilters honors.
function loadProjectTabs() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('sdcOpenProjects') || 'null'); } catch {}
  if (Array.isArray(saved) && saved.length) {
    state.openProjects = saved.includes('') ? saved : ['', ...saved];
  } else {
    // First-time seed: show All + every project that already has tasks. After this we
    // never auto-modify; the user explicitly opens/closes from the picker.
    const existing = uniqueValues('project');
    state.openProjects = ['', ...existing];
  }
  const savedActive = localStorage.getItem('sdcActiveProject');
  state.filters.project = (savedActive != null && state.openProjects.includes(savedActive))
    ? savedActive : '';
  let savedTemplates = [];
  try { savedTemplates = JSON.parse(localStorage.getItem('sdcTemplateProjects') || '[]'); } catch {}
  state.templateProjects = Array.isArray(savedTemplates) ? savedTemplates : [];
  let savedWorkspaces = {};
  try { savedWorkspaces = JSON.parse(localStorage.getItem('sdcProjectWorkspaces') || '{}'); } catch {}
  state.projectWorkspaces = (savedWorkspaces && typeof savedWorkspaces === 'object') ? savedWorkspaces : {};
  const savedActiveWs = localStorage.getItem('sdcActiveWorkspace');
  state.activeWorkspace = (savedActiveWs && ['Active', 'Sales', 'Closed'].includes(savedActiveWs)) ? savedActiveWs : 'Active';
  // Projects-page expanded sections (per workspace). Defaults to all
  // collapsed; user clicks a header to expand.
  let savedExpanded = {};
  try { savedExpanded = JSON.parse(localStorage.getItem('sdcProjectsExpanded') || '{}'); } catch {}
  state._projectsExpanded = (savedExpanded && typeof savedExpanded === 'object') ? savedExpanded : {};
  // Favorites + Recents are per-browser localStorage lists of project names.
  let favs = [];
  try { favs = JSON.parse(localStorage.getItem('sdcFavoriteProjects') || '[]'); } catch {}
  state.favoriteProjects = Array.isArray(favs) ? favs : [];
  let recents = [];
  try { recents = JSON.parse(localStorage.getItem('sdcRecentProjects') || '[]'); } catch {}
  state.recentProjects = Array.isArray(recents) ? recents.slice(0, 10) : [];
  // If the active project belongs to a different workspace than the saved
  // active workspace, sync the workspace to the project. Otherwise the user
  // would load into a workspace where their last-viewed project doesn't appear.
  if (state.filters.project) {
    const ws = projectWorkspace(state.filters.project);
    if (ws !== state.activeWorkspace) state.activeWorkspace = ws;
  }
}

function saveProjectTabs() {
  localStorage.setItem('sdcOpenProjects', JSON.stringify(state.openProjects));
  localStorage.setItem('sdcActiveProject', state.filters.project || '');
  localStorage.setItem('sdcTemplateProjects', JSON.stringify(state.templateProjects || []));
  localStorage.setItem('sdcProjectWorkspaces', JSON.stringify(state.projectWorkspaces || {}));
  localStorage.setItem('sdcActiveWorkspace', state.activeWorkspace || 'Active');
  localStorage.setItem('sdcFavoriteProjects', JSON.stringify(state.favoriteProjects || []));
  localStorage.setItem('sdcRecentProjects',   JSON.stringify(state.recentProjects   || []));
}

// Toggle a project's favorite flag. Updates state + localStorage + refreshes
// any open Projects / Favorites / Recents page so the UI reflects the change.
function toggleFavoriteProject(name) {
  if (!name) return;
  const i = state.favoriteProjects.indexOf(name);
  if (i >= 0) state.favoriteProjects.splice(i, 1);
  else        state.favoriteProjects.unshift(name);
  saveProjectTabs();
  // Re-render whichever view is showing so the star flips immediately.
  if (state.view === 'projects')  renderProjectsPage();
  if (state.view === 'favorites') renderFavoritesPage();
  if (state.view === 'recents')   renderRecentsPage();
}

// Record a project open in the Recents list. Newest-first, deduped, capped at 10.
function recordRecentProject(name) {
  if (!name) return;
  state.recentProjects = [name, ...(state.recentProjects || []).filter(p => p !== name)].slice(0, 10);
  saveProjectTabs();
}

function isTemplateProject(p) {
  return !!p && Array.isArray(state.templateProjects) && state.templateProjects.includes(p);
}

// Fixed list of workspaces for v4.7. Order here is also the display order in
// the picker. Adding a new workspace just means dropping its name into this
// array — assignments live in state.projectWorkspaces keyed by project name.
const WORKSPACES = ['Active', 'Sales', 'Closed'];
const DEFAULT_WORKSPACE = 'Active';

// Get the workspace a project belongs to. Falls back to the default for any
// project that hasn't been explicitly assigned (i.e. everything from before
// v4.7 is in "Active").
function projectWorkspace(p) {
  if (!p) return DEFAULT_WORKSPACE;
  const ws = state.projectWorkspaces?.[p];
  if (WORKSPACES.includes(ws)) return ws;
  // Auto-detect workspace from project name when nothing's explicitly set.
  // Keeps the SDC_Sales_Template (and any other *sales* / *closed* schedule)
  // in the right workspace on first load without requiring manual right-click
  // assignment per browser. The user can still override via right-click →
  // Workspace: ___; that explicit choice persists in state.projectWorkspaces.
  const lower = String(p).toLowerCase();
  if (/\bsales?\b|_sales/.test(lower))  return 'Sales';
  if (/\bclosed\b|_closed|_archive/.test(lower)) return 'Closed';
  return DEFAULT_WORKSPACE;
}

// True iff the task lives in a Sales-workspace project. Used by the grid to
// SUPPRESS the allocation pill, allocation column, and assignee column for
// Sales schedules (per v4.22): Sales work is pre-quote, so showing "85% × 4
// engineers" or "ME Placeholder" surfaces detail the customer / sales rep
// doesn't need and risks accidentally communicating commitments. Anything
// auto-detected as Sales (name match) OR explicitly assigned via right-click
// → Workspace: Sales gets the suppression.
function isSalesProjectTask(t) {
  if (!t || !t.project) return false;
  return projectWorkspace(t.project) === 'Sales';
}

function setProjectWorkspace(p, workspace) {
  if (!p) return;
  if (!WORKSPACES.includes(workspace)) return;
  state.projectWorkspaces = state.projectWorkspaces || {};
  if (workspace === DEFAULT_WORKSPACE) {
    // Keep the map clean — default-workspace projects don\'t need an entry.
    delete state.projectWorkspaces[p];
  } else {
    state.projectWorkspaces[p] = workspace;
  }
  saveProjectTabs();
}

// Has the given project had a baseline set? "Set" = at least one task carries
// baseline_start_date. Used by the Baseline toolbar buttons to label the left
// half "Set baseline" vs "Reset baseline" and to enable/disable the visibility
// toggle on the right half.
function projectHasBaseline(p) {
  if (!p) return false;
  return state.tasks.some(t => t.project === p && t.baseline_start_date);
}

// Refresh the Baseline dropdown button's label + tooltip to reflect the active
// project's baseline state. The button shows the overall state at a glance;
// clicking opens a dropdown with the specific actions (Turn on / Reset / Show
// or Hide / Turn off).
function syncBaselineButtons() {
  const btn = document.getElementById('btn-baseline-menu');
  if (!btn) return;
  const project = state.filters.project;
  const has = projectHasBaseline(project);
  // Compact label keeps the button width consistent regardless of state — the
  // is-active highlight tells you whether the overlay is currently visible.
  btn.textContent = '◎ Baseline ▾';
  btn.classList.toggle('is-active', !!state.showBaseline);
  btn.disabled = !project;
  btn.title = !project
    ? 'Open a specific project tab first — baselines are per-project.'
    : (has
        ? (state.showBaseline
            ? `Baseline is ON (overlay visible). Click for actions: Reset / Hide / Turn off.`
            : `Baseline is set but HIDDEN. Click for actions: Show / Reset / Turn off.`)
        : `No baseline set for "${project}". Click to turn one on.`);
}

// Projects landing page — full-page view that the user navigates to by
// clicking the Projects icon in the left sidebar. Single column with each
// workspace as a collapsible section; click the header row to expand /
// collapse. Project rows inside each section open as a tab on click.
// "+ New schedule" button per workspace (disabled for Closed).
function renderProjectsPage() {
  const root = document.getElementById('projects-page');
  if (!root) return;
  const all = uniqueValues('project');
  const openSet = new Set(state.openProjects);
  const byWs = Object.fromEntries(WORKSPACES.map(ws => [ws, []]));
  for (const p of all) byWs[projectWorkspace(p)].push(p);
  for (const ws of WORKSPACES) {
    byWs[ws].sort((a, b) => {
      const ta = isTemplateProject(a) ? 0 : 1;
      const tb = isTemplateProject(b) ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return a.localeCompare(b);
    });
  }
  const expanded = state._projectsExpanded || (state._projectsExpanded = {});

  const favSet = new Set(state.favoriteProjects || []);
  // Row is a <div role="button"> — NOT a <button> — so the favorite ★ button
  // nested inside doesn't create invalid nested-button HTML (which Chrome
  // renders as block-level, breaking the row onto two lines).
  const rowHtml = (p, opts = {}) => {
    const isOpen = openSet.has(p);
    const isFav = favSet.has(p);
    const isTmpl = isTemplateProject(p);
    const star = isTmpl
      ? '<span class="projects-row-star" title="Template">★</span>'
      : '<span class="projects-row-star" style="visibility:hidden">★</span>';
    const favBtn = `<button class="projects-row-favbtn${isFav ? ' is-fav' : ''}" data-action="toggle-fav" data-project="${escapeHtml(p)}" type="button" title="${isFav ? 'Unfavorite' : 'Add to favorites'}">${isFav ? '★' : '☆'}</button>`;
    return `<div class="projects-row${isOpen ? ' is-open' : ''}${isTmpl ? ' is-template' : ''}" data-project="${escapeHtml(p)}" role="button" tabindex="0">
      ${star}<span class="projects-row-name">${escapeHtml(p)}</span>
      ${isOpen ? '<span class="projects-row-badge">open</span>' : ''}
      ${favBtn}
    </div>`;
  };
  const workspaceSection = (ws) => {
    const projects = byWs[ws];
    const templates = projects.filter(isTemplateProject);
    const nonTemplates = projects.filter(p => !isTemplateProject(p));
    const isExpanded = !!expanded[ws];
    const allowsNew = ws !== 'Closed';
    // Auto-pick the single template in this workspace for the "+ New" button.
    // Multi-template workspaces still fall back to the legacy picker.
    const wsTmpl = templates.length === 1 ? templates[0] : null;
    const newBtnLabel = wsTmpl ? `＋ New from ${escapeHtml(wsTmpl)}` : '＋ New schedule';
    return `
      <div class="projects-workspace${isExpanded ? ' is-expanded' : ''}" data-workspace="${escapeHtml(ws)}">
        <button class="projects-workspace-head" data-action="toggle" type="button">
          <span class="projects-workspace-caret">▶</span>
          <span class="projects-workspace-name">${escapeHtml(ws)}</span>
          <span class="projects-workspace-count">${projects.length}</span>
          <span class="projects-workspace-spacer"></span>
          <button class="projects-workspace-newbtn${allowsNew ? '' : ' is-disabled'}" data-action="new" data-workspace="${escapeHtml(ws)}" ${allowsNew ? '' : 'disabled title="Closed workspace — no new schedules allowed."'} type="button">${newBtnLabel}</button>
        </button>
        <div class="projects-workspace-body">
          ${templates.length > 0 ? `
            <div class="projects-templates-row">
              <div class="projects-templates-label">Templates</div>
              ${templates.map(rowHtml).join('')}
            </div>
          ` : ''}
          ${nonTemplates.length === 0 && templates.length === 0
            ? '<div class="projects-workspace-empty">No schedules in this workspace yet.</div>'
            : nonTemplates.length === 0
              ? '<div class="projects-workspace-empty">No schedules yet — use the "+ New" button to start one.</div>'
              : nonTemplates.map(rowHtml).join('')}
        </div>
      </div>
    `;
  };

  root.innerHTML = `
    <h1 class="projects-page-title">Projects</h1>
    <div class="projects-page-sub">${all.length} schedule${all.length === 1 ? '' : 's'} across ${WORKSPACES.length} workspaces</div>
    ${WORKSPACES.map(workspaceSection).join('')}
  `;

  // Toggle expand/collapse on the workspace header. The header is itself a
  // button; the inner "+ New schedule" button shouldn't trigger the toggle,
  // so we stop propagation on its click separately below.
  root.querySelectorAll('.projects-workspace-head').forEach(head => {
    head.addEventListener('click', (e) => {
      // Bail if the click was on the inner New-schedule button.
      if (e.target.closest('[data-action="new"]')) return;
      const wsDiv = head.closest('.projects-workspace');
      if (!wsDiv) return;
      const ws = wsDiv.dataset.workspace;
      expanded[ws] = !expanded[ws];
      wsDiv.classList.toggle('is-expanded', expanded[ws]);
      try { localStorage.setItem('sdcProjectsExpanded', JSON.stringify(expanded)); } catch {}
    });
  });
  root.querySelectorAll('.projects-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Star button intercept — toggles favorite, doesn't open the project.
      if (e.target.closest('[data-action="toggle-fav"]')) return;
      const p = row.dataset.project;
      if (!p) return;
      if (!state.openProjects.includes(p)) state.openProjects.push(p);
      state.filters.project = p;
      state.activeWorkspace = projectWorkspace(p);
      recordRecentProject(p);
      saveProjectTabs();
      setView('schedule');
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = row.dataset.project;
      if (!p) return;
      showProjectTabMenu(e.clientX, e.clientY, p);
    });
  });
  root.querySelectorAll('[data-action="new"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();  // don't toggle the section
      const ws = btn.dataset.workspace;
      if (!ws || ws === 'Closed') return;
      state.activeWorkspace = ws;
      saveProjectTabs();
      // If the workspace has EXACTLY ONE template, prompt for a name and clone
      // directly — no need to fight a dropdown. Other cases (no template,
      // multiple templates) fall back to the legacy picker which still has
      // estimate-sheet + Smartsheet flows.
      const wsTemplates = (state.templateProjects || []).filter(t =>
        state.tasks.some(x => x.project === t) && projectWorkspace(t) === ws
      );
      if (wsTemplates.length === 1) {
        const tmpl = wsTemplates[0];
        const name = prompt(`New ${ws} schedule from "${tmpl}":\n\nEnter the new project name.`);
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        if (state.tasks.some(t => t.project === trimmed)) {
          alert(`A project named "${trimmed}" already exists.`);
          return;
        }
        await duplicateProject(tmpl, trimmed);
        setProjectWorkspace(trimmed, ws);
        recordRecentProject(trimmed);
        saveProjectTabs();
        setView('schedule');
        return;
      }
      // 0 or >1 templates → fall back to the legacy picker.
      showProjectAddPicker();
    });
  });
  // Star toggle on each row (favorite / unfavorite).
  root.querySelectorAll('[data-action="toggle-fav"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = btn.dataset.project;
      if (p) toggleFavoriteProject(p);
    });
  });
}

// Favorites page — list of starred projects. Click to open like the Projects page.
function renderFavoritesPage() {
  const root = document.getElementById('favorites-page');
  if (!root) return;
  const favs = (state.favoriteProjects || []).filter(p => state.tasks.some(t => t.project === p));
  root.innerHTML = `
    <h1 class="projects-page-title">Favorites</h1>
    <div class="projects-page-sub">${favs.length} starred schedule${favs.length === 1 ? '' : 's'}</div>
    ${favs.length === 0
      ? '<p class="projects-page-empty">No favorites yet. Click the ☆ next to any schedule on the Projects page to star it.</p>'
      : `<div class="projects-workspace is-expanded"><div class="projects-workspace-body">${favs.map(p => {
          const isOpen = state.openProjects.includes(p);
          const isTmpl = isTemplateProject(p);
          return `<div class="projects-row${isOpen ? ' is-open' : ''}${isTmpl ? ' is-template' : ''}" data-project="${escapeHtml(p)}" role="button" tabindex="0">
            <span class="projects-row-star">${isTmpl ? '★' : ''}</span>
            <span class="projects-row-name">${escapeHtml(p)}</span>
            ${isOpen ? '<span class="projects-row-badge">open</span>' : ''}
            <button class="projects-row-favbtn is-fav" data-action="toggle-fav" data-project="${escapeHtml(p)}" type="button" title="Unfavorite">★</button>
          </div>`;
        }).join('')}</div></div>`}
  `;
  root.querySelectorAll('.projects-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="toggle-fav"]')) return;
      const p = row.dataset.project;
      if (!p) return;
      if (!state.openProjects.includes(p)) state.openProjects.push(p);
      state.filters.project = p;
      state.activeWorkspace = projectWorkspace(p);
      recordRecentProject(p);
      saveProjectTabs();
      setView('schedule');
    });
  });
  root.querySelectorAll('[data-action="toggle-fav"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = btn.dataset.project;
      if (p) toggleFavoriteProject(p);
    });
  });
}

// Recents page — last 10 opened projects, newest first.
function renderRecentsPage() {
  const root = document.getElementById('recents-page');
  if (!root) return;
  const recents = (state.recentProjects || []).filter(p => state.tasks.some(t => t.project === p));
  root.innerHTML = `
    <h1 class="projects-page-title">Recents</h1>
    <div class="projects-page-sub">Last ${recents.length} opened schedule${recents.length === 1 ? '' : 's'}</div>
    ${recents.length === 0
      ? '<p class="projects-page-empty">No recents yet. Open a schedule from the Projects page to start tracking.</p>'
      : `<div class="projects-workspace is-expanded"><div class="projects-workspace-body">${recents.map(p => {
          const isOpen = state.openProjects.includes(p);
          const isTmpl = isTemplateProject(p);
          const isFav = (state.favoriteProjects || []).includes(p);
          return `<div class="projects-row${isOpen ? ' is-open' : ''}${isTmpl ? ' is-template' : ''}" data-project="${escapeHtml(p)}" role="button" tabindex="0">
            <span class="projects-row-star">${isTmpl ? '★' : ''}</span>
            <span class="projects-row-name">${escapeHtml(p)}</span>
            ${isOpen ? '<span class="projects-row-badge">open</span>' : ''}
            <button class="projects-row-favbtn${isFav ? ' is-fav' : ''}" data-action="toggle-fav" data-project="${escapeHtml(p)}" type="button">${isFav ? '★' : '☆'}</button>
          </div>`;
        }).join('')}</div></div>`}
  `;
  root.querySelectorAll('.projects-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="toggle-fav"]')) return;
      const p = row.dataset.project;
      if (!p) return;
      if (!state.openProjects.includes(p)) state.openProjects.push(p);
      state.filters.project = p;
      state.activeWorkspace = projectWorkspace(p);
      recordRecentProject(p);
      saveProjectTabs();
      setView('schedule');
    });
  });
  root.querySelectorAll('[data-action="toggle-fav"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = btn.dataset.project;
      if (p) toggleFavoriteProject(p);
    });
  });
}

// Left sidebar panel — DEPRECATED in v4.11. Pages are used now instead.
// Kept as a no-op shim so any straggler callers don't blow up.
function renderSidebarPanel(mode) {
  const titleEl = document.getElementById('app-sidebar-panel-title');
  const bodyEl  = document.getElementById('app-sidebar-panel-body');
  if (!titleEl || !bodyEl) return;
  // Highlight the active sidebar icon
  document.querySelectorAll('.app-sidebar-icon').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.panel === mode);
  });

  if (mode === 'workspaces') {
    titleEl.textContent = 'Workspaces';
    bodyEl.innerHTML = renderWorkspacesPanelHtml();
    wireWorkspacePanelHandlers(bodyEl);
  } else if (mode === 'favorites') {
    titleEl.textContent = 'Favorites';
    bodyEl.innerHTML = `<div class="panel-workspace-empty">Favorites coming in v4.11 — for now use Workspaces to navigate.</div>`;
  } else if (mode === 'recents') {
    titleEl.textContent = 'Recents';
    bodyEl.innerHTML = `<div class="panel-workspace-empty">Recents coming next — for now use Workspaces to navigate.</div>`;
  } else if (mode === 'create') {
    titleEl.textContent = 'Create New Schedule';
    bodyEl.innerHTML = renderCreatePanelHtml();
    wireCreatePanelHandlers(bodyEl);
  }
}

// Build the HTML for the Workspaces tree panel. Lists every workspace and
// the projects in it (templates pinned at top with ★). Click a project row
// to open it as a tab + switch to schedule view.
function renderWorkspacesPanelHtml() {
  const all = uniqueValues('project');
  const openSet = new Set(state.openProjects);
  const byWs = Object.fromEntries(WORKSPACES.map(ws => [ws, []]));
  for (const p of all) byWs[projectWorkspace(p)].push(p);
  for (const ws of WORKSPACES) {
    byWs[ws].sort((a, b) => {
      const ta = isTemplateProject(a) ? 0 : 1;
      const tb = isTemplateProject(b) ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return a.localeCompare(b);
    });
  }
  const rowHtml = (p) => {
    const isOpen = openSet.has(p);
    const isActive = (state.filters.project || '') === p;
    const star = isTemplateProject(p) ? '<span class="panel-row-star" title="Template">★</span>' : '';
    return `<button class="panel-row${isOpen ? ' is-open' : ''}" data-project="${escapeHtml(p)}" type="button">
      ${star}<span class="panel-row-name">${escapeHtml(p)}</span>
      ${isActive ? '<span class="panel-row-badge">viewing</span>' : (isOpen ? '<span class="panel-row-badge">open</span>' : '')}
    </button>`;
  };
  return WORKSPACES.map(ws => `
    <div class="panel-workspace" data-workspace="${escapeHtml(ws)}">
      <div class="panel-workspace-head">
        <span>${escapeHtml(ws)}</span>
        <span class="panel-workspace-count">${byWs[ws].length}</span>
      </div>
      ${byWs[ws].length === 0
        ? `<div class="panel-workspace-empty">No schedules in this workspace.</div>`
        : byWs[ws].map(rowHtml).join('')}
    </div>
  `).join('') + `<button class="panel-create-button" data-action="open-create" type="button">＋ New schedule…</button>`;
}

function wireWorkspacePanelHandlers(bodyEl) {
  bodyEl.querySelectorAll('.panel-row').forEach(row => {
    row.addEventListener('click', () => {
      const p = row.dataset.project;
      if (!p) return;
      if (!state.openProjects.includes(p)) state.openProjects.push(p);
      state.filters.project = p;
      state.activeWorkspace = projectWorkspace(p);
      saveProjectTabs();
      setView('schedule');
      closeSidebarPanel();
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = row.dataset.project;
      if (!p) return;
      showProjectTabMenu(e.clientX, e.clientY, p);
    });
  });
  const createBtn = bodyEl.querySelector('[data-action="open-create"]');
  if (createBtn) createBtn.addEventListener('click', () => renderSidebarPanel('create'));
}

// Build the Create panel — three cards for new-schedule entry points.
function renderCreatePanelHtml() {
  const ws = state.activeWorkspace || 'Active';
  const wsTemplates = (state.templateProjects || []).filter(t =>
    state.tasks.some(x => x.project === t) && projectWorkspace(t) === ws
  );
  const onlyTemplate = wsTemplates.length === 1 ? wsTemplates[0] : null;
  const allTemplates = (state.templateProjects || []).filter(t => state.tasks.some(x => x.project === t));
  return `
    <div class="workspace-page-actions" style="padding: 12px 14px;">
      <div class="workspace-action-card">
        <h3>★ Build from template</h3>
        ${allTemplates.length === 0
          ? `<p>No templates yet. Mark an existing schedule as template (right-click its tab → Mark as template ★) to build new schedules from it.</p>`
          : `<p>${onlyTemplate ? `Active workspace template: <strong>${escapeHtml(onlyTemplate)}</strong>.` : 'Pick a template below.'} Real-person assignees are blanked; placeholders carry through.</p>
            <div class="workspace-action-row">
              <input type="text" class="cv-tmpl-name" placeholder="New schedule name…" />
              ${onlyTemplate
                ? `<input type="hidden" class="cv-tmpl-source" value="${escapeHtml(onlyTemplate)}" />`
                : `<select class="cv-tmpl-source"><option value="" disabled selected>Pick a template…</option>${allTemplates.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}</select>`}
              <button class="btn-primary cv-tmpl-btn" type="button" disabled>Build in ${escapeHtml(ws)}</button>
            </div>`}
      </div>
      <div class="workspace-action-card">
        <h3>📊 From SDC estimate sheet</h3>
        <p>Upload the SDC estimate xlsx — we pull hours from "SUMMARY FOR RELEASE", ask for PO + FAT dates, and lay out a schedule from the standard template.</p>
        <div class="workspace-action-row">
          <button class="btn-primary cv-fallback" data-action="legacy-picker" type="button">Open legacy picker…</button>
        </div>
      </div>
      <div class="workspace-action-card">
        <h3>📥 Import from Smartsheet</h3>
        <p>Already have a schedule in Smartsheet? Export → Excel, then pick the file in the legacy picker (will move here soon).</p>
        <div class="workspace-action-row">
          <button class="btn-primary cv-fallback" data-action="legacy-picker" type="button">Open legacy picker…</button>
        </div>
      </div>
    </div>
  `;
}

function wireCreatePanelHandlers(bodyEl) {
  const ws = state.activeWorkspace || 'Active';
  const allTemplates = (state.templateProjects || []).filter(t => state.tasks.some(x => x.project === t));
  const wsTemplates  = allTemplates.filter(t => projectWorkspace(t) === ws);
  const onlyTemplate = wsTemplates.length === 1 ? wsTemplates[0] : null;

  const nameEl = bodyEl.querySelector('.cv-tmpl-name');
  const sourceEl = bodyEl.querySelector('.cv-tmpl-source');
  const btnEl = bodyEl.querySelector('.cv-tmpl-btn');
  if (btnEl) {
    const refresh = () => {
      const v = nameEl?.value?.trim();
      const src = (sourceEl?.value) || (onlyTemplate || '');
      btnEl.disabled = !v || !src;
    };
    nameEl?.addEventListener('input', refresh);
    sourceEl?.addEventListener('change', refresh);
    btnEl.addEventListener('click', async () => {
      const name = nameEl?.value?.trim();
      const src  = (sourceEl?.value) || (onlyTemplate || '');
      if (!name || !src) return;
      if (state.tasks.some(t => t.project === name)) {
        alert(`A project named "${name}" already exists. Pick a different name.`);
        return;
      }
      await duplicateProject(src, name);
      setProjectWorkspace(name, ws);
      saveProjectTabs();
      setView('schedule');
      closeSidebarPanel();
    });
    nameEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnEl.disabled) { e.preventDefault(); btnEl.click(); } });
  }
  bodyEl.querySelectorAll('[data-action="legacy-picker"]').forEach(btn => {
    btn.addEventListener('click', () => {
      closeSidebarPanel();
      showProjectAddPicker();
    });
  });
}

function openSidebarPanel(mode) {
  const panel = document.getElementById('app-sidebar-panel');
  if (!panel) return;
  renderSidebarPanel(mode);
  panel.classList.remove('hidden');
  document.body.classList.add('sidebar-panel-open');
}

function closeSidebarPanel() {
  const panel = document.getElementById('app-sidebar-panel');
  if (!panel) return;
  panel.classList.add('hidden');
  document.body.classList.remove('sidebar-panel-open');
  document.querySelectorAll('.app-sidebar-icon').forEach(btn => btn.classList.remove('is-active'));
}

// Legacy: kept as a no-op since the workspace landing page was removed.
function renderWorkspacePage() {
  const root = document.getElementById('workspace-page');
  if (!root) return;
  const ws = state.activeWorkspace || 'Active';
  // Projects in this workspace, templates first, then alphabetical.
  const all = uniqueValues('project').filter(p => projectWorkspace(p) === ws);
  all.sort((a, b) => {
    const ta = isTemplateProject(a) ? 0 : 1;
    const tb = isTemplateProject(b) ? 0 : 1;
    if (ta !== tb) return ta - tb;
    return a.localeCompare(b);
  });
  const wsTemplates = all.filter(p => isTemplateProject(p));
  const onlyTemplate = wsTemplates.length === 1 ? wsTemplates[0] : null;

  const rowHtml = (p) => {
    const isOpen = state.openProjects.includes(p);
    const star = isTemplateProject(p) ? '<span class="ws-row-star" title="Template — protected">★</span>' : '';
    return `<button class="ws-row${isOpen ? ' is-open' : ''}" data-project="${escapeHtml(p)}" type="button">
      ${star}<span class="ws-row-name">${escapeHtml(p)}</span>
      ${isOpen ? '<span class="ws-row-badge">open</span>' : ''}
    </button>`;
  };

  root.innerHTML = `
    <div class="workspace-page-head">
      <h1 class="workspace-page-title">${escapeHtml(ws)} Schedules</h1>
      <div class="workspace-page-sub">${all.length} schedule${all.length === 1 ? '' : 's'} in this workspace</div>
    </div>

    <div class="workspace-page-list">
      ${all.length === 0 ? '<div class="workspace-page-empty">No schedules yet in this workspace. Use one of the buttons below to build a new one.</div>'
        : all.map(rowHtml).join('')}
    </div>

    <div class="workspace-page-actions">
      <div class="workspace-action-card">
        <h3>★ Build from template</h3>
        ${wsTemplates.length === 0
          ? `<p>No template in this workspace yet. Mark an existing schedule as template (right-click its tab → Mark as template ★), or build one from the standard template and move it here.</p>`
          : `<p>${onlyTemplate ? `Clones <strong>${escapeHtml(onlyTemplate)}</strong> into a fresh project.` : 'Clones the chosen template into a fresh project.'} Real-person assignees are blanked; placeholders carry through.</p>
            <div class="workspace-action-row">
              <input type="text" class="ws-tmpl-name" placeholder="New schedule name…" />
              ${onlyTemplate
                ? `<input type="hidden" class="ws-tmpl-source" value="${escapeHtml(onlyTemplate)}" />`
                : `<select class="ws-tmpl-source"><option value="" disabled selected>Pick a template…</option>${wsTemplates.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}</select>`}
              <button class="btn-primary ws-tmpl-btn" type="button" disabled>Build</button>
            </div>`}
      </div>

      <div class="workspace-action-card">
        <h3>📊 Build from SDC estimate sheet</h3>
        <p>Upload the SDC estimate xlsx (with the "SUMMARY FOR RELEASE" tab). We pull the hours per discipline + section, ask for PO + FAT dates, and lay out a full schedule based on the standard template.</p>
        <div class="workspace-action-row">
          <input type="file" class="ws-estimate-file" accept=".xlsx" />
          <button class="btn-primary ws-estimate-btn" type="button" disabled>Analyze →</button>
        </div>
      </div>

      <div class="workspace-action-card">
        <h3>📥 Import from Smartsheet</h3>
        <p>Already have a schedule in Smartsheet? Export it from Smartsheet → File → Export → Excel, then pick the xlsx here. One file → one project. Bulk-pick multiple files to import all at once.</p>
        <div class="workspace-action-row">
          <input type="text" class="ws-import-name" placeholder="Project name (auto-fills from file)" />
          <input type="file" class="ws-import-file" accept=".xlsx" multiple />
          <button class="btn-primary ws-import-btn" type="button" disabled>Import</button>
        </div>
        <div class="ws-import-status"></div>
      </div>
    </div>
  `;

  // Wire row clicks — open the project as a tab + switch to schedule view.
  root.querySelectorAll('.ws-row').forEach(row => {
    row.addEventListener('click', async () => {
      const p = row.dataset.project;
      if (!p) return;
      if (!state.openProjects.includes(p)) state.openProjects.push(p);
      state.filters.project = p;
      saveProjectTabs();
      setView('schedule');
    });
    row.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const p = row.dataset.project;
      if (isTemplateProject(p)) {
        await showAlertDialog({ title: 'Template projects are protected', message: `"${p}" is marked as a template. Open it, right-click the tab, and unmark it before deleting.` });
        return;
      }
      deleteProject(p);
    });
  });

  // Wire Build from template
  if (wsTemplates.length > 0) {
    const nameEl = root.querySelector('.ws-tmpl-name');
    const sourceEl = root.querySelector('.ws-tmpl-source');
    const btnEl = root.querySelector('.ws-tmpl-btn');
    const refreshBtn = () => {
      const v = nameEl?.value?.trim();
      const src = (sourceEl?.value) || (onlyTemplate || '');
      btnEl.disabled = !v || !src;
    };
    nameEl?.addEventListener('input', refreshBtn);
    sourceEl?.addEventListener('change', refreshBtn);
    const buildFromTmpl = async () => {
      const name = nameEl?.value?.trim();
      const src  = (sourceEl?.value) || (onlyTemplate || '');
      if (!name || !src) return;
      if (state.tasks.some(t => t.project === name)) {
        alert(`A project named "${name}" already exists. Pick a different name.`);
        return;
      }
      await duplicateProject(src, name);
      // New project starts in the current workspace, not the source's.
      setProjectWorkspace(name, ws);
      // duplicateProject already opens the tab + switches state.filters.project,
      // but it doesn't change state.view. Switch now so the user lands on the
      // schedule editor for the new project.
      setView('schedule');
    };
    btnEl?.addEventListener('click', buildFromTmpl);
    nameEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnEl.disabled) { e.preventDefault(); buildFromTmpl(); } });
  }

  // Wire Estimate sheet upload (reuses the existing flow from the picker —
  // we set up the file input + button here and delegate to handleEstimateFile,
  // which already opens the analyze modal etc.).
  const estFile = root.querySelector('.ws-estimate-file');
  const estBtn  = root.querySelector('.ws-estimate-btn');
  if (estFile && estBtn) {
    estFile.addEventListener('change', () => { estBtn.disabled = !estFile.files?.length; });
    estBtn.addEventListener('click', async () => {
      const f = estFile.files?.[0];
      if (!f) return;
      // The legacy picker code reads the file as base64 → POSTs to
      // /api/estimate/analyze, opens a modal. We don't have that function
      // factored out yet; for v4.9 the user can fall back to the existing
      // "+ New tab" picker for now (which still has the estimate flow wired).
      // Telegraph that in the meantime.
      alert('Estimate-sheet upload from the workspace page is wired but the analyze flow still lives in the legacy + New tab picker for now — click "+ New tab" → "Build from SDC estimate sheet" to use it. Will wire here in the next iteration.');
    });
  }

  // Same caveat for Smartsheet for now.
  const impBtn = root.querySelector('.ws-import-btn');
  const impFile = root.querySelector('.ws-import-file');
  if (impFile && impBtn) {
    impFile.addEventListener('change', () => { impBtn.disabled = !impFile.files?.length; });
    impBtn.addEventListener('click', () => {
      alert('Smartsheet import from the workspace page is wired but the parser still lives in the legacy + New tab picker for now — click "+ New tab" → "Import from Smartsheet" to use it. Will wire here in the next iteration.');
    });
  }
}

// (v4.10: renderWorkspaceBar removed — the workspace switcher moved from the
// top of the page into the left sidebar PANEL. Click the 📁 Workspaces icon
// in the sidebar to open the panel, which lists every workspace and its
// projects as a tree.)
function renderWorkspaceBar() { /* no-op — kept for callers that haven't been updated yet */ }

function renderProjectTabs() {
  const wrap = document.getElementById('project-tabs');
  if (!wrap) return;
  // Show ALL open project tabs regardless of workspace. v4.18 dropped the
  // workspace filter that v4.8 introduced — having tabs disappear when you
  // navigate to a different workspace's project was disorienting. Now you
  // can have an Active project, a Sales template, and a Closed schedule all
  // open side-by-side; the workspace is conveyed via per-tab COLOR coding
  // (see CSS .project-tab.workspace-*) instead of filtering tabs away.
  // Templates pinned first; non-templates in their original openProjects order.
  const visibleList = state.openProjects.slice();
  const templatesFirst = [
    visibleList.find(p => p === ''),
    ...visibleList.filter(p => p !== '' && isTemplateProject(p)),
    ...visibleList.filter(p => p !== '' && !isTemplateProject(p)),
  ].filter(p => p !== undefined);
  wrap.innerHTML = templatesFirst.map(p => {
    const isAll = p === '';
    const isActive = (state.filters.project || '') === p;
    const isTemplate = isTemplateProject(p);
    const label = isAll ? 'All projects' : p;
    // All-projects pseudo-tab has no close button (it's a special permanent
    // tab). Everything else — including templates — can be closed via the ×;
    // "close" only removes the tab from the open-tabs list, the underlying
    // project (and template flag) stay in the DB.
    const close = isAll ? ''
      : `<span class="project-tab-close" data-project="${escapeHtml(p)}" title="Close tab (project stays in the database)">×</span>`;
    const star  = isTemplate ? '<span class="project-tab-star" title="Template — protected">★</span>' : '';
    const cls = ['project-tab'];
    if (isActive) cls.push('active');
    if (isAll)    cls.push('is-all');
    if (isTemplate) cls.push('is-template');
    // Workspace class drives a SMALL colored DOT before the project name —
    // not the full tab background. Inactive tabs share a neutral background
    // so the SELECTED tab (lime border) is unmistakable. Dot colors:
    //   workspace-active → SDC lime  (#befa4f)
    //   workspace-sales  → SDC blue  (#AACEE8)
    //   workspace-closed → SDC yellow (#FFDE51)
    let wsDot = '';
    if (!isAll) {
      const ws = projectWorkspace(p).toLowerCase();
      cls.push('workspace-' + ws);
      wsDot = `<span class="project-tab-dot project-tab-dot-${ws}" title="${escapeHtml(projectWorkspace(p))} workspace"></span>`;
    }
    // All-projects pseudo-tab is NOT draggable (it's pinned at position 0).
    // Every real project tab is draggable so the user can reorder them.
    const draggable = isAll ? 'false' : 'true';
    return `
      <button class="${cls.join(' ')}" data-project="${escapeHtml(p)}" type="button" draggable="${draggable}">
        ${wsDot}${star}<span class="project-tab-label">${escapeHtml(label)}</span>
        ${close}
      </button>`;
  }).join('');

  wrap.querySelectorAll('.project-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.project-tab-close')) return;
      state.filters.project = btn.dataset.project;
      saveProjectTabs();
      // Always switch to the schedule view when a project tab is clicked.
      // Without this, clicking a tab while on the Projects page (or any other
      // non-schedule view) would silently change the active project without
      // navigating off the current view — which made the click feel broken.
      setView('schedule');
    });
    // Right-click → context menu (Duplicate, Mark/Unmark template, Close).
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = btn.dataset.project;
      if (p === '') return; // No actions on the All-projects pseudo-tab.
      showProjectTabMenu(e.clientX, e.clientY, p);
    });
    // Drag-to-reorder. The All-projects pseudo-tab is non-draggable (its
    // draggable=false attribute prevents dragstart) and we explicitly skip
    // drops on it too — it stays pinned at position 0.
    if (btn.dataset.project === '') return;
    btn.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', btn.dataset.project);
      e.dataTransfer.effectAllowed = 'move';
      btn.classList.add('dragging');
    });
    btn.addEventListener('dragend', () => {
      btn.classList.remove('dragging');
      wrap.querySelectorAll('.project-tab.drag-over').forEach(t => t.classList.remove('drag-over'));
    });
    btn.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      btn.classList.add('drag-over');
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('drag-over'));
    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      btn.classList.remove('drag-over');
      const fromP = e.dataTransfer.getData('text/plain');
      const toP   = btn.dataset.project;
      if (!fromP || fromP === toP || fromP === '' || toP === '') return;
      const order = [...state.openProjects];
      const fromIdx = order.indexOf(fromP);
      if (fromIdx === -1) return;
      order.splice(fromIdx, 1);
      const toIdx = order.indexOf(toP);
      // Drop AT the target's position (pushes target right). For drops on the
      // last tab the target index is the new last, but we still want fromP to
      // land there — so use toIdx, not toIdx+1.
      order.splice(toIdx === -1 ? order.length : toIdx, 0, fromP);
      state.openProjects = order;
      saveProjectTabs();
      renderProjectTabs();
    });
  });
  wrap.querySelectorAll('.project-tab-close').forEach(x => {
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = x.dataset.project;
      // Templates close just like any other tab — the project + template flag
      // remain in the DB, the tab just goes away. Reopen anytime via the
      // Projects page.
      state.openProjects = state.openProjects.filter(q => q !== p);
      if ((state.filters.project || '') === p) state.filters.project = '';
      saveProjectTabs();
      render();
    });
  });

  // Project name banner — short pill with SDC-lime outline sitting BETWEEN
  // the toolbar and the schedule split. Replaces the old centered-name row
  // above the toolbar (which only made sense when grid + Gantt were both
  // visible; the banner placement reads correctly for grid-only and
  // gantt-only pane modes too). On the All-projects pseudo-tab we keep the
  // "Save all tasks as one project" rescue button alongside the label.
  const banner = document.getElementById('schedule-project-banner');
  if (banner) {
    if (!state.filters.project) {
      const total = state.tasks.length;
      const distinctProjects = new Set(state.tasks.map(t => t.project || '__null__')).size;
      const showSaveAll = total > 0 && distinctProjects > 0;
      const saveAllBtn = showSaveAll
        ? `<button id="btn-save-all-as-one" class="orphan-save-btn" type="button" title="Take every task in the database (across every project) and re-tag them under one new project name. The All-projects view becomes a true aggregate.">Save all ${total} task${total === 1 ? '' : 's'} as one project →</button>`
        : '';
      banner.innerHTML = '<span class="schedule-project-name-pill schedule-project-label">All projects</span>' + saveAllBtn;
      const sb = document.getElementById('btn-save-all-as-one');
      if (sb) sb.addEventListener('click', saveAllAsOneProject);
    } else {
      const p = state.filters.project;
      banner.innerHTML = `<span class="schedule-project-name-pill schedule-project-label">${escapeHtml(p)}</span>`;
    }
  }

  // Disable "+ Add task" while on All projects — the new task wouldn't have a project
  // to attach to. Tooltip explains why so the user knows to pick a project tab first.
  const addBtn = document.getElementById('btn-add');
  if (addBtn) {
    const onAllProjects = !state.filters.project;
    addBtn.disabled = onAllProjects;
    addBtn.setAttribute('aria-disabled', String(onAllProjects));
    addBtn.title = onAllProjects
      ? 'Pick a project tab first — new tasks attach to the active project.'
      : `Add a new task to ${state.filters.project}`;
  }
  // ⚖ Quote vs Schedule toolbar button — disabled when there's no active
  // project tab (no single project to compare). Tooltip explains.
  const quoteBtn = document.getElementById('btn-toolbar-quote');
  if (quoteBtn) {
    const onAllProjects = !state.filters.project;
    quoteBtn.disabled = onAllProjects;
    quoteBtn.title = onAllProjects
      ? 'Pick a project tab first — quote vs schedule is per-project.'
      : `Compare quoted vs scheduled hours for ${state.filters.project}. Also exposes the financial milestones editor.`;
  }
}

// Right-click menu on a project tab. Lets the user rename, duplicate, merge, mark
// as template, close the tab (UI-only), or fully delete the project's data.
function showProjectTabMenu(x, y, project) {
  const isTemplate = isTemplateProject(project);
  const currentWs = projectWorkspace(project);
  const items = [
    { label: 'Rename project…',          onClick: () => renameProject(project) },
    { label: 'Duplicate to new project…', onClick: () => duplicateProject(project) },
    { label: 'Merge another project into this…', onClick: () => mergeAnotherProjectInto(project, x, y) },
    { label: 'Financial milestones…',     onClick: () => openFinancialsModal(project) },
    { label: '⚖ Quote vs Schedule…',      onClick: () => openQuoteCompareModal(project) },
    { label: isTemplate ? 'Unmark as template' : 'Mark as template ★', onClick: () => toggleTemplate(project) },
  ];
  // Move-to-workspace entries — flat (no submenu) since we only have three.
  // The current workspace shows a ✓ prefix; others move the project on click.
  // Templates can be moved too, but their "Templates" group in the picker is
  // driven by the template flag, not by workspace.
  for (const ws of WORKSPACES) {
    const isCurrent = ws === currentWs;
    items.push({
      label: (isCurrent ? '✓ ' : '   ') + `Workspace: ${ws}`,
      onClick: isCurrent ? () => {} : () => {
        setProjectWorkspace(project, ws);
        renderProjectTabs();
      },
    });
  }
  if (!isTemplate) {
    items.push({ label: 'Close tab', onClick: () => closeProjectTab(project) });
    items.push({ label: 'Delete project (and all its tasks)…', onClick: () => deleteProject(project) });
  }
  showContextMenu(x, y, items);
}

// Permanently delete every task tagged with this project. Closing a tab only
// removes it from the open-tabs list; the underlying rows stay in the DB and keep
// counting toward over-allocation warnings, which is why "I closed the duplicate
// but the people are still over-allocated" happens. This action wipes them.
// Anchors get the same treatment as everything else (ignoring the usual delete
// guard), since deleting a whole project should clear ALL of its rows.
async function deleteProject(project) {
  if (!project) return;
  const tasks = state.tasks.filter(t => t.project === project);
  if (tasks.length === 0) return; // nothing to delete; silent
  // No confirmation popup — right-click → Delete is already 2 intentional clicks.
  // User explicitly requested this.
  // Bypass the anchor-protection in the regular DELETE handler by clearing
  // anchor_key first on those rows.
  for (const t of tasks) {
    if (t.anchor_key) {
      await api.update(t.id, { anchor_key: null });
    }
  }
  for (const t of tasks) {
    try { await api.remove(t.id); }
    catch (err) { console.error('delete task failed', t.id, err); }
  }
  state.openProjects = state.openProjects.filter(q => q !== project);
  if ((state.filters.project || '') === project) state.filters.project = '';
  state.templateProjects = (state.templateProjects || []).filter(q => q !== project);
  if (state.projectWorkspaces) delete state.projectWorkspaces[project];
  saveProjectTabs();
  await loadTasks();
}

// Pull every task from another project into THIS one. Used to fold a stray project
// into a canonical home — e.g. when the All-projects orphan-save split data across
// "Job 2026-014" and "SDC_Template" and you just want everything under one name.
function mergeAnotherProjectInto(target, anchorX, anchorY) {
  if (!target) return;
  const others = uniqueValues('project').filter(p => p !== target);
  if (others.length === 0) {
    alert('There are no other projects to merge in.');
    return;
  }
  const items = others.map(p => {
    const n = state.tasks.filter(t => t.project === p).length;
    return {
      label: `${p} (${n} task${n === 1 ? '' : 's'})`,
      onClick: () => doMergeProjects(p, target),
    };
  });
  showContextMenu(anchorX, anchorY, items);
}

async function doMergeProjects(source, target) {
  if (!source || !target || source === target) return;
  const sourceTasks = state.tasks.filter(t => t.project === source);
  if (sourceTasks.length === 0) return;
  const ok = confirm(
    `Move ${sourceTasks.length} task${sourceTasks.length === 1 ? '' : 's'} from "${source}" into "${target}"?\n\n`
    + `"${source}" will end up empty (you can close its tab afterward).\n`
    + `This re-tags every row's project field; predecessors / dates / IDs are preserved.`);
  if (!ok) return;
  for (const t of sourceTasks) {
    await api.update(t.id, { project: target });
  }
  // Switch to the merged-into project so the user sees the result.
  state.filters.project = target;
  saveProjectTabs();
  await loadTasks();
}

// Rename every task tagged with `oldName` to a new project name. In-place — same task
// IDs, same dates, same predecessors. Open tab and template flag carry over to the
// new name. Useful when a project that started life as one name (e.g. Job 2026-014)
// turns into the template you keep around.
async function renameProject(oldName) {
  if (!oldName) return;
  const newName = prompt(`Rename "${oldName}" to:`, oldName);
  if (newName == null) return;
  const trimmed = String(newName).trim();
  if (!trimmed || trimmed === oldName) return;
  if (state.tasks.some(t => t.project === trimmed)) {
    alert(`A project named "${trimmed}" already exists. Pick a different name.`);
    return;
  }
  const tasks = state.tasks.filter(t => t.project === oldName);
  for (const t of tasks) {
    await api.update(t.id, { project: trimmed });
  }
  // Migrate the open-tabs list, template flag, and workspace assignment so
  // the new name keeps the exact same UI state the old one had.
  state.openProjects = state.openProjects.map(p => p === oldName ? trimmed : p);
  if (isTemplateProject(oldName)) {
    state.templateProjects = state.templateProjects.map(p => p === oldName ? trimmed : p);
  }
  if (state.projectWorkspaces && state.projectWorkspaces[oldName]) {
    state.projectWorkspaces[trimmed] = state.projectWorkspaces[oldName];
    delete state.projectWorkspaces[oldName];
  }
  if ((state.filters.project || '') === oldName) state.filters.project = trimmed;
  saveProjectTabs();
  await loadTasks();
}

function toggleTemplate(project) {
  if (!project) return;
  state.templateProjects = state.templateProjects || [];
  const i = state.templateProjects.indexOf(project);
  if (i >= 0) state.templateProjects.splice(i, 1);
  else state.templateProjects.push(project);
  saveProjectTabs();
  render();
}

function closeProjectTab(project) {
  state.openProjects = state.openProjects.filter(q => q !== project);
  if ((state.filters.project || '') === project) state.filters.project = '';
  saveProjectTabs();
  render();
}

// One-shot data-cleanup: every task that was created without a project field gets
// stamped with a real project name. Two paths now: MERGE the orphans into an
// existing project (e.g. dropping all 15 into Job 2026-014 so the All-projects view
// becomes a true aggregate), or save them as a NEW project. A picker popup lets the
// user choose; defaults to creating new when no projects exist yet.
function convertOrphansToProject() {
  const orphans = state.tasks.filter(t => !t.project);
  if (orphans.length === 0) return;
  const existing = uniqueValues('project');
  const btn = document.getElementById('btn-save-orphans');
  if (!btn) {
    // Fall back to a prompt if the button isn't on screen for some reason.
    promptCreateNewOrphanProject(orphans);
    return;
  }
  // Close any prior picker.
  const prev = document.getElementById('orphan-picker');
  if (prev) { prev.remove(); return; }
  const r = btn.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.id = 'orphan-picker';
  pop.className = 'project-add-picker';
  const POPUP_W = 340;
  const safeLeft = Math.max(8, Math.min(r.right - POPUP_W, window.innerWidth - POPUP_W - 8));
  pop.style.left = safeLeft + 'px';
  pop.style.top  = (r.bottom + 4) + 'px';
  pop.style.width = POPUP_W + 'px';
  const mergeRows = existing.length === 0
    ? '<div class="picker-empty">No projects yet — create one below.</div>'
    : existing.map(p => {
        const n = state.tasks.filter(t => t.project === p).length;
        return `<button class="picker-row" data-action="merge" data-project="${escapeHtml(p)}" type="button">
          Merge into <strong>${escapeHtml(p)}</strong> <span class="picker-row-count">(${n} task${n === 1 ? '' : 's'})</span>
        </button>`;
      }).join('');
  pop.innerHTML = `
    <div class="picker-section-title">Save ${orphans.length} untagged task${orphans.length === 1 ? '' : 's'} to:</div>
    ${mergeRows}
    <div class="picker-divider"></div>
    <div class="picker-section-title">Or save as a new project</div>
    <div class="picker-new-row">
      <input type="text" class="picker-new-input" placeholder="e.g. SDC_Template" />
      <button class="btn-primary picker-new-btn" type="button">Create</button>
    </div>`;
  document.body.appendChild(pop);
  pop.querySelectorAll('[data-action="merge"]').forEach(row => {
    row.addEventListener('click', async () => {
      const target = row.dataset.project;
      pop.remove();
      await mergeOrphansInto(orphans, target);
    });
  });
  const input = pop.querySelector('.picker-new-input');
  const create = async () => {
    const v = String(input.value || '').trim();
    if (!v) return;
    if (state.tasks.some(t => t.project === v)) {
      alert(`A project named "${v}" already exists. Pick "Merge into" above instead.`);
      return;
    }
    pop.remove();
    await mergeOrphansInto(orphans, v, { markTemplate: true });
  };
  pop.querySelector('.picker-new-btn').addEventListener('click', create);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  setTimeout(() => input.focus(), 0);
  setTimeout(() => {
    const onDoc = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== btn) {
        pop.remove();
        document.removeEventListener('mousedown', onDoc);
      }
    };
    document.addEventListener('mousedown', onDoc);
  }, 0);
}

async function mergeOrphansInto(orphans, projectName, opts = {}) {
  const trimmed = String(projectName || '').trim();
  if (!trimmed || orphans.length === 0) return;
  for (const t of orphans) {
    await api.update(t.id, { project: trimmed });
  }
  if (!state.openProjects.includes(trimmed)) state.openProjects.push(trimmed);
  state.filters.project = trimmed;
  if (opts.markTemplate) {
    state.templateProjects = state.templateProjects || [];
    if (!state.templateProjects.includes(trimmed)) state.templateProjects.push(trimmed);
  }
  saveProjectTabs();
  await loadTasks();
}

// Re-tag EVERY task in the database (orphans + every existing project) under a
// single project name. Same idea as merge-into-existing, but covers the case where
// data is split across two or more projects and the user just wants one canonical
// home. Picker offers: merge into one of the existing projects, or save as new.
function saveAllAsOneProject() {
  if (state.tasks.length === 0) return;
  const existing = uniqueValues('project');
  const btn = document.getElementById('btn-save-all-as-one');
  if (!btn) return;
  // Toggle if already open.
  const prev = document.getElementById('orphan-picker');
  if (prev) { prev.remove(); return; }
  const r = btn.getBoundingClientRect();
  const POPUP_W = 360;
  const safeLeft = Math.max(8, Math.min(r.right - POPUP_W, window.innerWidth - POPUP_W - 8));
  const pop = document.createElement('div');
  pop.id = 'orphan-picker';
  pop.className = 'project-add-picker';
  pop.style.left = safeLeft + 'px';
  pop.style.top  = (r.bottom + 4) + 'px';
  pop.style.width = POPUP_W + 'px';
  const total = state.tasks.length;
  const mergeRows = existing.length === 0
    ? '<div class="picker-empty">No existing projects — create a new one below.</div>'
    : existing.map(p => {
        const n = state.tasks.filter(t => t.project === p).length;
        return `<button class="picker-row" data-action="merge" data-project="${escapeHtml(p)}" type="button">
          Combine everything into <strong>${escapeHtml(p)}</strong> <span class="picker-row-count">(currently ${n} task${n === 1 ? '' : 's'})</span>
        </button>`;
      }).join('');
  pop.innerHTML = `
    <div class="picker-section-title">Save all ${total} tasks under one project:</div>
    ${mergeRows}
    <div class="picker-divider"></div>
    <div class="picker-section-title">Or save as a new project</div>
    <div class="picker-new-row">
      <input type="text" class="picker-new-input" placeholder="e.g. SDC_Template" />
      <button class="btn-primary picker-new-btn" type="button">Create</button>
    </div>`;
  document.body.appendChild(pop);
  const doMerge = async (target, opts = {}) => {
    pop.remove();
    const tasks = state.tasks.slice();
    for (const t of tasks) {
      if (t.project !== target) await api.update(t.id, { project: target });
    }
    if (!state.openProjects.includes(target)) state.openProjects.push(target);
    state.filters.project = target;
    if (opts.markTemplate) {
      state.templateProjects = state.templateProjects || [];
      if (!state.templateProjects.includes(target)) state.templateProjects.push(target);
    }
    saveProjectTabs();
    await loadTasks();
  };
  pop.querySelectorAll('[data-action="merge"]').forEach(row => {
    row.addEventListener('click', () => doMerge(row.dataset.project));
  });
  const input = pop.querySelector('.picker-new-input');
  const create = async () => {
    const v = String(input.value || '').trim();
    if (!v) return;
    if (state.tasks.some(t => t.project === v)) {
      alert(`A project named "${v}" already exists. Use "Combine everything into ${v}" above.`);
      return;
    }
    await doMerge(v, { markTemplate: true });
  };
  pop.querySelector('.picker-new-btn').addEventListener('click', create);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  setTimeout(() => input.focus(), 0);
  setTimeout(() => {
    const onDoc = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== btn) {
        pop.remove();
        document.removeEventListener('mousedown', onDoc);
      }
    };
    document.addEventListener('mousedown', onDoc);
  }, 0);
}

// Fallback used when the picker can't be opened (button missing). Same effect as
// "save as new project" path of the picker.
async function promptCreateNewOrphanProject(orphans) {
  const name = prompt(`Save ${orphans.length} untagged tasks as a new project named:`, 'SDC_Template');
  if (name == null) return;
  const trimmed = String(name).trim();
  if (!trimmed) return;
  if (state.tasks.some(t => t.project === trimmed)) {
    alert(`A project named "${trimmed}" already exists.`);
    return;
  }
  await mergeOrphansInto(orphans, trimmed, { markTemplate: true });
}

// Clone every task in `source` into a brand-new project name. INCLUDES the anchor
// milestones (Receipt of PO / FAT / Ship Machine) — they're project-spine markers
// and a duplicate without them is missing the structural backbone the schedule is
// built on. Predecessor IDs are remapped to the new task IDs so the dependency
// graph survives. Assignees are left blank in the copy: a duplicate with real
// people on every row would double-book them and trip over-allocation warnings.
// Duplicate a project: clone every task into a new project name, remap
// predecessors, open the new tab. Callers can pass `targetName` to skip the
// prompt (used by the "Build from template" picker entry, which collects the
// name in its own input field).
async function duplicateProject(source, targetName = null) {
  const newName = targetName != null ? targetName : prompt(`Duplicate "${source}" to a new project named:`, `${source}_copy`);
  if (newName == null) return;
  const trimmed = String(newName).trim();
  if (!trimmed) return;
  if (state.tasks.some(t => t.project === trimmed)) {
    alert(`A project named "${trimmed}" already exists. Pick a different name.`);
    return;
  }
  const sourceTasks = state.tasks.filter(t => t.project === source);
  if (sourceTasks.length === 0) {
    alert(`"${source}" has no tasks to duplicate.`);
    return;
  }
  // Create copies in original sort_order so the cascade order matches.
  sourceTasks.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const oldToNewId = {};
  for (const t of sourceTasks) {
    const payload = {
      name: t.name,
      project: trimmed,
      phase: t.phase || null,
      phase_group: t.phase_group || null,
      department: t.department || null,
      sub_department: t.sub_department || null,
      // Placeholders carry through (they're role markers — that's the whole point of
      // a template). Real-person assignees get blanked so the new project isn't
       // pre-staffed and over-allocation isn't tripped by ghost double-booking.
      assignee: isPlaceholder(t.assignee) ? t.assignee : null,
      start_date: t.start_date || null,
      end_date: t.end_date || null,
      duration_days: t.duration_days != null ? t.duration_days : null,
      predecessors: null, // we'll rewrite with mapped IDs in a second pass
      is_milestone: !!t.is_milestone,
      progress: 0, // Reset progress on the clone so the new schedule starts at zero.
      allocation: t.allocation == null ? 90 : t.allocation,
      priority: 1,
      notes: t.notes || null,
      anchor_key: t.anchor_key || null,
    };
    const created = await api.create(payload);
    oldToNewId[t.id] = created.id;
  }
  // Second pass: rewrite predecessors with the new IDs.
  for (const t of sourceTasks) {
    if (!t.predecessors) continue;
    const remapped = String(t.predecessors).split(',').map(s => {
      const trimmedRef = s.trim();
      const m = trimmedRef.match(/^(\d+)(.*)$/);
      if (!m) return trimmedRef;
      const oldId = Number(m[1]);
      const newId = oldToNewId[oldId];
      return newId != null ? `${newId}${m[2]}` : trimmedRef;
    }).join(', ');
    if (remapped) await api.update(oldToNewId[t.id], { predecessors: remapped });
  }
  // Open the new tab and switch to it.
  if (!state.openProjects.includes(trimmed)) state.openProjects.push(trimmed);
  state.filters.project = trimmed;
  saveProjectTabs();
  // loadTasks runs ensureAnchorsForProject — it'll see the cloned anchors and skip
  // creating duplicates, so the clone keeps the source's anchor dates / predecessors.
  await loadTasks();
}

function showProjectAddPicker() {
  const existing = document.getElementById('project-add-picker');
  if (existing) { existing.remove(); return; }
  const btn = document.getElementById('btn-add-project');
  const r = btn.getBoundingClientRect();
  const all = uniqueValues('project');
  // Show ALL projects in the picker. Open ones get a small "(open)" badge so
  // the user can see what's already a tab vs what they can newly open. Clicking
  // an already-open project just switches to its tab.
  const openSet = new Set(state.openProjects);
  const pop = document.createElement('div');
  pop.id = 'project-add-picker';
  pop.className = 'project-add-picker';
  // Anchor the popup to the button's RIGHT edge so it can never run off the right
  // side of the screen. Falls back to button.left if the popup would clip the left.
  const POPUP_W = 380;
  const desiredLeft = r.right - POPUP_W;
  const safeLeft = Math.max(8, Math.min(desiredLeft, window.innerWidth - POPUP_W - 8));
  pop.style.left = safeLeft + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
  pop.style.width = POPUP_W + 'px';
  // Group projects by workspace (Active / Sales / Closed). Templates appear
  // within their workspace's group (marked with ★), pinned to the top of
  // that group — no separate "Templates" group, since templates per workspace
  // is the new mental model (each workspace can have its own template).
  // Projects without an explicit workspace fall back to "Active".
  const byWs = Object.fromEntries(WORKSPACES.map(ws => [ws, []]));
  for (const p of all) byWs[projectWorkspace(p)].push(p);
  // Sort each workspace: templates first (alphabetical), then non-templates (alphabetical).
  for (const ws of WORKSPACES) {
    byWs[ws].sort((a, b) => {
      const ta = isTemplateProject(a) ? 0 : 1;
      const tb = isTemplateProject(b) ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return a.localeCompare(b);
    });
  }
  const rowHtml = (p) => {
    const isOpen = openSet.has(p);
    const star = isTemplateProject(p) ? '<span class="picker-row-star" title="Template — protected">★</span>' : '';
    return `<button class="picker-row${isOpen ? ' is-open' : ''}" data-project="${escapeHtml(p)}" type="button">${star}${escapeHtml(p)}${isOpen ? '<span class="picker-row-badge">open</span>' : ''}</button>`;
  };
  const sectionHtml = (title, projects, hint = '') => projects.length === 0 ? '' :
    `<div class="picker-section-title">${escapeHtml(title)}${hint ? ` <span class="picker-section-hint">${escapeHtml(hint)}</span>` : ''}</div>`
    + projects.map(rowHtml).join('');

  pop.innerHTML = `
    ${all.length === 0 ? '<div class="picker-empty">No projects yet.</div>' : ''}
    ${sectionHtml('Active', byWs.Active, '(★ = template; right-click a tab to move / delete)')}
    ${sectionHtml('Sales', byWs.Sales)}
    ${sectionHtml('Closed', byWs.Closed)}
    <div class="picker-divider"></div>
    <div class="picker-section-title">Or start a new schedule</div>
    <div class="picker-new-row">
      <input type="text" class="picker-new-input" placeholder="e.g. Job 2026-015 — Sample Project" />
      <button class="btn-primary picker-new-btn" type="button">Open</button>
    </div>
    <div class="picker-divider"></div>
    <div class="picker-section-title">Or build from a template ★</div>
    <div class="picker-new-row picker-template-row">
      <input type="text" class="picker-template-name" placeholder="New schedule name…" />
      <select class="picker-template-source">
        <option value="" disabled selected>Pick a template…</option>
      </select>
      <button class="btn-primary picker-template-btn" type="button" disabled>Build</button>
    </div>
    <div class="picker-template-hint" style="font-size: 11px; color: #6b7280; padding: 4px 2px 0;">Clones every task, milestone, and predecessor from the template into a fresh project under the name you enter. Real-person assignees are blanked; placeholders carry through.</div>
    <div class="picker-divider"></div>
    <div class="picker-section-title">Or build a schedule from an SDC estimate sheet (.xlsx)</div>
    <div class="picker-new-row picker-estimate-row">
      <input type="file" class="picker-estimate-file" accept=".xlsx" />
      <button class="btn-primary picker-estimate-btn" type="button" disabled>Analyze →</button>
    </div>
    <div class="picker-estimate-hint" style="font-size: 11px; color: #6b7280; padding: 4px 2px 0;">Pulls hours from "SUMMARY FOR RELEASE", then asks for a PO date + quoted FAT date to lay out a schedule from the SDC_Template.</div>
    <div class="picker-divider"></div>
    <div class="picker-section-title">Or import from Smartsheet (.xlsx)</div>
    <div class="picker-new-row picker-import-row">
      <input type="text" class="picker-import-name" placeholder="Project name (auto-fills from file)" />
      <input type="file" class="picker-import-file" accept=".xlsx" multiple />
      <button class="btn-primary picker-import-btn" type="button" disabled>Import</button>
    </div>
    <div class="picker-import-hint" style="font-size: 11px; color: #6b7280; padding: 4px 2px 0;">Tip: pick multiple .xlsx files at once to bulk-import — each file becomes a project named after its filename.</div>
    <div class="picker-import-status" id="picker-import-status"></div>`;
  document.body.appendChild(pop);
  pop.querySelectorAll('.picker-row').forEach(row => {
    row.addEventListener('click', () => {
      const p = row.dataset.project;
      if (!state.openProjects.includes(p)) state.openProjects.push(p);
      state.filters.project = p;
      // Auto-switch the active workspace to match the opened project, so the
      // user sees its tab in the project tab bar (instead of "where did my
      // new tab go?" because it lives in a different workspace).
      const ws = projectWorkspace(p);
      if (ws !== state.activeWorkspace) state.activeWorkspace = ws;
      saveProjectTabs();
      pop.remove();
      render();
    });
    // Right-click any closed-project row to delete it permanently. Skips templates
    // (they're protected from accidental loss). Shares the same deleteProject path
    // as the project tab's right-click delete, so one cleanup story.
    row.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const p = row.dataset.project;
      if (isTemplateProject(p)) {
        await showAlertDialog({
          title: 'Template projects are protected',
          message: `"${p}" is marked as a template. Open it, right-click the tab, and unmark it before deleting.`,
        });
        return;
      }
      pop.remove();
      deleteProject(p);
    });
  });
  const input = pop.querySelector('.picker-new-input');
  const create = async () => {
    const v = (input.value || '').trim();
    if (!v) return;
    if (!state.openProjects.includes(v)) state.openProjects.push(v);
    state.filters.project = v;
    saveProjectTabs();
    pop.remove();
    // Brand-new project? Seed it with the two anchor milestones.
    const isNew = !state.tasks.some(t => t.project === v);
    if (isNew) {
      await ensureAnchorsForProject(v);
      await loadTasks();
    } else {
      render();
    }
  };
  pop.querySelector('.picker-new-btn').addEventListener('click', create);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });

  // ---- Build from template ----------------------------------------------
  // Populate the template dropdown with every project marked as a template
  // (★ in the project tab right-click menu → "Mark as template"). The user
  // can have any number of templates — e.g., "SDC_Template" for full project
  // schedules and "SDC_Sales_Template" for simplified sales schedules.
  // Clicking Build clones the chosen template into the entered name via the
  // existing duplicateProject() — same code path as the right-click → Duplicate.
  const tmplSelect = pop.querySelector('.picker-template-source');
  const tmplName   = pop.querySelector('.picker-template-name');
  const tmplBtn    = pop.querySelector('.picker-template-btn');
  // Note: `templates` is already declared earlier in this function for the
  // picker grouping. Use a different name here to avoid the redeclaration.
  const tmplOptions = (state.templateProjects || []).filter(t => state.tasks.some(x => x.project === t));
  if (tmplOptions.length === 0) {
    tmplSelect.innerHTML = '<option value="" disabled selected>No templates yet — mark a project as template first.</option>';
    tmplSelect.disabled = true;
    tmplName.disabled   = true;
  } else {
    tmplSelect.innerHTML = '<option value="" disabled selected>Pick a template…</option>'
      + tmplOptions.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  }
  const refreshTmplBtn = () => {
    tmplBtn.disabled = !tmplName.value.trim() || !tmplSelect.value;
  };
  tmplName.addEventListener('input', refreshTmplBtn);
  tmplSelect.addEventListener('change', refreshTmplBtn);
  const buildFromTemplate = async () => {
    const name = (tmplName.value || '').trim();
    const src  = tmplSelect.value;
    if (!name || !src) return;
    if (state.tasks.some(t => t.project === name)) {
      alert(`A project named "${name}" already exists. Pick a different name.`);
      return;
    }
    pop.remove();
    await duplicateProject(src, name);  // remapped predecessors + open tab handled there
  };
  tmplBtn.addEventListener('click', buildFromTemplate);
  tmplName.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !tmplBtn.disabled) { e.preventDefault(); buildFromTemplate(); } });

  // ---- Smartsheet (Excel) import ----------------------------------------
  // The user picks an .xlsx (exported from Smartsheet → File → Export → Excel).
  // We auto-fill the project name from the file's basename, then POST the file
  // (base64) to /api/import/smartsheet. The server parses it and creates a new
  // project with all the tasks + auto-adds new team members.
  const importNameEl = pop.querySelector('.picker-import-name');
  const importFileEl = pop.querySelector('.picker-import-file');
  const importBtnEl  = pop.querySelector('.picker-import-btn');
  const importStatus = pop.querySelector('#picker-import-status');
  let pickedFiles = []; // array — supports single or bulk import
  // Project name derived from a filename: strip ".xlsx" extension.
  const nameFromFile = (f) => f.name.replace(/\.xlsx$/i, '');
  importFileEl.addEventListener('change', () => {
    pickedFiles = Array.from(importFileEl.files || []);
    importBtnEl.disabled = pickedFiles.length === 0;
    if (pickedFiles.length === 1) {
      // Single file — name input is editable, seeded from filename.
      importNameEl.disabled = false;
      if (!importNameEl.value.trim()) importNameEl.value = nameFromFile(pickedFiles[0]);
    } else if (pickedFiles.length > 1) {
      // Bulk — name input is ignored, each project is named after its file.
      importNameEl.disabled = true;
      importNameEl.value = `(bulk: ${pickedFiles.length} files — names from filenames)`;
    }
  });
  const importOne = async (file, projectName) => {
    const buf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const r = await fetch('/api/import/smartsheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectName, file: b64 }),
    });
    const result = await r.json();
    return { ok: r.ok, result, projectName };
  };
  const runImport = async () => {
    if (pickedFiles.length === 0) return;
    importBtnEl.disabled = true;

    // Single-file path keeps the existing one-project-name UX.
    if (pickedFiles.length === 1) {
      const projectName = importNameEl.value.trim();
      if (!projectName) { importStatus.textContent = 'Enter a project name first.'; importBtnEl.disabled = false; return; }
      importStatus.textContent = 'Reading file…';
      try {
        importStatus.textContent = 'Uploading & parsing…';
        const { ok, result } = await importOne(pickedFiles[0], projectName);
        if (!ok) { importStatus.textContent = `Import failed: ${result.error || 'unknown error'}`; importBtnEl.disabled = false; return; }
        if (!state.openProjects.includes(result.project)) state.openProjects.push(result.project);
        state.filters.project = result.project;
        saveProjectTabs();
        pop.remove();
        await loadTeam();
        await loadTasks();
        const teamMsg = (result.addedMembers || []).length
          ? ` Added ${result.addedMembers.length} new team member${result.addedMembers.length === 1 ? '' : 's'}: ${result.addedMembers.map(m => m.name).join(', ')}.`
          : '';
        alert(`Imported ${result.tasksCreated} tasks under "${result.project}".${teamMsg}`);
      } catch (err) {
        importStatus.textContent = `Import failed: ${err.message || err}`;
        importBtnEl.disabled = false;
      }
      return;
    }

    // Bulk path — sequential so we don't hammer the server and so errors are easy
    // to attribute to a single file. Each file gets its own project; failures don't
    // block the rest. Summary alert at the end lists what worked and what didn't.
    const successes = [];
    const failures = [];
    const newMembers = new Set();
    for (let i = 0; i < pickedFiles.length; i++) {
      const f = pickedFiles[i];
      const projectName = nameFromFile(f);
      importStatus.textContent = `Importing ${i + 1}/${pickedFiles.length}: ${projectName}…`;
      try {
        const { ok, result } = await importOne(f, projectName);
        if (ok) {
          successes.push({ project: result.project, tasks: result.tasksCreated });
          (result.addedMembers || []).forEach(m => newMembers.add(m.name));
        } else {
          failures.push({ project: projectName, error: result.error || 'unknown error' });
        }
      } catch (err) {
        failures.push({ project: projectName, error: err.message || String(err) });
      }
    }
    // Reload everything and open the last successful import so the user sees something.
    await loadTeam();
    await loadTasks();
    if (successes.length) {
      const lastProject = successes[successes.length - 1].project;
      successes.forEach(s => { if (!state.openProjects.includes(s.project)) state.openProjects.push(s.project); });
      state.filters.project = lastProject;
      saveProjectTabs();
    }
    pop.remove();
    const lines = [];
    lines.push(`Imported ${successes.length}/${pickedFiles.length} files.`);
    if (successes.length) lines.push('', 'Created:', ...successes.map(s => `  • ${s.project} (${s.tasks} tasks)`));
    if (failures.length)  lines.push('', 'Failed:',  ...failures .map(f => `  • ${f.project}: ${f.error}`));
    if (newMembers.size)  lines.push('', `New team members added: ${[...newMembers].join(', ')}`);
    alert(lines.join('\n'));
  };
  importBtnEl.addEventListener('click', runImport);

  // ---- Estimate sheet → new schedule from SDC_Template ---------------------
  // Two-step flow: (1) user picks an estimate xlsx and clicks Analyze, which
  // parses the workbook and opens a feasibility modal showing hours per
  // discipline + recommended headcount; (2) user enters PO date + FAT date in
  // that modal and clicks Create, which clones SDC_Template into a fresh
  // project with anchors shifted to the quoted dates.
  const estFileEl = pop.querySelector('.picker-estimate-file');
  const estBtnEl  = pop.querySelector('.picker-estimate-btn');
  let estPickedFile = null;
  estFileEl.addEventListener('change', () => {
    estPickedFile = estFileEl.files?.[0] || null;
    estBtnEl.disabled = !estPickedFile;
  });
  estBtnEl.addEventListener('click', async () => {
    if (!estPickedFile) return;
    estBtnEl.disabled = true;
    try {
      const buf = await estPickedFile.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const r = await fetch('/api/estimate/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: b64 }),
      });
      const result = await r.json();
      if (!r.ok) {
        await showAlertDialog({ title: "Couldn't parse estimate", message: result.error || 'Unknown error.' });
        estBtnEl.disabled = false;
        return;
      }
      pop.remove();
      showEstimateFeasibilityModal(result);
    } catch (err) {
      await showAlertDialog({ title: "Couldn't read file", message: err.message || String(err) });
      estBtnEl.disabled = false;
    }
  });

  setTimeout(() => input.focus(), 0);

  setTimeout(() => {
    const onDoc = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== btn) {
        pop.remove();
        document.removeEventListener('mousedown', onDoc);
      }
    };
    document.addEventListener('mousedown', onDoc);
  }, 0);
}

// ---- Estimate-sheet feasibility modal -------------------------------------
// Flow:
//   1. /api/estimate/parse returns hours per SECTION per discipline.
//   2. User enters PO date + delivery weeks + efficiency.
//   3. Modal computes a SUGGESTED critical path:
//      - Builds backwards from FAT (= PO + delivery_weeks)
//      - Determines Mech 1 Release date so Build can fit before testing
//      - Iterates headcount up from minimums (1/1/1/2/1) until every phase fits
//   4. User can override headcount and watch the schedule recompute.
//   5. "Create project" calls /api/estimate/create which clones SDC_Template
//      and shifts dates to fit. Mech 1 Release gets pinned to the computed week.
function showEstimateFeasibilityModal(parsed) {
  document.getElementById('estimate-feasibility-modal')?.remove();

  // Break out the raw estimate columns into per-TASK hours so the user can edit
  // each bucket independently. Defaults for split columns:
  //   ce_design column → Controls Design (50%) + Controls Drawings (50%)
  //   elec_build column → Wire Panel (25%) + Wire Machine (75%)
  // Section 40 has its own column structure (testing engineers only); we keep
  // ce_des as the combined debug bucket and let drawings/software be 0 there.
  const r10 = parsed.hours_per_section.section_10 || {};
  const r40 = parsed.hours_per_section.section_40 || {};
  const r50 = parsed.hours_per_section.section_50 || {};
  const safe = (v) => Math.round(v || 0);
  const buildSection = (s) => ({
    mech:         safe(s.mech_eng),
    ce_des:       Math.round(safe(s.ce_design) * 0.5),
    ce_drw:       safe(s.ce_design) - Math.round(safe(s.ce_design) * 0.5),
    ce_sw:        safe(s.ce_software),
    hmi:          safe(s.gen_hmi),
    robot:        safe(s.gen_robot),
    vision:       safe(s.gen_vision),
    build:        safe(s.mech_build),
    wire_panel:   Math.round(safe(s.elec_build) * 0.25),
    wire_machine: safe(s.elec_build) - Math.round(safe(s.elec_build) * 0.25),
  });
  // `hours` is the editable model — user can mutate any cell in the grid below.
  const hours = {
    section_10: buildSection(r10),
    section_40: buildSection(r40),
    section_50: buildSection(r50),
  };
  const HOURS_COLS = ['mech', 'ce_des', 'ce_drw', 'ce_sw', 'hmi', 'robot', 'vision', 'build', 'wire_panel', 'wire_machine'];
  const sumCol = (col) => hours.section_10[col] + hours.section_40[col] + hours.section_50[col];

  const today = new Date().toISOString().slice(0, 10);

  // Staffing rules per user direction:
  //   Default: 1 of EVERYTHING (user said "use as few resources as possible").
  //     Auto-bump headcount only if the minimum critical path exceeds delivery.
  //   Section 40 testing = ALWAYS 1 lead + 1 secondary controls debugger.
  //   Configure Machine = ~5% of section-40 engineering debug hours.
  //   Test/Debug 1 + 2 share the remaining 95% (run in parallel).
  //   Shop Debug duration = engineering debug duration (parallel); headcount
  //     auto-scales with hours.
  //   Mech 1 Release lands at the END of mech eng (latest possible) — only
  //     pulled earlier if needed to fit. If schedule has slack, mech eng
  //     STRETCHES (lower allocation) to push M1R later.
  //   Section 50 teardown + install fixed at 1 week each.
  const DEFAULT_HEADCOUNT = { mech_eng: 1, controls_eng: 1, general_eng: 1, build: 1, wire: 1 };
  const MECH_RELEASE_TO_BUILD_WEEKS = 6;
  const SECTION_50_WEEKS = 1;
  const SECTION_40_CONTROLS_HEADCOUNT = 2;

  const weeksFor = (hrs, count, eff) => count > 0 ? hrs / (count * 40 * eff) : 0;
  const peopleNeededInOneWeek = (hrs, eff) => Math.max(1, Math.ceil(hrs / (1 * 40 * eff)));
  // Roll up the editable per-cell hours into the totals the critical-path math
  // expects. Cell layout: each section has mech / ce_des / ce_drw / ce_sw /
  // hmi / robot / vision / build / wire_panel / wire_machine.
  const sectionTotals = () => ({
    section_10: {
      mech_eng:     hours.section_10.mech,
      controls_eng: hours.section_10.ce_des + hours.section_10.ce_drw + hours.section_10.ce_sw,
      general_eng:  hours.section_10.hmi + hours.section_10.robot + hours.section_10.vision,
      build:        hours.section_10.build,
      wire:         hours.section_10.wire_panel + hours.section_10.wire_machine,
    },
    section_40: {
      // Section 40 testing engineering = mech + controls debug (Design column
      // here represents debug hours, not split design/drawings — but we treat
      // ce_des + ce_drw as the testing-engineer hours).
      testing:      hours.section_40.mech + hours.section_40.ce_des + hours.section_40.ce_drw + hours.section_40.ce_sw,
      shop_debug:   hours.section_40.build + hours.section_40.wire_panel + hours.section_40.wire_machine,
      general:      hours.section_40.hmi + hours.section_40.robot + hours.section_40.vision,
    },
    section_50: {
      teardown:     hours.section_50.build + hours.section_50.wire_panel + hours.section_50.wire_machine,
      install:      hours.section_50.mech + hours.section_50.ce_des + hours.section_50.ce_drw + hours.section_50.ce_sw
                  + hours.section_50.hmi + hours.section_50.robot + hours.section_50.vision,
    },
  });
  // Forward placement (matches server logic):
  //   1. Compute MINIMUM weeks per phase at user's headcount.
  //   2. Mech eng STRETCHES to absorb any slack so M1R lands as late as possible.
  //   3. Build + Wire run in parallel; wire ends 1 week after build.
  //   4. Section 40 Configure Machine = 5% of testing hours; Test/Debug 1+2
  //      share remaining 95% (parallel). Shop Debug runs parallel to debug.
  //   5. Total = mech_stretched + 6w buffer + buildWireDur + testingDur. Should
  //      land at FAT.
  const computeCriticalPath = (hc, deliveryWeeks, eff) => {
    const t = sectionTotals();
    const mechMin     = weeksFor(t.section_10.mech_eng,     hc.mech_eng,     eff);
    const controlsMin = weeksFor(t.section_10.controls_eng, hc.controls_eng, eff);
    const generalMin  = weeksFor(t.section_10.general_eng,  hc.general_eng,  eff);
    const buildMin    = weeksFor(t.section_10.build,        hc.build,        eff);
    const wireMin     = weeksFor(t.section_10.wire,         hc.wire,         eff);
    const buildWireMin = Math.max(buildMin, wireMin) + 1;

    const engDebugHrs    = t.section_40.testing;
    const configureHrs   = engDebugHrs * 0.05;
    const debugPerTester = (engDebugHrs * 0.95) / 2;
    const configureWeeks = weeksFor(configureHrs,   1, eff);
    const debugWeeks     = weeksFor(debugPerTester, 1, eff);
    const testDur        = configureWeeks + debugWeeks;

    const shopDebugHrs   = t.section_40.shop_debug;
    const shopDebugCount = debugWeeks > 0 ? Math.max(1, Math.ceil(shopDebugHrs / (debugWeeks * 40 * eff))) : 1;

    // Total min span (everything at minimum durations). Add a 2-week template
    // overhead allowance because the SDC_Template wires Build → 2-week-gap →
    // Wire Machine sequentially (procurement lag between panel and machine).
    // Plus 1 week handoff buffers between phases. Without this, the math
    // underestimates the real cascade span and "fits" projects that actually
    // overrun in the generated schedule.
    const TEMPLATE_OVERHEAD_WEEKS = 3;
    const totalMin = mechMin + MECH_RELEASE_TO_BUILD_WEEKS + buildWireMin + testDur + TEMPLATE_OVERHEAD_WEEKS;
    const slack    = Math.max(0, deliveryWeeks - totalMin);
    // Mech eng STRETCHES to absorb slack (M1R goes later).
    const mechStretched = mechMin + slack;

    const buildStartWeek = mechStretched + MECH_RELEASE_TO_BUILD_WEEKS;
    const buildEndWeek   = buildStartWeek + buildWireMin;
    const testStartWeek  = buildEndWeek;
    const fatWeek        = testStartWeek + testDur;
    const m1rWeek        = mechStretched;

    // Section 50 (post-FAT) — sized by 1-week rule, headcount = hrs / week.
    const teardownPeopleNeeded = peopleNeededInOneWeek(t.section_50.teardown, eff);
    const installPeopleNeeded  = peopleNeededInOneWeek(t.section_50.install + t.section_50.teardown, eff);

    const fits = totalMin <= deliveryWeeks;
    // Controls + General must also fit before testing starts (run pre-test).
    const controlsFits = controlsMin <= testStartWeek;
    const generalFits  = generalMin  <= testStartWeek;

    return {
      fatWeek, testStartWeek, buildEndWeek, buildStartWeek, m1rWeek,
      testDur, buildWireDur: buildWireMin, buildDur: buildMin, wireDur: wireMin,
      mechReqWeeks: mechStretched, controlsReqWeeks: controlsMin, generalReqWeeks: generalMin,
      configureWeeks, debugWeeks,
      teardownPeopleNeeded, installPeopleNeeded, shopDebugCount,
      slack, totalMin,
      mechFits: fits, controlsFits, generalFits,
      feasible: fits && controlsFits && generalFits,
    };
  };

  // Auto-bump strategy: when the minimum critical path overruns the delivery
  // window, identify the LONGEST phase contributing to the overrun and bump
  // that discipline's headcount. Repeat until fit or hitting a cap. User said
  // "use as few resources as possible" so we start at 1 everywhere and only
  // grow on demand.
  const suggestHeadcount = (deliveryWeeks, eff) => {
    const hc = { ...DEFAULT_HEADCOUNT };
    for (let iter = 0; iter < 25; iter++) {
      const cp = computeCriticalPath(hc, deliveryWeeks, eff);
      if (cp.feasible) return hc;
      const t = sectionTotals();
      const candidates = [
        { k: 'mech_eng', weeks: weeksFor(t.section_10.mech_eng, hc.mech_eng, eff) },
        { k: 'build',    weeks: weeksFor(t.section_10.build,    hc.build,    eff) },
        { k: 'wire',     weeks: weeksFor(t.section_10.wire,     hc.wire,     eff) },
      ];
      if (!cp.controlsFits) candidates.push({ k: 'controls_eng', weeks: weeksFor(t.section_10.controls_eng, hc.controls_eng, eff) });
      if (!cp.generalFits)  candidates.push({ k: 'general_eng',  weeks: weeksFor(t.section_10.general_eng,  hc.general_eng,  eff) });
      candidates.sort((a, b) => b.weeks - a.weeks);
      const bumped = candidates.find(c => hc[c.k] < 5);
      if (!bumped) break;
      hc[bumped.k]++;
    }
    return hc;
  };

  const overlay = document.createElement('div');
  overlay.id = 'estimate-feasibility-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card" style="max-width: 1080px;">
      <div class="modal-head">
        <h2 style="margin: 0;">New schedule from estimate</h2>
        <button class="modal-close" type="button">×</button>
      </div>
      <div class="modal-body">
        <div class="est-meta">
          <div><span class="est-meta-label">Quote</span> <strong>${escapeHtml(parsed.quote_number || '—')}</strong></div>
          <div><span class="est-meta-label">Customer</span> <strong>${escapeHtml(parsed.customer || '—')}</strong></div>
          <div><span class="est-meta-label">Machine</span> <strong>${escapeHtml(parsed.machine_title || '—')}</strong></div>
        </div>

        <div class="est-form">
          <label>Project name
            <input type="text" id="est-project-name" value="${escapeHtml(parsed.suggested_project_name)}" />
          </label>
          <label>Receipt of PO
            <input type="date" id="est-po-date" value="${today}" />
          </label>
          <label>Delivery (weeks)
            <input type="number" id="est-delivery-weeks" min="1" max="200" step="1" value="30" />
          </label>
          <label>Backlog (weeks)
            <input type="number" id="est-backlog-weeks" min="0" max="20" step="1" value="2" title="Time between Receipt of PO and the start of engineering — accounts for handoff, kickoff, contract paperwork." />
          </label>
          <label>Efficiency
            <span class="est-pct-wrap"><input type="number" id="est-efficiency" min="10" max="100" step="1" value="90" />%</span>
          </label>
          <label>Quoted FAT
            <span class="est-readout" id="est-fat-readout">—</span>
          </label>
        </div>

        <h3 style="margin: 16px 0 6px;">Estimate hours — editable</h3>
        <p class="est-help" style="margin: 0 0 6px; font-size: 12px; color: #6b7280;">
          Mirrors the SUMMARY FOR RELEASE tab. Section 10's <strong>Design + Drawings</strong> cell splits into Design | Drawings (default 50/50). Section 10's <strong>Electrical Build</strong> splits into Panel | Machine (default 25/75). Click any value to edit.
        </p>
        <div class="est-hours-scroll">
          <table class="est-hours-table summary-mirror">
            <colgroup>
              <col class="col-section">
              <col class="col-mech">
              <col class="col-ce-des"><col class="col-ce-sw"><col class="col-ce-db">
              <col class="col-gen"><col class="col-gen"><col class="col-gen"><col class="col-gen">
              <col class="col-mb">
              <col class="col-eb">
            </colgroup>
            <thead>
              <tr class="grp-row">
                <th rowspan="2" class="sticky-col">Section</th>
                <th class="grp grp-mech">Mech<br>Eng</th>
                <th colspan="3" class="grp grp-ce">Controls<br>Eng</th>
                <th colspan="4" class="grp grp-gen">General<br>Eng</th>
                <th class="grp grp-mb">Mech<br>Build</th>
                <th class="grp grp-eb">Elec<br>Build</th>
              </tr>
              <tr class="sub-row">
                <th class="num grp-mech">General</th>
                <th class="num grp-ce">Design<br>+ Drawings</th>
                <th class="num grp-ce">Software</th>
                <th class="num grp-ce">Database</th>
                <th class="num grp-gen">HMI</th>
                <th class="num grp-gen">Robot</th>
                <th class="num grp-gen">Vision</th>
                <th class="num grp-gen">Device</th>
                <th class="num grp-mb">General</th>
                <th class="num grp-eb">General</th>
              </tr>
            </thead>
            <tbody id="est-hours-body"></tbody>
            <tfoot id="est-hours-foot"></tfoot>
          </table>
        </div>

        <h3 style="margin: 16px 0 6px;">Staffing</h3>
        <p class="est-help" style="margin: 0 0 6px; font-size: 12px; color: #6b7280;">
          Edit people-per-role. Mech 1 Release pinned ${MECH_RELEASE_TO_BUILD_WEEKS} weeks before Build start. Section 40 always staffs 2 controls (lead + secondary). Section 50 teardown + install fixed at 1 week — more hours = more people.
        </p>
        <table class="est-staff-table">
          <thead>
            <tr>
              <th>Role</th>
              <th class="num">Hours</th>
              <th class="num">People</th>
              <th class="num">Weeks</th>
            </tr>
          </thead>
          <tbody id="est-hc-body"></tbody>
        </table>

        <div class="est-summary" id="est-summary"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="est-cancel">Cancel</button>
        <button type="button" class="btn-primary" id="est-create">Create project</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').onclick = close;
  overlay.querySelector('#est-cancel').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Mutable headcount the user can override. Seeded from suggestHeadcount on
  // first render then locked unless the user clicks +/− or changes the delivery
  // weeks (which re-suggests).
  let userHeadcount = null;
  let userOverrode = false;

  const computeFatDate = (poIso, weeks) => {
    const t = new Date(poIso).getTime();
    if (isNaN(t) || !weeks) return null;
    // Approximate: 1 business week = 7 calendar days (we're rough on this).
    return new Date(t + weeks * 7 * 86400000).toISOString().slice(0, 10);
  };

  // Render the editable hours table that mirrors SUMMARY FOR RELEASE.
  // Section 10 gets two-cell splits on the Design+Drawings and Electrical Build
  // cells (hash-mark divider between sub-inputs). Sections 40 and 50 show a
  // single value for those same columns (combined ce_design and elec_build).
  const renderHoursTable = () => {
    const body = document.getElementById('est-hours-body');
    const foot = document.getElementById('est-hours-foot');
    const inp = (sec, col, val) => `<input type="number" min="0" step="1" class="est-hours-input" data-section="${sec}" data-col="${col}" value="${val}">`;
    const singleCell = (sec, col, val, cls) => `<td class="num ${cls || ''}">${inp(sec, col, val)}</td>`;
    // For Section 10: ce_des|ce_drw split with hash; wire_panel|wire_machine split with hash.
    const splitCell = (sec, colA, colB, valA, valB, cls) =>
      `<td class="num split-cell ${cls || ''}">
        ${inp(sec, colA, valA)}<span class="hash-divider">/</span>${inp(sec, colB, valB)}
      </td>`;
    // For Sections 40 + 50: ce_design lump = ce_des + ce_drw; elec_build lump = wire_panel + wire_machine.
    // We render these as ONE input that, when edited, distributes back into ce_des / ce_drw (50/50)
    // or wire_panel / wire_machine (25/75) so the underlying data model stays consistent.
    const lumpCell = (sec, kind, total, cls) =>
      `<td class="num ${cls || ''}"><input type="number" min="0" step="1" class="est-hours-input est-hours-lump" data-section="${sec}" data-lump="${kind}" value="${total}"></td>`;

    const s10 = hours.section_10, s40 = hours.section_40, s50 = hours.section_50;
    const ce40 = s40.ce_des + s40.ce_drw;
    const ce50 = s50.ce_des + s50.ce_drw;
    const eb40 = s40.wire_panel + s40.wire_machine;
    const eb50 = s50.wire_panel + s50.wire_machine;

    body.innerHTML = `
      <tr data-section="section_10">
        <td class="sticky-col">10 Design &amp; Build</td>
        ${singleCell('section_10', 'mech',         s10.mech,        'grp-mech')}
        ${splitCell ('section_10', 'ce_des', 'ce_drw', s10.ce_des, s10.ce_drw, 'grp-ce')}
        ${singleCell('section_10', 'ce_sw',        s10.ce_sw,       'grp-ce')}
        <td class="num grp-ce">0</td>
        ${singleCell('section_10', 'hmi',          s10.hmi,         'grp-gen')}
        ${singleCell('section_10', 'robot',        s10.robot,       'grp-gen')}
        ${singleCell('section_10', 'vision',       s10.vision,      'grp-gen')}
        <td class="num grp-gen">0</td>
        ${singleCell('section_10', 'build',        s10.build,       'grp-mb')}
        ${splitCell ('section_10', 'wire_panel', 'wire_machine', s10.wire_panel, s10.wire_machine, 'grp-eb')}
      </tr>
      <tr data-section="section_40">
        <td class="sticky-col">40 Machine Testing/Debug</td>
        ${singleCell('section_40', 'mech',  s40.mech,  'grp-mech')}
        ${lumpCell  ('section_40', 'ce',    ce40,      'grp-ce')}
        ${singleCell('section_40', 'ce_sw', s40.ce_sw, 'grp-ce')}
        <td class="num grp-ce">0</td>
        ${singleCell('section_40', 'hmi',    s40.hmi,    'grp-gen')}
        ${singleCell('section_40', 'robot',  s40.robot,  'grp-gen')}
        ${singleCell('section_40', 'vision', s40.vision, 'grp-gen')}
        <td class="num grp-gen">0</td>
        ${singleCell('section_40', 'build', s40.build, 'grp-mb')}
        ${lumpCell  ('section_40', 'eb',    eb40,      'grp-eb')}
      </tr>
      <tr data-section="section_50">
        <td class="sticky-col">50 Teardown &amp; Install</td>
        ${singleCell('section_50', 'mech',  s50.mech,  'grp-mech')}
        ${lumpCell  ('section_50', 'ce',    ce50,      'grp-ce')}
        ${singleCell('section_50', 'ce_sw', s50.ce_sw, 'grp-ce')}
        <td class="num grp-ce">0</td>
        ${singleCell('section_50', 'hmi',    s50.hmi,    'grp-gen')}
        ${singleCell('section_50', 'robot',  s50.robot,  'grp-gen')}
        ${singleCell('section_50', 'vision', s50.vision, 'grp-gen')}
        <td class="num grp-gen">0</td>
        ${singleCell('section_50', 'build', s50.build, 'grp-mb')}
        ${lumpCell  ('section_50', 'eb',    eb50,      'grp-eb')}
      </tr>`;

    // Footer totals — single cell per column (sums Design+Drawings and Panel+Machine
    // because the SUMMARY tab shows them as one number).
    const total = (col) => sumCol(col);
    const totalCe  = total('ce_des') + total('ce_drw');
    const totalEb  = total('wire_panel') + total('wire_machine');
    foot.innerHTML = `
      <tr class="totals-row">
        <td class="sticky-col">Department Totals</td>
        <td class="num grp-mech" data-total="mech">${total('mech')}</td>
        <td class="num grp-ce"   data-total="ce">${totalCe}</td>
        <td class="num grp-ce"   data-total="ce_sw">${total('ce_sw')}</td>
        <td class="num grp-ce">0</td>
        <td class="num grp-gen"  data-total="hmi">${total('hmi')}</td>
        <td class="num grp-gen"  data-total="robot">${total('robot')}</td>
        <td class="num grp-gen"  data-total="vision">${total('vision')}</td>
        <td class="num grp-gen">0</td>
        <td class="num grp-mb"   data-total="build">${total('build')}</td>
        <td class="num grp-eb"   data-total="eb">${totalEb}</td>
      </tr>`;

    const refreshTotals = () => {
      const set = (sel, v) => {
        const el = foot.querySelector(sel);
        if (el) el.textContent = v;
      };
      set('[data-total="mech"]',   sumCol('mech'));
      set('[data-total="ce"]',     sumCol('ce_des') + sumCol('ce_drw'));
      set('[data-total="ce_sw"]',  sumCol('ce_sw'));
      set('[data-total="hmi"]',    sumCol('hmi'));
      set('[data-total="robot"]',  sumCol('robot'));
      set('[data-total="vision"]', sumCol('vision'));
      set('[data-total="build"]',  sumCol('build'));
      set('[data-total="eb"]',     sumCol('wire_panel') + sumCol('wire_machine'));
    };

    body.querySelectorAll('.est-hours-input').forEach(el => {
      el.addEventListener('input', (e) => {
        const sec = e.target.dataset.section;
        const v = Math.max(0, Number(e.target.value) || 0);
        if (e.target.classList.contains('est-hours-lump')) {
          // Lump cell — distribute into the underlying split: ce → 50/50, eb → 25/75.
          const kind = e.target.dataset.lump;
          if (kind === 'ce') {
            hours[sec].ce_des = Math.round(v * 0.5);
            hours[sec].ce_drw = v - hours[sec].ce_des;
          } else if (kind === 'eb') {
            hours[sec].wire_panel   = Math.round(v * 0.25);
            hours[sec].wire_machine = v - hours[sec].wire_panel;
          }
        } else {
          const col = e.target.dataset.col;
          hours[sec][col] = v;
        }
        refreshTotals();
        recompute();
      });
    });
  };

  // Staffing table rows — one per "role" that maps onto a placeholder in
  // SDC_Template. Headcount is editable for Section 10 disciplines + Section
  // 50 teardown/install (since those scale headcount to fit a fixed week);
  // Section 40 controls is locked at 2 per user direction.
  const renderHeadcountTable = (cp, deliveryWeeks, eff) => {
    const body = document.getElementById('est-hc-body');
    const t = sectionTotals();
    const fmt = (n) => Math.round(n || 0).toLocaleString();
    // Format weeks rounded UP to the nearest half — 9.7 → 10w, 3.9 → 4w,
    // 5.3 → 5.5w, 5.7 → 6w. Matches the half-week duration grid the schedule
    // generator uses everywhere else.
    const fmtW = (n) => {
      if (!(n > 0)) return '—';
      const halves = Math.ceil(n * 2) / 2;
      return halves + 'w';
    };

    // Compact one-section staffing table — single column for total hours and
    // editable People count. Locked rows (Section 40 debug at 2, Section 50
    // teardown/install auto from hours) show their value with no buttons.
    const rows = [
      { key: 'mech_eng',     label: 'Mech Engineer',  hrs: t.section_10.mech_eng,     people: userHeadcount.mech_eng,     editable: true,  weeks: cp.mechReqWeeks },
      { key: 'controls_eng', label: 'Controls Eng',   hrs: t.section_10.controls_eng, people: userHeadcount.controls_eng, editable: true,  weeks: cp.controlsReqWeeks },
      { key: 'general_eng',  label: 'General Eng',    hrs: t.section_10.general_eng,  people: userHeadcount.general_eng,  editable: true,  weeks: cp.generalReqWeeks },
      { key: 'build',        label: 'Builder',        hrs: t.section_10.build,        people: userHeadcount.build,        editable: true,  weeks: cp.buildDur },
      { key: 'wire',         label: 'Electrician',    hrs: t.section_10.wire,         people: userHeadcount.wire,         editable: true,  weeks: cp.wireDur },
      { key: '_t40',         label: 'Test Debugger (lead + secondary)', hrs: t.section_40.testing, people: SECTION_40_CONTROLS_HEADCOUNT, editable: false, weeks: cp.testDur, peopleLabel: '2 (fixed)' },
    ];
    if (t.section_40.shop_debug > 0) rows.push({ key: '_s40shop', label: 'Shop Debug crew', hrs: t.section_40.shop_debug, people: cp.shopDebugCount || 1, editable: false, weeks: cp.testDur, peopleLabel: `${cp.shopDebugCount || 1} (auto)` });
    if (t.section_50.teardown > 0)   rows.push({ key: '_s50td',   label: 'Teardown crew (1-week fixed)', hrs: t.section_50.teardown, people: cp.teardownPeopleNeeded, editable: false, weeks: 1, peopleLabel: `${cp.teardownPeopleNeeded} (auto)` });
    if (t.section_50.install > 0)    rows.push({ key: '_s50in',   label: 'Install crew (1-week fixed)',  hrs: t.section_50.install,  people: cp.installPeopleNeeded,  editable: false, weeks: 1, peopleLabel: `${cp.installPeopleNeeded} (auto)` });

    body.innerHTML = rows.map(r => `
      <tr data-key="${r.key}">
        <td>${escapeHtml(r.label)}</td>
        <td class="num">${fmt(r.hrs)}</td>
        <td class="num">${r.editable
          ? `<button type="button" class="est-hc-btn" data-action="dec">−</button> <span class="est-hc">${r.people}</span> <button type="button" class="est-hc-btn" data-action="inc">+</button>`
          : `<span class="est-hc-fixed">${r.peopleLabel || r.people}</span>`}</td>
        <td class="num">${fmtW(r.weeks)}</td>
      </tr>`).join('');
    body.querySelectorAll('.est-hc-btn').forEach(btn => {
      btn.onclick = () => {
        const tr = btn.closest('tr');
        const k = tr.dataset.key;
        if (btn.dataset.action === 'inc') userHeadcount[k]++;
        else                              userHeadcount[k] = Math.max(1, userHeadcount[k] - 1);
        userOverrode = true;
        recompute();
      };
    });
  };

  const recompute = () => {
    const po = document.getElementById('est-po-date').value;
    const deliveryWeeks = Math.max(1, Number(document.getElementById('est-delivery-weeks').value) || 30);
    const eff = Math.max(0.1, Math.min(1, (Number(document.getElementById('est-efficiency').value) || 90) / 100));
    document.getElementById('est-fat-readout').textContent = computeFatDate(po, deliveryWeeks) || '—';
    if (!userHeadcount || !userOverrode) {
      userHeadcount = suggestHeadcount(deliveryWeeks, eff);
    }
    const cp = computeCriticalPath(userHeadcount, deliveryWeeks, eff);
    renderHeadcountTable(cp, deliveryWeeks, eff);
    const m1rText = cp.m1rWeek > 0 ? `week ${cp.m1rWeek.toFixed(1)}` : 'BEFORE PO (infeasible)';
    const summary = cp.feasible
      ? `<div style="font-size:12px;color:#166534;">✓ Fits ${deliveryWeeks} weeks at ${Math.round(eff*100)}% efficiency. <strong>Mech 1 Release at ${m1rText}</strong> · Build/Wire weeks ${cp.buildStartWeek.toFixed(1)}–${cp.buildEndWeek.toFixed(1)} · Testing weeks ${cp.testStartWeek.toFixed(1)}–${cp.fatWeek}.</div>`
      : `<div style="font-size:12px;color:#b91c1c;">✗ Doesn't fit ${deliveryWeeks} weeks. Bump headcount or extend delivery.</div>`;
    document.getElementById('est-summary').innerHTML = summary;
  };

  // Reset to auto-suggested headcount when delivery weeks changes.
  document.getElementById('est-delivery-weeks').oninput = () => { userOverrode = false; recompute(); };
  document.getElementById('est-efficiency').oninput = () => { userOverrode = false; recompute(); };
  document.getElementById('est-po-date').oninput = recompute;

  renderHoursTable();
  recompute();

  document.getElementById('est-create').onclick = async () => {
    const project = document.getElementById('est-project-name').value.trim();
    const po_date = document.getElementById('est-po-date').value;
    const deliveryWeeks = Math.max(1, Number(document.getElementById('est-delivery-weeks').value) || 30);
    const fat_date = computeFatDate(po_date, deliveryWeeks);
    const efficiency = Math.max(0.1, Math.min(1, (Number(document.getElementById('est-efficiency').value) || 90) / 100));
    if (!project)                  { await showAlertDialog('Pick a project name.'); return; }
    if (!po_date || !fat_date)     { await showAlertDialog('Pick a PO date and delivery weeks.'); return; }
    const btn = document.getElementById('est-create');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      // Convert the editable broken-out hours back into the column layout the
      // backend expects (mech_eng / ce_design / ce_software / gen_* / mech_build
      // / elec_build). User-edited values supersede the original estimate. The
      // `hours_breakdown` field carries the per-task split (Controls Design vs
      // Drawings, Wire Panel vs Machine) for backend use.
      const sectionToCols = (s) => ({
        mech_eng:    s.mech,
        ce_design:   s.ce_des + s.ce_drw,
        ce_software: s.ce_sw,
        ce_database: 0,
        gen_hmi:     s.hmi,
        gen_robot:   s.robot,
        gen_vision:  s.vision,
        gen_device:  0,
        mech_build:  s.build,
        elec_build:  s.wire_panel + s.wire_machine,
      });
      const backlogWeeks = Math.max(0, Number(document.getElementById('est-backlog-weeks').value) || 0);
      const r = await fetch('/api/estimate/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project, po_date, fat_date, efficiency,
          headcount: userHeadcount,
          backlog_weeks: backlogWeeks,
          hours_per_section: {
            section_10: sectionToCols(hours.section_10),
            section_40: sectionToCols(hours.section_40),
            section_50: sectionToCols(hours.section_50),
          },
          hours_breakdown: hours, // per-task split so backend uses edited values
        }),
      });
      const result = await r.json();
      if (!r.ok) {
        await showAlertDialog({ title: 'Create failed', message: result.error || 'Unknown error.' });
        btn.disabled = false;
        btn.textContent = 'Create project';
        return;
      }
      if (!state.openProjects.includes(result.project)) state.openProjects.push(result.project);
      state.filters.project = result.project;
      saveProjectTabs();
      close();
      await loadTeam();
      await loadTasks();
      await showAlertDialog({
        title: `Created "${result.project}"`,
        message: `${result.tasksCreated} tasks cloned from ${result.template}.\n\n${result.message || ''}`,
      });
    } catch (err) {
      await showAlertDialog({ title: 'Create failed', message: err.message || String(err) });
      btn.disabled = false;
      btn.textContent = 'Create project';
    }
  };
}

function render() {
  renderProjectTabs();
  renderFilters();
  // Keep the Baseline buttons' labels (Set/Reset) and disabled state aligned
  // with the active project after every render — covers project-tab switches
  // as well as data reloads.
  syncBaselineButtons();
  if (state.view === 'schedule') {
    renderTable();
    renderGantt();
  } else if (state.view === 'team') {
    renderTeam();
  }
}

// ---------- New-task & delete (no modal — everything else is inline) ----------
function newTaskInline() {
  // All-projects view has no project context to attach a new task to. Bail with a
  // hint so the user knows to open / pick a real project first.
  if (!state.filters.project) {
    alert('Pick a specific project tab first — new tasks attach to the active project. "All projects" is an aggregate view.');
    return;
  }
  const btn = document.getElementById('btn-add');
  const r = btn.getBoundingClientRect();
  showSectionPicker(r.right - 280, r.bottom + 6, async (g, d, s) => {
    const project = state.filters.project;
    const created = await api.create({ name: 'New task', phase_group: g, department: d, sub_department: s, project });
    await loadTasks();
    const tr = document.querySelector(`tr[data-id="${created.id}"]`);
    if (!tr) return;
    tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const nameCell = tr.querySelector('td[data-col="name"]');
    if (nameCell) {
      enterCellEdit(nameCell, created.id, 'name');
      const input = nameCell.querySelector('input');
      if (input) input.select();
    }
  });
}

// v4.61: map a (department, sub_department) section to the team discipline
// that owns it. Used by the action-creation flow to auto-assign a new
// action to that discipline's Placeholder member so the manager can see
// the action in their queue and reassign to a real person later.
function disciplineForSection(deptKey, subKey) {
  // Sub-department wins when present (most specific).
  if (subKey === 'mech')     return 'mech';
  if (subKey === 'controls') return 'controls';
  if (subKey === 'build')    return 'build';
  if (subKey === 'wire')     return 'wire';
  // General engineering (HMI / Robot / Vision crosses mech + controls) —
  // default to controls since most general engineering work is software.
  if (subKey === 'general')  return 'controls';
  // Section 50 install sub-departments.
  if (subKey === 'shop')        return 'build';
  if (subKey === 'engineering') return 'mech';
  // Department-level fallbacks (no sub picked).
  if (deptKey === 'teardown')    return 'build';
  if (deptKey === 'install')     return 'build';
  if (deptKey === 'engineering') return 'mech';
  if (deptKey === 'shop')        return 'build';
  // Procurement / unknown sections: no auto-assign.
  return null;
}
// v4.61: pick the Placeholder team member for a given discipline. Returns
// the name string (e.g. "ME Placeholder") or null if no placeholder exists
// in that discipline (in which case the caller leaves the assignee blank).
function placeholderNameForDiscipline(discKey) {
  if (!discKey) return null;
  const ph = (state.team || []).find(m => m.discipline === discKey && isPlaceholder(m.name));
  return ph ? ph.name : null;
}

// v4.46: + Add action — same flow as newTaskInline but with is_action = 1
// and milestone defaults (duration 0). If the user is currently in
// 'schedule' actions-mode, the new action would be filtered out of view
// after the save, so we auto-switch to 'combined' so they can see it.
// v4.61: auto-assign to the section's discipline Placeholder so the manager
// can see + triage. User can still edit the assignee inline after creation.
function newActionInline() {
  if (!state.filters.project) {
    alert('Pick a specific project tab first — actions attach to the active project. "All projects" is an aggregate view.');
    return;
  }
  const btn = document.getElementById('btn-add-action');
  const r = btn.getBoundingClientRect();
  showSectionPicker(r.right - 280, r.bottom + 6, async (g, d, s) => {
    const project = state.filters.project;
    const discKey = disciplineForSection(d, s);
    const placeholderName = placeholderNameForDiscipline(discKey);
    const created = await api.create({
      name: 'New action',
      phase_group: g,
      department: d,
      sub_department: s,
      project,
      is_action: 1,
      duration_days: 0,
      is_milestone: 1,
      ...(placeholderName ? { assignee: placeholderName } : {}),
    });
    // If we're in Schedule mode (actions hidden), bump to Combined so
    // the user can actually see what they just created. Don't override
    // an explicit Actions-only choice.
    if (state.scheduleView.actionsMode === 'schedule') {
      state.scheduleView.actionsMode = 'combined';
      saveScheduleView();
      syncActionsModeButtons();
    }
    await loadTasks();
    const tr = document.querySelector(`tr[data-id="${created.id}"]`);
    if (!tr) return;
    tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const nameCell = tr.querySelector('td[data-col="name"]');
    if (nameCell) {
      enterCellEdit(nameCell, created.id, 'name');
      const input = nameCell.querySelector('input');
      if (input) input.select();
    }
  });
}

async function deleteTaskById(id) {
  // Anchor milestones (Receipt of PO, FAT) are project-spine markers and aren't deletable.
  const t = state.tasks.find(x => x.id === id);
  if (t && t.anchor_key) {
    await showAlertDialog({
      title: 'Anchor milestones are protected',
      message: `"${t.name}" is an anchor milestone and can't be deleted. You can still edit its date, predecessors, and progress like any other task.`,
    });
    return;
  }
  // No confirmation popup — right-click → Delete is already 2 intentional clicks.
  // User explicitly requested this.
  await api.remove(id);
  await loadTasks();
}

// Right-click on a group header → "Add task here" creates a task directly in that
// section (including phase-group level for cross-cutting tasks like Perform FAT).
// Right-click on a task row → "Move to section…" or "Delete task".
function handleRowContextMenu(e) {
  const headerTr = e.target.closest('tr.group-header');
  if (headerTr) {
    e.preventDefault();
    const path = headerTr.dataset.path || '';
    if (path === '__unassigned__') {
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Add task here', onClick: () => createTaskInSection(null, null, null) },
      ]);
      return;
    }
    const [g, d, s] = path.split('/');
    const items = [
      { label: 'Add task here', onClick: () => createTaskInSection(g || null, d || null, s || null) },
    ];
    // Phase-group header (level-1, no department) — make cross-cutting affordance explicit.
    if (g && !d) {
      items[0].label = 'Add cross-cutting task here';
    }
    showContextMenu(e.clientX, e.clientY, items);
    return;
  }
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  e.preventDefault();
  const id = Number(tr.dataset.id);
  const task = state.tasks.find(t => t.id === id);
  const items = [
    { label: '＋ Add additional resource', onClick: () => addAdditionalResource(id) },
    { label: 'Move to section…', onClick: () => moveTaskInline(id, e.clientX, e.clientY) },
    { label: 'Delete task', danger: true, onClick: () => deleteTaskById(id) },
  ];
  // Milestones / anchors / backlog rows aren't "resources" — duplicating
  // them as additional resources doesn't make sense. Hide the option.
  if (task && (task.is_milestone || inferredAnchorKey(task) || isBacklogTask(task))) {
    items.shift();
  }
  showContextMenu(e.clientX, e.clientY, items);
}

// Right-click → "Add additional resource". Duplicates a task row as the
// next-numbered resource of the same kind:
//   - "Builder 1"        → "Builder 2"
//   - "Builder"          → "Builder 2"
//   - "Mechanical Design 2" → "Mechanical Design 3"
// New task inherits department / sub_department / phase_group, duration,
// allocation, priority, dates, and lands right below the source in
// sort_order. Predecessor is set to "<source_id>FF" so the new resource
// finishes alongside the original (typical "extra body on the same work"
// pattern). Assignee is intentionally blank — caller staffs the new line
// from the dropdown.
async function addAdditionalResource(sourceId) {
  const src = state.tasks.find(t => t.id === sourceId);
  if (!src) return;
  // Increment a trailing number, preserving the separator the user used. We
  // recognize space, dash, or underscore before the number — so "Builder 1"
  // → "Builder 2", "Machine Wiring-1" → "Machine Wiring-2",
  // "Test_Engineer_3" → "Test_Engineer_4". If the name has no trailing
  // number, append " 2".
  const TRAILING_NUM = /^(.*?)([\s\-_])(\d+)\s*$/;
  const m = String(src.name || '').match(TRAILING_NUM);
  let newName;
  if (m) {
    newName = `${m[1]}${m[2]}${Number(m[3]) + 1}`;
  } else {
    newName = `${(src.name || 'Resource').trim()} 2`;
  }
  // Find next available number in case the next-step name already exists.
  const siblingNames = new Set(
    state.tasks
      .filter(t => t.project === src.project)
      .map(t => String(t.name || '').trim().toLowerCase())
  );
  let attempts = 0;
  while (siblingNames.has(newName.trim().toLowerCase()) && attempts < 50) {
    const mm = newName.match(TRAILING_NUM);
    if (mm) newName = `${mm[1]}${mm[2]}${Number(mm[3]) + 1}`;
    else    newName = `${newName.trim()} 2`;
    attempts++;
  }
  // Drop the new row at the MIDPOINT between the source's sort_order and the
  // next task in the project (sorted by sort_order). Using a fractional
  // midpoint sidesteps the need to bump every downstream row, AND
  // sidesteps the "everything else in this bucket has weird sort_orders"
  // problem we saw on real projects (where Machine Power-Up's sort_order
  // was sandwiched between wire-section tasks and the new row ended up at
  // the bottom). The server stores fractional values as-is in the
  // INTEGER-affinity column (SQLite's type system is flexible).
  const projectTasks = state.tasks
    .filter(t => t.project === src.project)
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const idx = projectTasks.findIndex(t => t.id === src.id);
  const next = idx >= 0 ? projectTasks[idx + 1] : null;
  const srcOrder = Number(src.sort_order) || 0;
  const nextOrder = next ? Number(next.sort_order) : null;
  const newOrder = (nextOrder != null && nextOrder > srcOrder)
    ? (srcOrder + nextOrder) / 2
    : srcOrder + 0.5;

  const payload = {
    name: newName,
    project: src.project,
    phase: src.phase || null,
    phase_group: src.phase_group || null,
    department: src.department || null,
    sub_department: src.sub_department || null,
    assignee: null,
    start_date: src.start_date || null,
    end_date: src.end_date || null,
    duration_days: src.duration_days != null ? src.duration_days : null,
    predecessors: `${src.id}FF`,
    is_milestone: 0,
    progress: 0,
    allocation: src.allocation == null ? 90 : src.allocation,
    priority: 1,
    notes: null,
    sort_order: newOrder,
  };
  const created = await api.create(payload);
  pushUndoSnapshot(src, ['name'], `Add additional resource (${newName})`);
  await loadTasks();
  // Scroll the new row into view + focus its name cell so the user can
  // immediately rename if the auto-increment isn't quite right.
  const tr = document.querySelector(`tr[data-id="${created.id}"]`);
  if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function createTaskInSection(g, d, s) {
  const project = state.filters.project || null;
  const created = await api.create({ name: 'New task', phase_group: g, department: d, sub_department: s, project });
  await loadTasks();
  const tr = document.querySelector(`tr[data-id="${created.id}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const nameCell = tr.querySelector('td[data-col="name"]');
  if (nameCell) {
    enterCellEdit(nameCell, created.id, 'name');
    const input = nameCell.querySelector('input');
    if (input) input.select();
  }
}

function moveTaskInline(id, x, y) {
  showSectionPicker(x, y, async (g, d, s) => {
    await api.update(id, { phase_group: g, department: d, sub_department: s });
    await loadTasks();
  });
}

function showContextMenu(x, y, items) {
  const existing = document.getElementById('row-context-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.id = 'row-context-menu';
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    if (item.danger) btn.classList.add('danger');
    btn.addEventListener('click', () => { menu.remove(); item.onClick(); });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  setTimeout(() => {
    const onDoc = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', onDoc);
      }
    };
    document.addEventListener('mousedown', onDoc);
  }, 0);
}

// In-app confirmation popup anchored next to a click point. Replaces native
// `confirm()` (which opens a centered browser-chrome dialog far from wherever
// the user clicked — disorienting). Returns a Promise<boolean>: resolves true
// if Confirm was clicked, false if Cancel or clicking outside.
//
// Usage:
//   if (await showConfirmAt(e.clientX, e.clientY, { message: '...', confirmLabel: 'Yes', danger: true })) {
//     // proceed
//   }
function showConfirmAt(x, y, opts = {}) {
  return new Promise((resolve) => {
    // Tear down any previous popup so back-to-back actions don't stack.
    document.getElementById('confirm-popup')?.remove();
    const pop = document.createElement('div');
    pop.id = 'confirm-popup';
    pop.className = 'confirm-popup';
    pop.innerHTML = `
      <div class="confirm-popup-message">${escapeHtml(opts.message || 'Are you sure?')}</div>
      <div class="confirm-popup-actions">
        <button type="button" class="confirm-popup-cancel">${escapeHtml(opts.cancelLabel || 'Cancel')}</button>
        <button type="button" class="confirm-popup-ok ${opts.danger ? 'is-danger' : ''}">${escapeHtml(opts.confirmLabel || 'Confirm')}</button>
      </div>
    `;
    document.body.appendChild(pop);
    // Anchor near the click. Clamp into viewport so it doesn't render
    // partially off-screen if you clicked near an edge.
    const pad = 8;
    const w = pop.offsetWidth || 260;
    const h = pop.offsetHeight || 100;
    let left = Math.min(window.innerWidth - w - pad, Math.max(pad, x));
    let top  = Math.min(window.innerHeight - h - pad, Math.max(pad, y));
    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';

    const cleanup = (result) => {
      pop.remove();
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      resolve(!!result);
    };
    const onOutside = (ev) => { if (!pop.contains(ev.target)) cleanup(false); };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); cleanup(false); }
      else if (ev.key === 'Enter') { ev.preventDefault(); cleanup(true); }
    };
    pop.querySelector('.confirm-popup-cancel').addEventListener('click', () => cleanup(false));
    pop.querySelector('.confirm-popup-ok').addEventListener('click', () => cleanup(true));
    // Defer the outside-click listener by a tick so the click that opened the
    // popup doesn't immediately close it via document-level bubbling.
    setTimeout(() => {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  });
}

// ---------- Financial milestones ----------
// Per-project payment events (Down Payment, FAT acceptance, etc.). Independent from
// tasks — no grid row, no predecessors — but they participate in the Gantt overlay
// when the $ Financial toolbar toggle is on. Auto-seeded from the
// default_financial_milestones setting the first time the modal opens or the overlay
// is enabled for a project that doesn't have any yet.

// Pull the financials for one project, seeding defaults first if the project has none.
// Caches into state.financials[project] so multiple consumers (modal + overlay) share
// the same array and re-renders just need a refreshFinancials() call.
async function loadFinancialsForProject(project) {
  if (!project) return [];
  let rows = await api.financials.list(project);
  if ((!rows || rows.length === 0) && !state._financialsSeededFor?.[project]) {
    (state._financialsSeededFor ||= {})[project] = true;
    await api.financials.seed(project);
    rows = await api.financials.list(project);
  }
  // Apply anchor-sync overrides — if a row points at an anchor (e.g. 'fat'), its
  // due_date follows the predecessor's date for display. Edits to the row's date
  // still save, but the live value reflects the trigger each render.
  for (const r of rows) {
    const computed = computeFinancialTriggerDate(r.predecessors, project);
    if (computed) r.due_date = computed;
  }
  state.financials[project] = rows;
  return rows;
}

// Resolve a financial milestone predecessor ref to both the target task AND the
// derived date. Used by the overlay drawing code (which needs the task to anchor
// the line vertically) and by date display (which needs only the date).
// Accepts:
//   - Anchor aliases: PO / Receipt of PO / Power-Up / Powerup / PU / FAT / Ship /
//     Ship Machine — case-insensitive
//   - Task line numbers: same syntax as task predecessors (5, 5FS, 5FF +1w, etc.)
//   - Both can be combined with an optional FS/SS/FF/SF and lag: "FAT +1w"
// Returns { task, date } or null if unresolvable.
function resolveFinancialTrigger(ref, project) {
  if (!ref) return null;
  const trimmed = String(ref).trim();
  if (!trimmed) return null;
  // Strip a trailing "<type><lag>" piece off the end, leaving the prefix as a
  // task ref (line number) or an anchor alias.
  const m = trimmed.match(/^(.+?)(?:\s*(FS|SS|FF|SF))?(?:\s*([+-]\s*\d+)\s*([wd])?)?$/i);
  if (!m) return null;
  const prefix = m[1].trim();
  const type = (m[2] || 'FS').toUpperCase();
  let lagDays = 0;
  if (m[3]) {
    const n = Number(m[3].replace(/\s+/g, ''));
    lagDays = (m[4] || 'd').toLowerCase() === 'w' ? n * 5 : n;
  }
  // Resolve prefix → task object on the same project.
  let target = null;
  const aliases = {
    po: 'receipt_of_po',
    'receipt of po': 'receipt_of_po',
    receipt: 'receipt_of_po',
    'power-up': 'machine_power_up',
    'power up': 'machine_power_up',
    powerup: 'machine_power_up',
    pu: 'machine_power_up',
    'machine power-up': 'machine_power_up',
    fat: 'fat',
    ship: 'ship_machine',
    'ship machine': 'ship_machine',
  };
  const aliasKey = aliases[prefix.toLowerCase()];
  if (aliasKey) {
    target = state.tasks.find(t => t.project === project && inferredAnchorKey(t) === aliasKey);
  }
  if (!target) {
    const n = Number(prefix);
    if (Number.isInteger(n) && taskIdByLine[n]) {
      target = state.tasks.find(t => t.id === taskIdByLine[n]);
    }
  }
  if (!target) return null;
  let baseDate = (type === 'FS' || type === 'FF') ? target.end_date : target.start_date;
  if (!baseDate) return null;
  const shift = lagDays + (type === 'FS' ? 1 : 0);
  const date = shift === 0 ? baseDate : addBusinessDaysClient(baseDate, shift);
  return { task: target, date };
}

// Convenience: just the derived date string (used in modal + overlay date pos).
function computeFinancialTriggerDate(ref, project) {
  return resolveFinancialTrigger(ref, project)?.date || null;
}

// Add `n` business days to an ISO date (Mon–Fri math, mirrors server.js). Returns
// ISO date string. Negative n walks backwards. n=0 is a no-op.
function addBusinessDaysClient(dateStr, n) {
  if (!dateStr) return null;
  if (!n) return dateStr;
  const d = new Date(dateStr + 'T00:00:00Z');
  let remaining = Math.abs(n);
  const dir = n >= 0 ? 1 : -1;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + dir);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return d.toISOString().slice(0, 10);
}

// Pull financials for every project we currently know about. Used when the overlay
// toggle flips on so the Gantt has data for every project rendered.
async function loadFinancialsForAllOpenProjects() {
  const projects = uniqueValues('project').filter(Boolean);
  for (const p of projects) await loadFinancialsForProject(p);
}

// Centered modal popup for the per-project Financial Milestones editor. Same
// editable table the inline panel was hosting, just in a modal so the user gets
// a focused view instead of pushing the schedule grid down. Adding a new milestone
// drops an empty row at the bottom of the table and focuses its Name cell — no
// blocking JS prompt at the top of the window.
// Quote vs Schedule comparison. Fetches the persisted quote (saved when the
// project was created from an estimate sheet) and compares it to the live
// scheduled hours. If no quote was saved (older project, manual creation,
// Smartsheet import), offers an in-modal "Load estimate file…" button so the
// user can pick the original xlsx and populate the comparison without
// recreating the project.
async function openQuoteCompareModal(project, providedQuote) {
  if (!project) {
    await showAlertDialog('Pick a project tab first.');
    return;
  }
  document.getElementById('quote-compare-modal')?.remove();

  // Fetch the persisted quote unless one was passed in (e.g. from the
  // "Load estimate file…" flow).
  let quote = providedQuote || null;
  if (!quote) {
    try {
      const r = await fetch(`/api/project/${encodeURIComponent(project)}/quote`);
      if (r.ok) quote = await r.json();
    } catch (_) {}
  }

  // Walk the project's tasks and sum hours per task-bucket.
  // Bucket map: task name → key (matches the buckets in /api/estimate/create).
  const TASK_BUCKET = (t) => {
    // Strip a trailing " N", "-N", or "_N" before matching so duplicated
    // resources (e.g. "Wire Machine 2", "Builder-3", "Mechanical Design 2"
    // created via "+ Add additional resource") still bucket into their
    // original category instead of falling through to the generic
    // sub-department fallback. Match against both raw name and base name.
    const raw = String(t.name || '').trim();
    const base = raw.replace(/[\s\-_]\d+\s*$/, '').trim();
    // Test either form — covers schedules where the user typed names that
    // don't match the SDC_Template naming convention (e.g. "CE Design"
    // instead of "Controls Design", "Machine Wiring" vs "Wire Machine").
    const test = (re) => re.test(base) || re.test(raw);
    const pg = t.phase_group, d = t.department, sd = t.sub_department;
    if (test(/^configure machine/i))                return 'configure';
    if (test(/test\/?debug.*engineer/i))            return 'test_debug';
    if (test(/^shop debug/i))                       return 'shop_debug';
    if (test(/^(controls|ce)[\s\-_]?software/i))    return 'ce_software';
    if (test(/^(controls|ce)[\s\-_]?design/i))      return 'ce_design';
    if (test(/^(controls|ce)[\s\-_]?drawings?/i))   return 'ce_drawings';
    if (test(/^hmi/i))                              return 'gen_hmi';
    if (test(/^robot/i))                            return 'gen_robot';
    if (test(/^vision/i))                           return 'gen_vision';
    // Wire panel — both word orders ("Build and Wire Panel", "Wire Panel",
    // "Panel Build", "Panel Wiring") roll into wire_panel.
    if (test(/wire[\s\-_]?panel|panel[\s\-_]?(build|wir)/i)) return 'wire_panel';
    // Wire machine — both orders ("Wire Machine", "Machine Wiring") roll
    // into wire_machine.
    if (test(/wire[\s\-_]?machine|machine[\s\-_]?wir/i))    return 'wire_machine';
    // Build / Mechanical build / Builder / Build Machine
    if (test(/^(build|builder)\b/i) && pg === 'design_build')                  return 'build';
    if (test(/^(mech|mechanical)[\s\-_]?(design|eng)/i) && pg === 'design_build') return 'mech_eng';
    // Sub-department fallbacks for anything that didn't match by name.
    if (pg === 'design_build' && sd === 'mech')     return 'mech_eng';
    if (pg === 'design_build' && sd === 'build')    return 'build';
    if (pg === 'design_build' && sd === 'wire')     return 'wire_other';
    if (pg === 'teardown_install' && d === 'teardown') return 'teardown';
    if (pg === 'teardown_install' && d === 'install')  return 'install';
    return null;
  };
  // Per-bucket: scheduled hours + remaining hours (scheduled × (1 - progress/100)
  // summed per task, so partial-completion across multiple tasks rolls up cleanly).
  const scheduled = {};
  const remaining = {};
  for (const t of state.tasks) {
    if (t.project !== project) continue;
    if (t.is_milestone || t.anchor_key) continue;
    if (isBacklogTask(t)) continue;
    const k = TASK_BUCKET(t);
    if (!k) continue;
    const hrs = (Number(t.duration_days) || 0) * 8 * ((Number(t.allocation) || 90) / 100);
    const pct = Math.max(0, Math.min(100, Number(t.progress) || 0));
    const remHrs = hrs * (1 - pct / 100);
    scheduled[k] = (scheduled[k] || 0) + hrs;
    remaining[k] = (remaining[k] || 0) + remHrs;
  }

  // Pull the quoted hours by the same bucket. Quote stores hours_breakdown
  // per section per task-aligned cell (mech, ce_des, ce_drw, ce_sw, hmi,
  // robot, vision, build, wire_panel, wire_machine).
  const safe = (v) => Math.round(v || 0);
  const hb = quote?.hours_breakdown;
  const s10 = hb?.section_10 || {}, s40 = hb?.section_40 || {}, s50 = hb?.section_50 || {};
  const quoted = {
    mech_eng:    safe(s10.mech) + safe(s50.mech),
    ce_design:   safe(s10.ce_des),
    ce_drawings: safe(s10.ce_drw),
    ce_software: safe(s10.ce_sw),
    gen_hmi:     safe(s10.hmi)    + safe(s40.hmi),
    gen_robot:   safe(s10.robot)  + safe(s40.robot),
    gen_vision:  safe(s10.vision) + safe(s40.vision),
    build:       safe(s10.build),
    wire_panel:  safe(s10.wire_panel),
    wire_machine: safe(s10.wire_machine),
    // Section 40 testing engineering — Configure (5%) + Test/Debug 1+2 (95%)
    // split out. We compare totals to the sum of those tasks.
    test_debug:  safe(s40.mech) + safe(s40.ce_des) + safe(s40.ce_drw) + safe(s40.ce_sw)
                 + safe(s40.hmi) + safe(s40.robot) + safe(s40.vision),
    configure:   0, // configure hours are part of the testing bucket (5% slice)
    shop_debug:  safe(s40.build) + safe(s40.wire_panel) + safe(s40.wire_machine),
    teardown:    safe(s50.build) + safe(s50.wire_panel) + safe(s50.wire_machine),
    install:     safe(s50.ce_des) + safe(s50.ce_drw) + safe(s50.ce_sw)
                 + safe(s50.hmi) + safe(s50.robot) + safe(s50.vision),
  };
  // Configure Machine = 5% of testing engineering hours.
  quoted.configure = Math.round(quoted.test_debug * 0.05);
  quoted.test_debug = quoted.test_debug - quoted.configure;

  // Rows grouped by section (matches the SDC_Template + estimate-sheet
  // hierarchy: 10 → Design & Build, 40 → Machine Testing/Debug, 50 →
  // Teardown & Install). Each section is a header row; the bucket rows live
  // underneath it. Same bucket model as before — totals across all sections
  // for that discipline — just organized for reading.
  const SECTIONS = [
    {
      title: 'Section 10 — Design & Build',
      rows: [
        { k: 'mech_eng',     label: 'Mechanical Engineering' },
        { k: 'ce_design',    label: 'Controls Design' },
        { k: 'ce_drawings',  label: 'Controls Drawings' },
        { k: 'ce_software',  label: 'Controls Software' },
        { k: 'gen_hmi',      label: 'HMI Programming' },
        { k: 'gen_robot',    label: 'Robot Programming' },
        { k: 'gen_vision',   label: 'Vision Programming' },
        { k: 'build',        label: 'Mechanical Build' },
        { k: 'wire_panel',   label: 'Build and Wire Panel' },
        { k: 'wire_machine', label: 'Wire Machine' },
      ],
    },
    {
      title: 'Section 40 — Machine Testing / Debug',
      rows: [
        { k: 'configure',  label: 'Configure Machine' },
        { k: 'test_debug', label: 'Test/Debug Engineer (lead + secondary)' },
        { k: 'shop_debug', label: 'Shop Debug' },
      ],
    },
    {
      title: 'Section 50 — Teardown & Install',
      rows: [
        { k: 'teardown', label: 'Teardown' },
        { k: 'install',  label: 'Install' },
      ],
    },
  ];

  let totalQ = 0, totalS = 0, totalR = 0;
  const rowHtml = (r) => {
    const q = quoted[r.k] || 0;
    const s = Math.round(scheduled[r.k] || 0);
    const rem = Math.round(remaining[r.k] || 0);
    totalQ += q; totalS += s; totalR += rem;
    const variance = s - q;
    // Color the variance: green when scheduled is below quote (under-budget),
    // amber when within 10% over quote, red when more than 10% over.
    let varCls = 'var-zero';
    if (q > 0) {
      if (variance < 0) varCls = 'var-under';
      else if (variance > q * 0.10) varCls = 'var-over';
      else if (variance > 0) varCls = 'var-near';
    }
    const varText = q === 0 ? '—' : (variance > 0 ? '+' : '') + variance.toLocaleString();
    return `<tr>
      <td>${escapeHtml(r.label)}</td>
      <td class="num quote-sched-cell">
        <span class="quote-sched-q">${q ? q.toLocaleString() : '—'}</span>
        <span class="quote-sched-slash">/</span>
        <span class="quote-sched-s">${s.toLocaleString()}</span>
      </td>
      <td class="num quote-variance ${varCls}">${varText}</td>
      <td class="num">${rem.toLocaleString()}</td>
    </tr>`;
  };
  const rowsHtml = SECTIONS.map(section => `
    <tr class="section-head"><td colspan="4">${escapeHtml(section.title)}</td></tr>
    ${section.rows.map(rowHtml).join('')}
  `).join('');
  const totalV = totalS - totalQ;

  const overlay = document.createElement('div');
  overlay.id = 'quote-compare-modal';
  overlay.className = 'modal-overlay app-dialog-overlay';
  overlay.innerHTML = `
    <div class="modal-card" style="max-width: 720px;">
      <div class="modal-head">
        <h2>Quote vs Schedule — ${escapeHtml(project)}</h2>
        <button class="modal-close" type="button">×</button>
      </div>
      <div class="modal-body">
        ${quote
          ? `<div style="margin:0 0 12px;font-size:12px;color:#475569;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="flex:1 1 auto;min-width:240px;">Comparing the saved estimate hours against the live scheduled hours (duration × allocation × 8 per task).</span>
              <button type="button" class="quote-action-btn" data-action="financials" title="Open the per-project Financial Milestones editor (billing events tied to anchors, e.g. 30% at PO / 60% at FAT / 10% at Ship). Stays open on top so you can confirm billing while the comparison is still in view.">$ Financial Milestones</button>
              <label class="btn-ghost" style="cursor:pointer;border:1px solid #cbd5e1;color:#334155;padding:4px 10px;font-size:12px;font-weight:600;border-radius:4px;background:white;">
                Replace estimate…
                <input type="file" accept=".xlsx" id="quote-compare-file" style="display:none;">
              </label>
            </div>`
          : `<div style="margin:0 0 12px;font-size:12px;color:#b45309;background:#fef3c7;padding:10px 12px;border-radius:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="flex:1 1 auto;min-width:240px;">No estimate attached to this project. Load the estimate xlsx — it'll be saved on the project so future opens of this modal load it automatically.</span>
              <button type="button" class="quote-action-btn" data-action="financials" title="Open the per-project Financial Milestones editor. You can still edit billing milestones even without an estimate attached.">$ Financial Milestones</button>
              <label class="btn-ghost" style="cursor:pointer;border:1px solid #d97706;color:#b45309;padding:4px 10px;font-size:12px;font-weight:600;border-radius:4px;background:white;">
                Attach estimate…
                <input type="file" accept=".xlsx" id="quote-compare-file" style="display:none;">
              </label>
            </div>`}
        <table class="quote-compare-table">
          <thead>
            <tr>
              <th style="text-align:left;">Discipline</th>
              <th class="num" title="Quoted (from estimate sheet) / Scheduled (live SUM of duration_days × 8 × allocation% per task in this bucket). — means no quote attached.">Quoted / Scheduled</th>
              <th class="num" title="Scheduled minus Quoted. Negative = under budget. Green ≤ quote, amber within 10% over, red &gt;10% over.">Variance</th>
              <th class="num" title="Scheduled hours still to be worked: SUM(task_scheduled_hrs × (1 − task_progress%/100)) per bucket.">Remaining</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
          <tfoot>
            <tr class="totals-row">
              <td>Total</td>
              <td class="num quote-sched-cell">
                <span class="quote-sched-q">${totalQ ? totalQ.toLocaleString() : '—'}</span>
                <span class="quote-sched-slash">/</span>
                <span class="quote-sched-s">${totalS.toLocaleString()}</span>
              </td>
              <td class="num quote-variance ${totalQ === 0 ? 'var-zero' : (totalV < 0 ? 'var-under' : (totalV > totalQ * 0.10 ? 'var-over' : (totalV > 0 ? 'var-near' : 'var-zero')))}">${totalQ === 0 ? '—' : (totalV > 0 ? '+' : '') + totalV.toLocaleString()}</td>
              <td class="num">${totalR.toLocaleString()}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-primary" data-action="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').onclick = close;
  overlay.querySelector('[data-action="close"]').onclick = close;
  // "$ Financial Milestones" button lives in the modal BODY (top banner row)
  // instead of the footer — moved in v3.60 since users said they couldn't
  // find it down at the bottom. Opens the per-project financials editor on
  // top so they can confirm or tweak billing while still seeing the hours
  // comparison.
  overlay.querySelector('[data-action="financials"]').onclick = () => {
    openFinancialsModal(project);
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // "Load estimate file…" — pick an xlsx, parse it, PERSIST the quote on the
  // project so future opens of this modal show the comparison without
  // re-loading. Reopens this modal with the saved quote.
  const fileEl = overlay.querySelector('#quote-compare-file');
  if (fileEl) {
    fileEl.addEventListener('change', async () => {
      const file = fileEl.files?.[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const r = await fetch('/api/estimate/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: b64 }),
        });
        const parsed = await r.json();
        if (!r.ok) { await showAlertDialog({ title: "Couldn't parse estimate", message: parsed.error || 'Unknown error.' }); return; }
        const safe = (v) => Math.round(v || 0);
        const buildSection = (s) => ({
          mech:         safe(s.mech_eng),
          ce_des:       Math.round(safe(s.ce_design) * 0.5),
          ce_drw:       safe(s.ce_design) - Math.round(safe(s.ce_design) * 0.5),
          ce_sw:        safe(s.ce_software),
          hmi:          safe(s.gen_hmi),
          robot:        safe(s.gen_robot),
          vision:       safe(s.gen_vision),
          build:        safe(s.mech_build),
          wire_panel:   Math.round(safe(s.elec_build) * 0.25),
          wire_machine: safe(s.elec_build) - Math.round(safe(s.elec_build) * 0.25),
        });
        const reloadedQuote = {
          hours_per_section: parsed.hours_per_section,
          hours_breakdown: {
            section_10: buildSection(parsed.hours_per_section.section_10),
            section_40: buildSection(parsed.hours_per_section.section_40),
            section_50: buildSection(parsed.hours_per_section.section_50),
          },
        };
        // Persist on the project so future opens of this modal load it
        // automatically — no need to pick the file every time.
        try {
          await fetch(`/api/project/${encodeURIComponent(project)}/quote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reloadedQuote),
          });
        } catch (_) {}
        close();
        openQuoteCompareModal(project, reloadedQuote);
      } catch (err) {
        await showAlertDialog({ title: "Couldn't read file", message: err.message || String(err) });
      }
    });
  }
}

function openFinancialsModal(project) {
  if (!project) {
    alert('Pick a project tab first — financial milestones live on a specific project.');
    return;
  }
  // Remove any previous instance
  document.getElementById('financials-modal-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'financials-modal-backdrop';
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'financials-modal';
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  // Synchronous skeleton so the modal isn't an empty dark backdrop while async data loads.
  modal.innerHTML = `
    <div class="modal-head">
      <div class="modal-title">
        <h2>Financial milestones</h2>
        <div class="modal-subtitle">${escapeHtml(project)}</div>
      </div>
      <button type="button" class="modal-close" title="Close">×</button>
    </div>
    <div class="financials-loading">Loading financial milestones…</div>
  `;

  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  modal.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });

  // Re-rendered on every render() so the checkbox reflects the current overlay state.
  const headHtml = () => `
    <div class="modal-head">
      <div class="modal-title">
        <h2>Financial milestones</h2>
        <div class="modal-subtitle">${escapeHtml(project)}</div>
      </div>
      <div class="financials-head-actions">
        <label class="financials-show-on-gantt" title="Overlay these milestones as $ diamonds along the top of the Gantt">
          <input type="checkbox" id="financials-show-on-gantt" ${state.showFinancials ? 'checked' : ''} />
          <span>Show on Gantt</span>
        </label>
        <button type="button" class="modal-close" title="Close">×</button>
      </div>
    </div>`;

  const render = async (opts = {}) => {
    let rows;
    try {
      rows = state.financials[project] || await loadFinancialsForProject(project);
    } catch (err) {
      console.error('Failed to load financials', err);
      rows = [];
    }
    if (state._financialsApiBroken) {
      modal.innerHTML = headHtml() + `
        <div class="financials-error">
          <p><strong>Financial milestones aren't available yet.</strong></p>
          <p>The server needs to be restarted to add the financial milestones table and API endpoints. Stop the running server and re-launch it — then refresh this page.</p>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn-primary" id="financials-done">Close</button>
        </div>
      `;
      modal.querySelector('.modal-close').addEventListener('click', close);
      modal.querySelector('#financials-done').addEventListener('click', close);
      return;
    }
    modal.innerHTML = headHtml() + `
      <div class="financials-table-wrap">
        <table class="financials-table">
          <thead>
            <tr>
              <th>Name</th>
              <th title="Predecessor — anchor name (PO / Power-Up / FAT / Ship) or task line number, with optional lag like '+1w'.">Trigger</th>
              <th>Date</th>
              <th class="num">%</th>
              <th class="paid" title="Check when the invoice has been sent. The Gantt line goes from dashed to solid.">Sent</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const derived = computeFinancialTriggerDate(r.predecessors, project);
              const dateValue = derived || r.due_date || '';
              const dateDisabled = !!derived;
              return `
                <tr data-id="${r.id}">
                  <td><input type="text" data-field="name" value="${escapeHtml(r.name || '')}" placeholder="e.g. Down Payment" /></td>
                  <td><input type="text" data-field="predecessors" value="${escapeHtml(r.predecessors || '')}" placeholder="e.g. FAT  or  FAT +1w" /></td>
                  <td>
                    <input type="date" data-field="due_date" value="${dateValue}"
                      ${dateDisabled ? 'disabled title="Auto-derived from the Trigger — clear Trigger to set manually"' : ''} />
                  </td>
                  <td class="num"><input type="number" min="0" step="any" data-field="percent" value="${r.percent ?? ''}" /></td>
                  <td class="paid"><input type="checkbox" data-field="paid" ${r.paid ? 'checked' : ''} /></td>
                  <td><button type="button" class="remove-btn" data-action="delete" title="Delete">×</button></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost btn-tight" id="financials-add">+ Add milestone</button>
        <button type="button" class="btn-primary" id="financials-done">Done</button>
      </div>
    `;
    bindFinancialsModalHandlers();

    // If the last action was an Add, scroll to + focus the new last row's Name cell
    // so the user can type immediately (no blocking prompt needed).
    if (opts.focusLastNameInput) {
      const lastRow = modal.querySelector('tbody tr:last-child input[data-field="name"]');
      if (lastRow) { lastRow.focus(); lastRow.select(); }
    }
  };

  const bindFinancialsModalHandlers = () => {
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.querySelector('#financials-done').addEventListener('click', close);

    // Show on Gantt checkbox — drives the same state.showFinancials flag the
    // Filters popover view-options toggle uses. Re-renders the Gantt immediately
    // so the user sees the overlay appear/disappear without closing the modal.
    // Also refresh the filters popover so its toggle reflects the new state.
    const showCb = modal.querySelector('#financials-show-on-gantt');
    if (showCb) {
      showCb.addEventListener('change', async () => {
        state.showFinancials = showCb.checked;
        saveScheduleView();
        if (state.showFinancials) await loadFinancialsForAllOpenProjects();
        renderFilters();
        renderGantt();
      });
    }

    modal.querySelectorAll('tbody tr[data-id]').forEach(tr => {
      const id = Number(tr.dataset.id);
      tr.querySelectorAll('input[data-field], select[data-field]').forEach(el => {
        el.addEventListener('change', async () => {
          const field = el.dataset.field;
          let value;
          if (el.type === 'checkbox') value = el.checked ? 1 : 0;
          else if (el.type === 'number') value = el.value === '' ? null : Number(el.value);
          else value = el.value || null;
          await api.financials.update(id, { [field]: value });
          await loadFinancialsForProject(project);
          await render();
          if (state.showFinancials) renderGantt();
        });
      });
      tr.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        const row = (state.financials[project] || []).find(r => r.id === id);
        const ok = await showConfirmDialog({
          title: 'Delete financial milestone?',
          message: `"${row?.name || 'This milestone'}" will be removed from ${project}.`,
          okLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await api.financials.remove(id);
        await loadFinancialsForProject(project);
        await render();
        if (state.showFinancials) renderGantt();
      });
    });

    // + Add milestone — drops an empty row at the bottom of the table and focuses
    // its Name cell. NO browser prompt(), which was the "stupid-ass pop-up at the
    // top of the window" — that's the native JS prompt and there's no way to style
    // or position it. Inline focus is cleaner.
    modal.querySelector('#financials-add').addEventListener('click', async () => {
      await api.financials.create({ project, name: '' });
      await loadFinancialsForProject(project);
      await render({ focusLastNameInput: true });
      if (state.showFinancials) renderGantt();
    });
  };

  render();
}

// Cross-panel row highlight — when the user hovers a grid row, light up the SAME
// row on the Gantt with a translucent horizontal stripe. Lets you cross-reference
// "which bar is task #14" without squinting at the row alignment. The Gantt SVG
// gets a single <rect> injected behind the bar-wrappers; hovering away removes it.
// Bound to tbody so renderTable's innerHTML refresh doesn't require re-binding.
function setupRowCrossHighlight() {
  const tbody = document.getElementById('tasks-tbody');
  if (!tbody) return;
  tbody.addEventListener('mouseover', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    if (tr === tbody._hlRow) return;
    tbody._hlRow = tr;
    highlightGanttRow(tr.dataset.id);
  });
  tbody.addEventListener('mouseleave', () => {
    tbody._hlRow = null;
    highlightGanttRow(null);
  });
}

// Draw (or clear) a translucent horizontal stripe at the Y of the bar-wrapper that
// matches `taskId`. Inserted as the LAST child of the SVG so paint-order puts it
// ON TOP of bars/arrows/diamonds — combined with low fill-opacity that reads as a
// tinted overlay band rather than fully obscuring the work underneath. Going
// "underneath" via insertBefore is fragile because frappe-gantt wraps bar-wrappers
// in nested <g> groups, so cross-node insertBefore throws.
function highlightGanttRow(taskId) {
  const svg = document.querySelector('#gantt-container .gantt');
  if (!svg) return;
  // Always strip the previous highlight first — one row at a time.
  svg.querySelectorAll('.gantt-row-highlight').forEach(el => el.remove());
  if (taskId == null) return;
  const wrap = svg.querySelector(`.bar-wrapper[data-id="${taskId}"]`);
  if (!wrap) return;
  const bar = wrap.querySelector('.bar') || wrap.querySelector('rect');
  if (!bar) return;
  const y = +bar.getAttribute('y');
  const h = +bar.getAttribute('height');
  // SVG width: prefer the width attribute (set by frappe-gantt to total chart width)
  // and fall back to viewBox / a sane default if it's missing for some reason.
  const w = +svg.getAttribute('width') || svg.viewBox?.baseVal?.width || 8000;
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('class', 'gantt-row-highlight');
  rect.setAttribute('x', 0);
  rect.setAttribute('y', y - 4);
  rect.setAttribute('width',  w);
  rect.setAttribute('height', h + 8);
  // Append at the end so it paints on TOP of bars — fill-opacity keeps the bars
  // readable underneath. CSS handles fill and opacity.
  svg.appendChild(rect);
}

// Click-and-drag horizontal pan in the grid panel — same UX as the gantt panel. A 4-px
// movement threshold distinguishes pan from a click on a cell (which still enters edit mode).
function setupGridPan() {
  const panel = document.getElementById('schedule-grid');
  if (!panel) return;
  panel.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('input, select, textarea, button, .row-drag, [draggable="true"]')) return;
    if (e.target.closest('.schedule-divider, .row-height-bar')) return;

    const startX = e.clientX, startY = e.clientY;
    const startScrollLeft = panel.scrollLeft;
    const startScrollTop  = panel.scrollTop;
    let panning = false;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!panning && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        panning = true;
        panel.classList.add('panning');
        // Clear any selection the browser kicked off in the first 4px of mouse
        // movement before we hit the panning threshold. Without this, headers /
        // group rows get a blue highlight that persists until the user clicks
        // somewhere else — especially obvious when the scroll hits the left edge
        // and the drag has nowhere to go.
        try { window.getSelection()?.removeAllRanges(); } catch (_) {}
      }
      if (panning) {
        ev.preventDefault();
        panel.scrollLeft = startScrollLeft - dx;
        panel.scrollTop  = startScrollTop  - dy;
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      panel.classList.remove('panning');
      // If the user actually panned, swallow the click that fires after mouseup so we
      // don't drop into cell-edit mode.
      if (panning) {
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        panel.addEventListener('click', swallow, { capture: true, once: true });
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// v4.72: showSectionPicker accepts an opts.okLabel override (and an opts.title).
// Default "Create" still works for the schedule's + Add task / + Add action
// flows where the picker DOES commit the new task. The Actions page quick-add
// passes okLabel:"Done" because that picker is just stashing the section —
// the actual create happens later when the user hits + Add action.
function showSectionPicker(x, y, onPick, opts = {}) {
  const okLabel = opts.okLabel || 'Create';
  const title   = opts.title   || 'Where should this task go?';
  const existing = document.getElementById('section-picker');
  if (existing) existing.remove();
  const pop = document.createElement('div');
  pop.id = 'section-picker';
  pop.className = 'section-picker';
  // Position offscreen first so we can measure the popup's actual height before
  // deciding whether it fits below the anchor or has to flip above it.
  pop.style.left = '-9999px';
  pop.style.top  = '-9999px';
  pop.innerHTML = `
    <div class="section-picker-title">${escapeHtml(title)}</div>
    <select class="sp-group">
      <option value="">— phase group —</option>
      ${HIERARCHY.map(g => `<option value="${g.key}">${escapeHtml(g.label)}</option>`).join('')}
    </select>
    <select class="sp-dept" disabled><option value="">— pick phase group first —</option></select>
    <select class="sp-sub" disabled><option value="">— optional —</option></select>
    <div class="section-picker-hint">Leave department blank for a cross-cutting task (e.g. FAT) that spans the whole phase.</div>
    <div class="section-picker-actions">
      <button type="button" class="btn-ghost sp-cancel">Cancel</button>
      <button type="button" class="btn-primary sp-create">${escapeHtml(okLabel)}</button>
    </div>
  `;
  document.body.appendChild(pop);
  // Now reposition with viewport clamping. The "+ Add task" button lives at the
  // BOTTOM of the grid, so the popup commonly needs to flip up so it isn't clipped.
  const popH = pop.offsetHeight;
  const popW = pop.offsetWidth;
  const margin = 8;
  let left = Math.max(margin, Math.min(x, window.innerWidth - popW - margin));
  let top  = y;
  if (top + popH > window.innerHeight - margin) {
    // Doesn't fit below the anchor — flip up. y was anchor.bottom + 6 in callers,
    // so anchor.bottom ≈ y - 6; flipped popup top = anchor.bottom - 6 - popH.
    top = Math.max(margin, y - 12 - popH);
  }
  pop.style.left = left + 'px';
  pop.style.top  = top + 'px';

  const gSel = pop.querySelector('.sp-group');
  const dSel = pop.querySelector('.sp-dept');
  const sSel = pop.querySelector('.sp-sub');

  gSel.addEventListener('change', () => {
    const group = GROUP_BY_KEY[gSel.value];
    if (group) {
      dSel.innerHTML = '<option value="">— cross-cutting (no department) —</option>' +
        group.departments.map(d => `<option value="${d.key}">${escapeHtml(d.label)}</option>`).join('');
      dSel.disabled = false;
    } else {
      dSel.innerHTML = '<option value="">— pick phase group first —</option>';
      dSel.disabled = true;
    }
    dSel.value = '';
    sSel.innerHTML = '<option value="">— optional —</option>';
    sSel.disabled = true;
    sSel.value = '';
  });
  dSel.addEventListener('change', () => {
    const dept = window.findDepartment(gSel.value, dSel.value);
    if (dept && dept.subs.length > 0) {
      sSel.innerHTML = '<option value="">— optional —</option>' +
        dept.subs.map(s => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join('');
      sSel.disabled = false;
    } else {
      sSel.innerHTML = '<option value="">— optional —</option>';
      sSel.disabled = true;
    }
    sSel.value = '';
  });

  pop.querySelector('.sp-cancel').addEventListener('click', () => pop.remove());
  pop.querySelector('.sp-create').addEventListener('click', () => {
    const g = gSel.value || null;
    const d = dSel.value || null;
    const s = sSel.value || null;
    pop.remove();
    onPick(g, d, s);
  });

  // Click outside dismisses (next tick to avoid catching the button click that opened it).
  setTimeout(() => {
    const onDoc = (e) => {
      if (!pop.contains(e.target)) {
        pop.remove();
        document.removeEventListener('mousedown', onDoc);
      }
    };
    document.addEventListener('mousedown', onDoc);
  }, 0);

  // Auto-focus the first select.
  gSel.focus();
}

// ---------- Settings / theme ----------
const SECTION_COLOR_DEFAULTS = {
  // Sections default to a light neutral gray — only this top level shows a colored
  // block; departments and sub-departments rely on indentation alone for hierarchy.
  // Keys MUST match HIERARCHY[].key — if not, applySectionColors writes an undefined
  // value and the section row goes transparent (which is why section 50 was missing
  // its gray bar).
  design_build:     '#e2e8f0', // slate-200
  machine_testing:  '#e2e8f0',
  teardown_install: '#e2e8f0',
};

// Anchor milestones (Receipt of PO, Machine Power-Up, FAT, Ship Machine) all share
// one color. Default to SDC lime ("good things, brand-aligned"); user picks on Setup
// → Anchor Color.
const ANCHOR_COLOR_DEFAULTS = {
  fill: '#befa4f', // SDC lime — brand palette
  text: '#0f172a', // slate-900 — contrasts the light lime for label/stroke
};

// % complete pill color scheme — four states, each just a background fill.
// Text is always black for consistency; the fill is what changes between
// states (slate / red / green / emerald by default). Drives the right-edge
// pill inside the Task column on the Schedule grid.
const PCT_COLOR_DEFAULTS = {
  zero:    '#fafbfc', // near-white — 0%, not started (subtle, doesn't draw the eye)
  behind:  '#fee2e2', // soft red — 1–99% AND behind schedule
  ontrack: '#dcfce7', // soft green — 1–99% AND on/ahead
  done:    '#16a34a', // deep green — 100% complete (white ✓ inside, matches milestone done)
};
const PCT_COLOR_KEYS = ['zero', 'behind', 'ontrack', 'done'];
// Normalize the saved pct_colors value into the simple { key → hex } form. Earlier
// builds saved { key → { fill, text } } objects; this absorbs either shape.
function normalizePctColors(raw) {
  const out = {};
  for (const k of PCT_COLOR_KEYS) {
    const v = raw?.[k];
    if (typeof v === 'string') out[k] = v;
    else if (v && typeof v === 'object' && v.fill) out[k] = v.fill;
    else out[k] = PCT_COLOR_DEFAULTS[k];
  }
  return out;
}

function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  if (theme.primary) root.setProperty('--sdc-primary', theme.primary);
  if (theme.dark)    root.setProperty('--sdc-dark', theme.dark);
  if (theme.accent)  root.setProperty('--sdc-accent', theme.accent);
}

function applySectionColors(sectionColors) {
  const root = document.documentElement.style;
  const c = { ...SECTION_COLOR_DEFAULTS, ...(sectionColors || {}) };
  root.setProperty('--section-design-build',     c.design_build);
  root.setProperty('--section-machine-testing',  c.machine_testing);
  root.setProperty('--section-teardown-install', c.teardown_install);
}

function applyAnchorColor(anchorColor) {
  const c = { ...ANCHOR_COLOR_DEFAULTS, ...(anchorColor || {}) };
  const root = document.documentElement.style;
  root.setProperty('--anchor-fill', c.fill);
  root.setProperty('--anchor-text', c.text);
}

function applyPctColors(pctColors) {
  const norm = normalizePctColors(pctColors);
  const root = document.documentElement.style;
  for (const k of PCT_COLOR_KEYS) {
    root.setProperty(`--pct-${k}-fill`, norm[k]);
  }
}

// Apply the live hierarchy colors to BOTH the runtime store (so injectPhaseStyles uses
// them) and CSS custom properties (so the grid pill rules pick them up without an
// explicit re-render).
function applyHierarchyColors(hierarchyColors) {
  HIERARCHY_BAR_COLORS = { ...HIERARCHY_COLOR_DEFAULTS, ...(hierarchyColors || {}) };
  // Merge per-key fields (in case the saved object only has fill but not text, etc.).
  for (const k of HIERARCHY_KEYS) {
    HIERARCHY_BAR_COLORS[k] = { ...HIERARCHY_COLOR_DEFAULTS[k], ...(hierarchyColors?.[k] || {}) };
  }
  const root = document.documentElement.style;
  for (const k of HIERARCHY_KEYS) {
    const c = HIERARCHY_BAR_COLORS[k];
    root.setProperty(`--hier-${k}-fill`, c.fill);
    root.setProperty(`--hier-${k}-text`, c.text);
  }
  // Re-emit phase styles so Gantt bar colors update too.
  if (document.getElementById('phase-bar-styles')) injectPhaseStyles();
}

async function loadSettings() {
  const settings = await api.getSettings();
  state.settings = settings;
  // Seed defaults for any new keys the saved settings haven't acquired yet so the rest of
  // the app can read them unconditionally.
  if (!state.settings.section_colors)    state.settings.section_colors    = { ...SECTION_COLOR_DEFAULTS };
  if (!state.settings.hierarchy_colors)  state.settings.hierarchy_colors  = JSON.parse(JSON.stringify(HIERARCHY_COLOR_DEFAULTS));
  if (!state.settings.anchor_color)      state.settings.anchor_color      = { ...ANCHOR_COLOR_DEFAULTS };
  // Always normalize — older builds saved { key → { fill, text } } objects;
  // current shape is { key → "#hex" }. normalizePctColors handles both.
  state.settings.pct_colors = normalizePctColors(state.settings.pct_colors);
  if (settings.theme) applyTheme(settings.theme);
  applySectionColors(state.settings.section_colors);
  applyHierarchyColors(state.settings.hierarchy_colors);
  applyAnchorColor(state.settings.anchor_color);
  applyPctColors(state.settings.pct_colors);
  if (Array.isArray(settings.phases) && settings.phases.length) {
    window.PHASES = settings.phases;
    window.PHASE_BY_KEY = Object.fromEntries(settings.phases.map(p => [p.key, p]));
  }
}

// ---------- Team view ----------
// Five cards (one per discipline). Each card stacks: header (label + capacity
// stats), regular members (lead first, then sort_order), then a placeholder
// block pinned to the bottom of the card via flex:1 on the regular list. The
// "+ Add member" button is always the last element. Rows are drag-reorderable
// within a card so a manager can group their team by specialty / pod / etc.
// ----------------------------------------------------------------------------
// v4.61 — Action Items master page (left sidebar > Actions).
// Lists every action item (is_action = 1) across every project. Two buckets:
//   active = progress < 100 (default)
//   closed = progress >= 100
// Filters (chips + selects) narrow the list further. Quick-add bar at top
// creates a new action and immediately appears in the list.
// ----------------------------------------------------------------------------
const _actionsPageState = {
  bucket: 'active',        // 'active' | 'closed'
  filters: {
    behind: false,         // past due, not done
    dueWeek: false,        // due in next 7 days
    unassigned: false,     // assignee is a Placeholder
    project: '',
    assignee: '',
    discipline: '',
  },
  // v4.63: when set, the page flips to "personal" mode for that team member —
  // the list shows ONLY their assigned tasks + actions (across every project),
  // and a summary strip up top mirrors the Departments per-person dashboard.
  // 'everyone' (or empty) = manager / team-wide view. Persists in localStorage.
  personId: (() => {
    try {
      const v = localStorage.getItem('sdcActionsPersonId');
      return v ? Number(v) : null;
    } catch { return null; }
  })(),
  // v4.65: discipline picked in the Person dropdown (drives which people the
  // Person select shows). Seeded from the persisted personId on first render.
  deptForPicker: '',
};

// Map a task's section (dept + sub) to one of the 4 main discipline keys,
// used for the colored department pill in the actions list + the filter
// select. Falls back to '' for procurement / cross-cutting / section 40
// engineering-shop generic cases. Mech eng / Controls eng / Build / Wire.
function actionDisciplineKey(task) {
  return disciplineForSection(task.department, task.sub_department) || '';
}

function renderActionsPage() {
  const tabs = document.getElementById('actions-page-tabs');
  if (!tabs) return;

  // Tabs (Active / Closed) — wire once. Use a marker dataset attribute so
  // we only attach the handler the first time renderActionsPage runs.
  if (!tabs.dataset.wired) {
    tabs.dataset.wired = '1';
    tabs.querySelectorAll('.actions-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _actionsPageState.bucket = btn.dataset.bucket;
        renderActionsPage();
      });
    });
  }
  tabs.querySelectorAll('.actions-tab').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.bucket === _actionsPageState.bucket);
  });

  // v4.76: when a person is signed in, focus the page on their personal
  // Gantt — hide the section divider, filter chips, action list, and
  // dept dashboard. The Gantt shows the same data the list would and
  // doing both feels disconnected ("top half is mine, bottom half is
  // team"). Quick-add bar stays visible so the user can keep adding.
  const pageRoot = document.querySelector('.actions-page');
  if (pageRoot) {
    pageRoot.classList.toggle('is-signed-in', _actionsPageState.personId != null);
  }

  // v4.63: render the person picker (Everyone + every team member except
  // placeholders) and the optional personal summary strip.
  // v4.66: also render the per-person Gantt visualization when someone is
  // signed in. Clears itself when no person is picked.
  renderActionsPersonBar();
  renderActionsPersonSummary();
  renderActionsPersonGantt();

  // Refresh the project + person select dropdowns. Preserve the user's
  // current selections across rebuilds so a re-render doesn't blow away
  // their filter state.
  const projSel        = document.getElementById('actions-qa-project');
  const filterProjSel  = document.getElementById('actions-filter-project');
  const filterAsgSel   = document.getElementById('actions-filter-assignee');
  // v4.68: drop template projects + Sales-workspace projects from the
  // pickers. Templates are scaffolding (e.g. SDC_StandardProject_Template)
  // and shouldn't be a valid target for new action items; Sales projects
  // are pre-quote work where the user explicitly doesn't want staffing
  // assignments — same exclusions used by the Departments dashboard.
  const projects = uniqueValues('project')
    .filter(p => !isTemplateProject(p) && projectWorkspace(p) !== 'Sales')
    .sort();
  const people   = Array.from(new Set((state.tasks || []).filter(t => t.is_action).map(t => t.assignee).filter(Boolean))).sort();
  const prevQaProj  = projSel?.value || '';
  const prevFltProj = filterProjSel?.value || '';
  const prevFltAsg  = filterAsgSel?.value  || '';
  if (projSel)        projSel.innerHTML       = '<option value="">— pick project —</option>'  + projects.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  if (filterProjSel)  filterProjSel.innerHTML = '<option value="">All projects</option>'      + projects.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  if (filterAsgSel)   filterAsgSel.innerHTML  = '<option value="">All people</option>'        + people.map(a   => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
  if (projSel       && prevQaProj)  projSel.value       = prevQaProj;
  if (filterProjSel)                filterProjSel.value = _actionsPageState.filters.project || prevFltProj;
  if (filterAsgSel)                 filterAsgSel.value  = _actionsPageState.filters.assignee || prevFltAsg;

  // Quick-add handlers (wire once).
  const qaCreate  = document.getElementById('actions-qa-create');
  const qaTitle   = document.getElementById('actions-qa-title');
  const qaSection = document.getElementById('actions-qa-section');
  const qaDept    = document.getElementById('actions-qa-dept');
  const qaDue     = document.getElementById('actions-qa-due');
  if (qaCreate && !qaCreate.dataset.wired) {
    qaCreate.dataset.wired = '1';
    qaCreate._pickedSection = null;

    qaSection.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = qaSection.getBoundingClientRect();
      // v4.72: this picker just STASHES the section — the action gets created
      // later when the user fills in dept/due and clicks "+ Add action".
      // Override the picker's default "Create" button to "Done" so the user
      // doesn't think clicking it commits the action.
      showSectionPicker(r.left, r.bottom + 6, (g, d, s) => {
        qaCreate._pickedSection = { g, d, s };
        const dept = d ? (window.findDepartment(g, d)?.label || d) : '(no dept)';
        const sub  = s ? (window.findSubDepartment(g, d, s)?.label || s) : '';
        qaSection.textContent = `${dept}${sub ? ' · ' + sub : ''} ▾`;
        // v4.62: auto-fill the Department dropdown from the picked section.
        // User can still override if the mapping is ambiguous (e.g. section 40
        // engineering → could be Mech or Controls).
        const auto = disciplineForSection(d, s);
        if (auto && qaDept) qaDept.value = auto;
      }, { okLabel: 'Done', title: 'Pick the section' });
    });

    const createNow = async () => {
      const title = (qaTitle.value || '').trim();
      const project = projSel.value;
      const sect = qaCreate._pickedSection;
      if (!title)   { qaTitle.focus(); return; }
      if (!project) { projSel.focus(); alert('Pick a project for this action.'); return; }
      if (!sect)    { qaSection.focus(); alert('Pick a section so we know where the action lives.'); return; }
      // v4.62: discipline comes from the dropdown first (user-explicit),
      // falling back to the section auto-map. If neither resolves we just
      // leave the assignee blank so the manager can pick later.
      const discKey = (qaDept && qaDept.value) || disciplineForSection(sect.d, sect.s) || '';
      const placeholderName = placeholderNameForDiscipline(discKey);
      // v4.76: if the user didn't pick a due date, default it to TODAY.
      // Why: without a date the action never shows on the personal Gantt
      // (which requires start/end dates to position the diamond on the
      // timeline). User explicitly asked for actions to appear as
      // milestones on the Gantt — so every action gets a date now.
      const due = qaDue.value || new Date().toISOString().slice(0, 10);
      try {
        await api.create({
          name: title,
          project,
          phase_group: sect.g,
          department: sect.d,
          sub_department: sect.s,
          is_action: 1,
          duration_days: 0,
          is_milestone: 1,
          progress: 0,
          start_date: due,
          end_date: due,
          ...(placeholderName ? { assignee: placeholderName } : {}),
        });
      } catch (err) {
        alert('Failed to create action: ' + (err?.message || err));
        return;
      }
      // Reset the form.
      qaTitle.value = '';
      qaDue.value   = '';
      qaCreate._pickedSection = null;
      qaSection.textContent = 'Section ▾';
      if (qaDept) qaDept.value = '';
      // Force-switch back to Active so the user sees their new action even
      // if they were on Closed when they clicked Create.
      _actionsPageState.bucket = 'active';
      await loadTasks();
      renderActionsPage();
    };
    qaCreate.addEventListener('click', createNow);
    qaTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') createNow(); });
  }

  // Filter chips + selects (wire once).
  const filtersRow = document.getElementById('actions-filters');
  if (filtersRow && !filtersRow.dataset.wired) {
    filtersRow.dataset.wired = '1';
    filtersRow.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const k = chip.dataset.filter;
        const map = { behind: 'behind', 'overdue-week': 'dueWeek', unassigned: 'unassigned' };
        const key = map[k];
        if (!key) return;
        _actionsPageState.filters[key] = !_actionsPageState.filters[key];
        renderActionsPage();
      });
    });
    document.getElementById('actions-filter-project').addEventListener('change', (e) => {
      _actionsPageState.filters.project = e.target.value;
      renderActionsPage();
    });
    document.getElementById('actions-filter-assignee').addEventListener('change', (e) => {
      _actionsPageState.filters.assignee = e.target.value;
      renderActionsPage();
    });
    document.getElementById('actions-filter-discipline').addEventListener('change', (e) => {
      _actionsPageState.filters.discipline = e.target.value;
      renderActionsPage();
    });
  }
  // Reflect filter state on chips + selects.
  filtersRow?.querySelectorAll('.filter-chip').forEach(chip => {
    const map = { behind: 'behind', 'overdue-week': 'dueWeek', unassigned: 'unassigned' };
    const key = map[chip.dataset.filter];
    chip.classList.toggle('is-active', !!_actionsPageState.filters[key]);
  });
  if (filterProjSel)                                  filterProjSel.value = _actionsPageState.filters.project;
  if (filterAsgSel)                                   filterAsgSel.value  = _actionsPageState.filters.assignee;
  const filterDiscSel = document.getElementById('actions-filter-discipline');
  if (filterDiscSel) filterDiscSel.value = _actionsPageState.filters.discipline;

  // Compute the visible list.
  const todayMs = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const ONE_WEEK = 7 * 86400000;
  const allActions = (state.tasks || []).filter(t => !!t.is_action);
  let actions = allActions.slice();
  if (_actionsPageState.bucket === 'active') {
    actions = actions.filter(t => (Number(t.progress) || 0) < 100);
  } else {
    actions = actions.filter(t => (Number(t.progress) || 0) >= 100);
  }
  const f = _actionsPageState.filters;
  if (f.behind) {
    actions = actions.filter(t => t.end_date && new Date(t.end_date).getTime() < todayMs && (Number(t.progress) || 0) < 100);
  }
  if (f.dueWeek) {
    actions = actions.filter(t => {
      if (!t.end_date) return false;
      const due = new Date(t.end_date).getTime();
      return due >= todayMs && due <= todayMs + ONE_WEEK;
    });
  }
  if (f.unassigned) actions = actions.filter(t => !t.assignee || isPlaceholder(t.assignee));
  if (f.project)    actions = actions.filter(t => t.project === f.project);
  if (f.assignee)   actions = actions.filter(t => t.assignee === f.assignee);
  if (f.discipline) actions = actions.filter(t => actionDisciplineKey(t) === f.discipline);
  // v4.63: person picker filters everything to one team member when set.
  const pickedPerson = _actionsPageState.personId
    ? (state.team || []).find(m => m.id === _actionsPageState.personId)
    : null;
  if (pickedPerson) actions = actions.filter(t => (t.assignee || '').trim().toLowerCase() === pickedPerson.name.trim().toLowerCase());
  // Sort: overdue first, then by due date asc, then by id.
  actions.sort((a, b) => {
    const aOver = a.end_date && new Date(a.end_date).getTime() < todayMs && (Number(a.progress) || 0) < 100;
    const bOver = b.end_date && new Date(b.end_date).getTime() < todayMs && (Number(b.progress) || 0) < 100;
    if (aOver !== bOver) return aOver ? -1 : 1;
    const aDue = a.end_date ? new Date(a.end_date).getTime() : Infinity;
    const bDue = b.end_date ? new Date(b.end_date).getTime() : Infinity;
    if (aDue !== bDue) return aDue - bDue;
    return (a.id || 0) - (b.id || 0);
  });

  // Render rows.
  const list = document.getElementById('actions-list');
  if (!list) return;
  // v4.62 BUGFIX: build the empty-state INLINE — previously the empty <p>
  // lived in static HTML and got removed by innerHTML rewrites, then null
  // references caused renders to throw silently and leave the list stuck.
  if (actions.length === 0) {
    list.innerHTML = `<p class="empty-state actions-empty-state">${
      _actionsPageState.bucket === 'closed'
        ? 'No completed action items yet.'
        : 'No action items match the current filters. Add one above.'
    }</p>`;
  } else {
    const disciplineLabel = { mech: 'Mech', controls: 'Controls', build: 'Build', wire: 'Wire' };
    const disciplineColor = {
      mech:     { bg: '#bfdbfe', fg: '#1e3a8a' },
      controls: { bg: '#bbf7d0', fg: '#14532d' },
      build:    { bg: '#fed7aa', fg: '#7c2d12' },
      wire:     { bg: '#fef08a', fg: '#713f12' },
    };
    // v4.68: list now has a header row, inline-editable Assigned-To, and an
    // explicit "Open" arrow per row. Clicking the row body no longer jumps
    // anywhere — the user wanted to be able to interact with the row without
    // accidentally navigating to the project schedule.
    // v4.74: per-row team filter. The Assigned To dropdown now shows ONLY
    // the team members in THIS action's department (mech actions → mech
    // engineers, etc.). Placeholders are dropped from the option list
    // because "— unassigned —" already represents that state — and the
    // dropdown selects "— unassigned —" when the saved assignee IS a
    // placeholder, so placeholders read as unassigned in the UI.
    const teamByDiscipline = (() => {
      const map = {};
      (state.team || []).forEach(m => {
        if (!m.name || isPlaceholder(m.name) || m.active === 0) return;
        const k = m.discipline || 'other';
        if (!map[k]) map[k] = [];
        map[k].push(m.name);
      });
      Object.keys(map).forEach(k => map[k].sort());
      return map;
    })();
    const teamForTask = (t) => {
      const k = actionDisciplineKey(t);
      const base = (k && teamByDiscipline[k])
        ? [...teamByDiscipline[k]]
        : (state.team || []).filter(m => m.name && !isPlaceholder(m.name) && m.active !== 0).map(m => m.name).sort();
      if (t.assignee && !isPlaceholder(t.assignee) && !base.includes(t.assignee)) {
        base.unshift(t.assignee);
      }
      return base;
    };
    // v4.70: header row — every column has a uniform-styled <span> header.
    // The previous build re-used the data-row classes (each with their own
    // font-size / weight / color / padding overrides), so headers came out
    // visually inconsistent. CSS now resets every header cell to the same
    // typography via .actions-row-header > * (see styles.css).
    const headerHtml = `
      <div class="actions-row actions-row-header">
        <span class="actions-hdr-done">Done</span>
        <span class="actions-hdr-name">Task</span>
        <span class="actions-hdr-project">Project</span>
        <span class="actions-hdr-assignee">Assigned To</span>
        <span class="actions-hdr-dept">Dept</span>
        <span class="actions-hdr-due">Due</span>
        <span class="actions-hdr-open">Open</span>
        <span class="actions-hdr-delete"></span>
      </div>`;
    // v4.74: group rows by department so each discipline reads as a self-
    // contained block. Order: Mech → Controls → Build → Wire → Other.
    // Each group has a dotted-line header in the discipline's color.
    const GROUP_ORDER = ['mech', 'controls', 'build', 'wire', 'other'];
    const GROUP_LABELS = { mech: 'Mech Eng', controls: 'Controls Eng', build: 'Build', wire: 'Wire', other: 'Cross-cutting' };
    const grouped = {};
    actions.forEach(t => {
      const dkey = actionDisciplineKey(t) || 'other';
      if (!grouped[dkey]) grouped[dkey] = [];
      grouped[dkey].push(t);
    });
    const renderRow = (t) => {
      const overdue = t.end_date && new Date(t.end_date).getTime() < todayMs && (Number(t.progress) || 0) < 100;
      const done = (Number(t.progress) || 0) >= 100;
      const dkey = actionDisciplineKey(t);
      const dColor = disciplineColor[dkey] || { bg: '#f1f5f9', fg: '#475569' };
      const dueLabel = done && t.completed_on
        ? `${fmtDate(t.completed_on)} ✓`
        : (t.end_date ? fmtDate(t.end_date) : '—');
      // v4.74: placeholder assignees show as "— unassigned —" in the dropdown.
      // The dropdown options are filtered to this action's department.
      const assigneeUnassigned = !t.assignee || isPlaceholder(t.assignee);
      const rowTeam = teamForTask(t);
      const assignedSelect = `
        <select class="actions-row-assignee-select" data-id="${t.id}" title="Assign — only ${escapeHtml(disciplineLabel[dkey] || 'team')} shown">
          <option value="" ${assigneeUnassigned ? 'selected' : ''}>— unassigned —</option>
          ${rowTeam.map(n => `<option value="${escapeHtml(n)}" ${n === t.assignee && !assigneeUnassigned ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
        </select>`;
      return `
        <div class="actions-row${overdue ? ' is-overdue' : ''}${done ? ' is-done' : ''}" data-id="${t.id}" data-project="${escapeHtml(t.project || '')}">
          <input type="checkbox" class="actions-row-check" data-id="${t.id}" ${done ? 'checked' : ''} title="Mark done / not done">
          <span class="actions-row-name" title="${escapeHtml(t.name || '')}">${escapeHtml(t.name || '')}</span>
          <span class="actions-row-project" title="Project: ${escapeHtml(t.project || '')}">${escapeHtml(t.project || '')}</span>
          <span class="actions-row-assignee" title="Assigned to: ${escapeHtml(t.assignee || '—')}">${assignedSelect}</span>
          <span class="actions-row-dept" style="background:${dColor.bg};color:${dColor.fg}" title="${escapeHtml(disciplineLabel[dkey] || 'Cross-cutting')}">${dkey ? disciplineLabel[dkey] : '—'}</span>
          <span class="actions-row-due${done ? ' is-completed' : ''}" title="${done ? 'Completed date' : 'Due date'}">${dueLabel}</span>
          <button type="button" class="actions-row-open" data-id="${t.id}" title="Open this action in the project schedule">→</button>
          <button type="button" class="actions-row-delete" data-id="${t.id}" title="Delete this action">×</button>
        </div>`;
    };
    // Build the grouped list. Skip groups with no items.
    let groupedHtml = '';
    for (const gkey of GROUP_ORDER) {
      const items = grouped[gkey];
      if (!items || items.length === 0) continue;
      const gColor = disciplineColor[gkey] || { bg: '#f1f5f9', fg: '#475569' };
      groupedHtml += `
        <div class="actions-group-divider" style="border-color:${gColor.fg};color:${gColor.fg}">
          <span class="actions-group-dot" style="background:${gColor.fg}"></span>
          <span class="actions-group-label">${escapeHtml(GROUP_LABELS[gkey])}</span>
          <span class="actions-group-count">${items.length}</span>
        </div>`;
      groupedHtml += items.map(renderRow).join('');
    }
    list.innerHTML = headerHtml + groupedHtml;

    // v4.68: Open button — explicit navigation. Row body is now non-clickable
    // (no accidental jumps when the user tries to interact with the row).
    list.querySelectorAll('.actions-row-open').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.id);
        const t = state.tasks.find(x => x.id === id);
        if (!t || !t.project) return;
        if (!state.openProjects.includes(t.project)) state.openProjects.push(t.project);
        state.filters.project = t.project;
        saveProjectTabs();
        setView('schedule');
      });
    });
    list.querySelectorAll('.actions-row-check').forEach(cb => {
      cb.addEventListener('change', async (e) => {
        e.stopPropagation();
        const id = Number(cb.dataset.id);
        await api.update(id, { progress: cb.checked ? 100 : 0 });
        await loadTasks();
        renderActionsPage();
      });
    });
    list.querySelectorAll('.actions-row-assignee-select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        e.stopPropagation();
        const id = Number(sel.dataset.id);
        let newAssignee = sel.value || null;
        // v4.74: picking "— unassigned —" sets the assignee back to the
        // action's discipline Placeholder (ME Placeholder / CE Placeholder /
        // etc.) — keeps the "every action has someone owning it" invariant.
        // The dropdown will still display "— unassigned —" because the
        // selected assignee is a placeholder (handled in the render path).
        if (!newAssignee) {
          const task = state.tasks.find(x => x.id === id);
          const dkey = task ? actionDisciplineKey(task) : '';
          newAssignee = placeholderNameForDiscipline(dkey) || null;
        }
        await api.update(id, { assignee: newAssignee === null ? '' : newAssignee });
        await loadTasks();
        renderActionsPage();
      });
      // Stop propagation on the select clicks so they don't bubble up to
      // anything outside the row.
      sel.addEventListener('click', (e) => e.stopPropagation());
    });
    list.querySelectorAll('.actions-row-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.id);
        const t = state.tasks.find(x => x.id === id);
        if (!t) return;
        if (!confirm(`Delete action "${t.name || '(untitled)'}"?`)) return;
        await api.remove(id);
        await loadTasks();
        renderActionsPage();
      });
    });
  }

  // v4.62: per-department dashboard. Small cards below the list summarising
  // open / overdue / done counts for actions owned by each discipline.
  // Always renders against the FULL action set (not the filtered list) so
  // the cards keep showing the big-picture health even when the list above
  // is narrowed by a chip.
  renderActionsDeptDashboard(allActions, todayMs);
}

// v4.65: two cascading dropdowns — Department → Person — instead of v4.63's
// giant strip of every-team-member-as-a-chip. Department dropdown drives
// what people show in the Person dropdown so the user doesn't have to scan
// a wall of names. Picking a person sets personId; the existing Back-to-
// Everyone button on the personal summary banner exits.
function renderActionsPersonBar() {
  const bar = document.getElementById('actions-person-bar');
  if (!bar) return;
  const allTeam = (state.team || []).filter(m => !isPlaceholder(m.name) && m.active !== 0);

  // Derive department from the currently-picked person, if any, so the
  // dropdowns reflect the last selection across re-renders.
  const pickedId = _actionsPageState.personId;
  const pickedMember = pickedId != null ? allTeam.find(m => m.id === pickedId) : null;
  // _actionsPageState.deptForPicker is set by the department dropdown's
  // change handler. We seed it from the picked person on first render.
  if (!_actionsPageState.deptForPicker && pickedMember) {
    _actionsPageState.deptForPicker = pickedMember.discipline || '';
  }
  const dept = _actionsPageState.deptForPicker || '';

  const inDept = dept ? allTeam.filter(m => m.discipline === dept) : [];
  inDept.sort((a, b) => {
    if (!!b.is_lead - !!a.is_lead !== 0) return (!!b.is_lead) - (!!a.is_lead);
    return (a.sort_order || 0) - (b.sort_order || 0);
  });

  bar.innerHTML = `
    <div class="actions-person-bar-label">Sign in</div>
    <select class="actions-person-select" id="actions-person-dept" title="Pick your department first.">
      <option value="">Department…</option>
      <option value="mech"     ${dept === 'mech'     ? 'selected' : ''}>Mech Eng</option>
      <option value="controls" ${dept === 'controls' ? 'selected' : ''}>Controls Eng</option>
      <option value="build"    ${dept === 'build'    ? 'selected' : ''}>Build</option>
      <option value="wire"     ${dept === 'wire'     ? 'selected' : ''}>Wire</option>
      <option value="pm"       ${dept === 'pm'       ? 'selected' : ''}>Project Mgmt</option>
    </select>
    <select class="actions-person-select" id="actions-person-pick" title="Pick yourself." ${dept ? '' : 'disabled'}>
      <option value="">${dept ? 'Pick yourself…' : 'Pick department first'}</option>
      ${inDept.map(m => `<option value="${m.id}" ${pickedId === m.id ? 'selected' : ''}>${escapeHtml(m.name)}${m.is_lead ? ' ★' : ''}</option>`).join('')}
    </select>
    ${pickedId != null ? '<button type="button" class="actions-person-clear" id="actions-person-clear" title="Clear selection — back to Everyone view.">× Clear</button>' : ''}
  `;

  document.getElementById('actions-person-dept').addEventListener('change', (e) => {
    _actionsPageState.deptForPicker = e.target.value || '';
    // Changing department clears any previously-picked person (since they
    // probably aren't in the new department).
    _actionsPageState.personId = null;
    try { localStorage.removeItem('sdcActionsPersonId'); } catch {}
    renderActionsPage();
  });
  document.getElementById('actions-person-pick').addEventListener('change', (e) => {
    const id = e.target.value ? Number(e.target.value) : null;
    _actionsPageState.personId = id;
    try {
      if (id == null) localStorage.removeItem('sdcActionsPersonId');
      else localStorage.setItem('sdcActionsPersonId', String(id));
    } catch {}
    renderActionsPage();
  });
  const clearBtn = document.getElementById('actions-person-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      _actionsPageState.personId = null;
      _actionsPageState.deptForPicker = '';
      try { localStorage.removeItem('sdcActionsPersonId'); } catch {}
      renderActionsPage();
    });
  }
}

// v4.63: stats strip + name banner for the picked person. Hidden when no one
// is selected (manager / Everyone view). Numbers cover EVERYTHING assigned to
// the person — actions and scheduled tasks both — so the user gets a "what's
// on my plate" snapshot, not just the actions list.
function renderActionsPersonSummary() {
  const wrap = document.getElementById('actions-person-summary');
  if (!wrap) return;
  const personId = _actionsPageState.personId;
  if (personId == null) { wrap.innerHTML = ''; return; }
  const member = (state.team || []).find(m => m.id === personId);
  if (!member) { wrap.innerHTML = ''; return; }
  const todayMs = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const mine = (state.tasks || []).filter(t => (t.assignee || '').trim().toLowerCase() === member.name.trim().toLowerCase());
  const open = (t) => (Number(t.progress) || 0) < 100;
  const isOverdue = (t) => t.end_date && new Date(t.end_date).getTime() < todayMs && open(t);
  const tasks   = mine.filter(t => !t.is_action);
  const actions = mine.filter(t =>  t.is_action);
  const openCount    = mine.filter(open).length;
  const overdueCount = mine.filter(isOverdue).length;
  const doneActions  = actions.filter(t => !open(t) && t.end_date);
  let avgOverrun = null;
  if (doneActions.length > 0) {
    const totalDays = doneActions.reduce((sum, t) => {
      const due = new Date(t.end_date).getTime();
      const closedMs = t.completed_on ? new Date(t.completed_on).getTime() : todayMs;
      // Positive = closed AFTER due (overrun). Negative = closed early.
      return sum + (closedMs - due) / 86400000;
    }, 0);
    avgOverrun = Math.round(totalDays / doneActions.length);
  }
  const disc = DISCIPLINE_BY_KEY[member.discipline];
  wrap.innerHTML = `
    <div class="aps-banner" style="background:${disc?.color || '#e2e8f0'};color:${disc?.text || '#0f172a'}">
      <div class="aps-banner-left">
        <strong>${escapeHtml(member.name)}</strong>
        <span class="aps-banner-disc">${escapeHtml(disc?.label || member.discipline || '')}</span>
        ${member.specialty ? `<span class="aps-banner-spec">${escapeHtml(member.specialty)}</span>` : ''}
      </div>
      <button type="button" class="aps-banner-exit" data-action="exit-personal">Back to Everyone</button>
    </div>
    <div class="aps-stats">
      <div class="aps-stat">
        <div class="aps-stat-num">${openCount}</div>
        <div class="aps-stat-lbl">Open total</div>
      </div>
      <div class="aps-stat ${overdueCount > 0 ? 'is-warn' : ''}">
        <div class="aps-stat-num">${overdueCount}</div>
        <div class="aps-stat-lbl">Overdue</div>
      </div>
      <div class="aps-stat">
        <div class="aps-stat-num">${tasks.length}</div>
        <div class="aps-stat-lbl">Scheduled tasks</div>
      </div>
      <div class="aps-stat">
        <div class="aps-stat-num">${actions.length}</div>
        <div class="aps-stat-lbl">Action items</div>
      </div>
      <div class="aps-stat">
        <div class="aps-stat-num">${avgOverrun != null ? (avgOverrun > 0 ? '+' : '') + avgOverrun + 'd' : '—'}</div>
        <div class="aps-stat-lbl">Avg overrun</div>
      </div>
    </div>
  `;
  wrap.querySelector('[data-action="exit-personal"]').addEventListener('click', () => {
    _actionsPageState.personId = null;
    try { localStorage.removeItem('sdcActionsPersonId'); } catch {}
    renderActionsPage();
  });
}

// v4.66: per-person Gantt visualisation on the Actions page. Renders every
// task + action item (with start/end dates) assigned to the signed-in
// person as a horizontal-bar timeline. Bars are colored by project. Action
// items render as small diamond markers since they typically have zero
// duration. Hover shows project + task name + dates.
function renderActionsPersonGantt() {
  const wrap = document.getElementById('actions-person-gantt');
  if (!wrap) return;
  const personId = _actionsPageState.personId;
  if (personId == null) { wrap.innerHTML = ''; return; }
  const member = (state.team || []).find(m => m.id === personId);
  if (!member) { wrap.innerHTML = ''; return; }

  // v4.80: gather this person's tasks + actions.
  // - Scheduled tasks need dates to position on the timeline (skip if null).
  // - Action items ALWAYS show on the timeline — even if their start/end
  //   dates are null (old data, pre-v4.76 quick-add without a due date).
  //   For those, we default to TODAY at render time so the diamond appears
  //   under the today line. User can edit the date later via the schedule.
  // - Also surface placeholder-assigned action items to every engineer in
  //   that discipline — so unstaffed actions show up on the relevant team's
  //   timeline before someone manually claims them.
  const memberNameLower = member.name.trim().toLowerCase();
  const _todayISO_ = new Date().toISOString().slice(0, 10);
  const mine = (state.tasks || [])
    .filter(t => {
      if (!t.project) return false;
      if (isTemplateProject(t.project)) return false;
      if (projectWorkspace(t.project) === 'Sales') return false;
      const assignee = (t.assignee || '').trim().toLowerCase();
      const directAssign = assignee === memberNameLower;
      const placeholderForMyDiscipline =
        t.is_action
        && isPlaceholder(t.assignee)
        && actionDisciplineKey(t) === member.discipline;
      if (!directAssign && !placeholderForMyDiscipline) return false;
      // Scheduled tasks must have dates; action items default to today below.
      if (!t.is_action) return !!(t.start_date && t.end_date);
      return true;
    })
    // Project dateless action items onto today WITHOUT mutating state.tasks.
    .map(t => {
      if (!t.is_action || (t.start_date && t.end_date)) return t;
      const start = t.start_date || _todayISO_;
      const end   = t.end_date   || start;
      return { ...t, start_date: start, end_date: end };
    });

  if (mine.length === 0) {
    wrap.innerHTML = `<div class="apg-empty">Nothing scheduled. ${escapeHtml(member.name)} has no tasks or action items with dates.</div>`;
    return;
  }

  // Sort by start date so the chart reads top-down chronologically.
  mine.sort((a, b) => {
    const sa = (a.start_date || '').localeCompare(b.start_date || '');
    if (sa !== 0) return sa;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Compute the date range (with padding) so every bar fits with breathing room.
  const startsMs = mine.map(t => new Date(t.start_date + 'T00:00:00').getTime());
  const endsMs   = mine.map(t => new Date(t.end_date   + 'T00:00:00').getTime());
  const minTaskMs = Math.min(...startsMs);
  const maxTaskMs = Math.max(...endsMs);
  const todayMs   = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const PAD_DAYS  = 7;
  const minMs = Math.min(minTaskMs, todayMs) - PAD_DAYS * 86400000;
  const maxMs = Math.max(maxTaskMs, todayMs) + PAD_DAYS * 86400000;
  const totalDays = Math.max(1, (maxMs - minMs) / 86400000);

  // v4.67: colors come from the SAME hierarchy palette the main Schedule
  // Gantt uses (rowColorKey → HIERARCHY_BAR_COLORS). Mech tasks read blue,
  // Controls green, Build orange, Wire yellow — consistent with the rest
  // of the app. Falls back to procurement grey for anything unclassified.
  const colorsForTask = (t) => {
    const key = rowColorKey(t);
    const palette = HIERARCHY_BAR_COLORS[key] || HIERARCHY_BAR_COLORS.procurement || { fill: '#cbd5e1', text: '#334155' };
    return palette;
  };

  // Build week ticks across the axis.
  const ticks = [];
  let cursor = new Date(minMs);
  // Snap cursor to the next Monday so the labels line up.
  while (cursor.getDay() !== 1) cursor.setDate(cursor.getDate() + 1);
  while (cursor.getTime() <= maxMs) {
    const offsetDays = (cursor.getTime() - minMs) / 86400000;
    const leftPct = (offsetDays / totalDays) * 100;
    ticks.push({ leftPct, label: fmtDate(cursor.toISOString().slice(0, 10)) });
    cursor.setDate(cursor.getDate() + 7);
  }
  // Subsample to roughly every 2 weeks if there are too many ticks.
  const visibleTicks = ticks.length > 16 ? ticks.filter((_, i) => i % 2 === 0) : ticks;

  // Today line position
  const todayPct = ((todayMs - minMs) / 86400000 / totalDays) * 100;

  // Build the rows.
  const rowsHtml = mine.map(t => {
    const startMs  = new Date(t.start_date + 'T00:00:00').getTime();
    const endMs    = new Date(t.end_date   + 'T00:00:00').getTime();
    const startPct = ((startMs - minMs) / 86400000 / totalDays) * 100;
    const widthPct = Math.max(0.4, ((endMs - startMs) / 86400000 / totalDays) * 100);
    const palette  = colorsForTask(t);
    const progress = Math.max(0, Math.min(100, Number(t.progress) || 0));
    const overdue  = endMs < todayMs && progress < 100;
    const done     = progress >= 100;
    const isAction = !!t.is_action;
    const alloc    = t.is_milestone ? null : (t.allocation == null ? 90 : Math.max(0, Math.min(100, Number(t.allocation))));
    const durDays  = Number(t.duration_days) || 0;
    const wks      = Math.round(durDays / 5);
    // Combined meta label like the main Gantt: "85% · 2w · 50%" (alloc · dur · progress).
    // Progress is only included once a task is started so unstarted bars stay clean.
    const metaParts = [];
    if (alloc != null && alloc > 0)            metaParts.push(`${alloc}%`);
    if (wks > 0)                               metaParts.push(`${wks}w`);
    if (progress > 0 && progress < 100)        metaParts.push(`${progress}% done`);
    const metaLabel = metaParts.join(' · ');
    const tip = `${t.project ? `[${t.project}] ` : ''}${t.name}\n${fmtDate(t.start_date)} → ${fmtDate(t.end_date)}${alloc != null ? ` · ${alloc}%` : ''}${wks > 0 ? ` · ${wks}w` : ''}${progress > 0 ? ` · ${progress}% done` : ''}`;
    const isMilestone = (t.is_milestone || durDays === 0) && (endMs - startMs) <= 86400000;
    // v4.76: bar content layout MATCHES v4.75 main Gantt — combined inline
    // "meta · name" at the bar's LEFT edge. Meta in 700 weight, name in 600.
    // Reads as "[meta pill] · description" without the pill border.
    const barName = escapeHtml(t.name || '');
    const metaInline = metaLabel ? `<span class="apg-bar-meta">${escapeHtml(metaLabel)}</span><span class="apg-bar-sep"> · </span>` : '';
    const barOrDot = isMilestone
      ? `<div class="apg-diamond ${overdue ? 'is-overdue' : ''} ${done ? 'is-done' : ''} ${isAction ? 'is-action' : ''}" style="left:${startPct}%;background:${isAction ? 'var(--sdc-primary, #2563eb)' : palette.fill};border-color:${palette.text}" title="${escapeHtml(tip)}"></div>`
      : `<div class="apg-bar ${overdue ? 'is-overdue' : ''} ${done ? 'is-done' : ''}" style="left:${startPct}%;width:${widthPct}%;background:${palette.fill};border-color:${palette.text};color:${palette.text}" title="${escapeHtml(tip)}">
          ${progress > 0 ? `<div class="apg-bar-fill" style="width:${progress}%;background:${palette.text}"></div>` : ''}
          <span class="apg-bar-content">${metaInline}<span class="apg-bar-name">${barName}</span></span>
        </div>`;
    return `
      <div class="apg-row" data-id="${t.id}" data-project="${escapeHtml(t.project || '')}">
        <div class="apg-row-label" title="${escapeHtml(t.name)}">
          <span class="apg-row-name">${escapeHtml(t.name)}</span>
          <span class="apg-row-project">${escapeHtml(t.project || '')}</span>
        </div>
        <div class="apg-row-track">${barOrDot}</div>
        <button type="button" class="apg-row-open" data-id="${t.id}" title="Open this task in the project schedule">→</button>
      </div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="apg-title">${escapeHtml(member.name)}'s timeline</div>
    <div class="apg-chart">
      <div class="apg-header">
        <div class="apg-row-label apg-header-spacer"></div>
        <div class="apg-axis">
          ${visibleTicks.map(t => `<div class="apg-tick" style="left:${t.leftPct}%"><span>${escapeHtml(t.label)}</span></div>`).join('')}
        </div>
      </div>
      <div class="apg-body">
        ${todayPct >= 0 && todayPct <= 100 ? `<div class="apg-today" style="left:calc(var(--apg-label-w) + (100% - var(--apg-label-w)) * ${todayPct / 100})" title="Today"></div>` : ''}
        ${rowsHtml}
      </div>
    </div>
  `;

  // v4.68: clicking the row body no longer jumps to the schedule — that
  // intercepted drag attempts and felt like a trap. Each row has an explicit
  // → Open button instead.
  wrap.querySelectorAll('.apg-row-open').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      const t = state.tasks.find(x => x.id === id);
      if (!t || !t.project) return;
      if (!state.openProjects.includes(t.project)) state.openProjects.push(t.project);
      state.filters.project = t.project;
      saveProjectTabs();
      setView('schedule');
    });
  });
}

function renderActionsDeptDashboard(allActions, todayMs) {
  const wrap = document.getElementById('actions-dept-dashboard');
  if (!wrap) return;
  const discs = [
    { key: 'mech',     label: 'Mech Eng',     color: '#bfdbfe', text: '#1e3a8a' },
    { key: 'controls', label: 'Controls Eng', color: '#bbf7d0', text: '#14532d' },
    { key: 'build',    label: 'Build',        color: '#fed7aa', text: '#7c2d12' },
    { key: 'wire',     label: 'Wire',         color: '#fef08a', text: '#713f12' },
  ];
  wrap.innerHTML = `
    <div class="actions-dept-title">Action items by department</div>
    <div class="actions-dept-cards">
      ${discs.map(d => {
        const mine = allActions.filter(t => actionDisciplineKey(t) === d.key);
        const open = mine.filter(t => (Number(t.progress) || 0) < 100);
        const overdue = open.filter(t => t.end_date && new Date(t.end_date).getTime() < todayMs);
        const done = mine.filter(t => (Number(t.progress) || 0) >= 100);
        return `
          <button type="button" class="actions-dept-card" data-disc="${d.key}" style="border-top:3px solid ${d.color}">
            <div class="adc-head" style="color:${d.text}">${escapeHtml(d.label)}</div>
            <div class="adc-stats">
              <div class="adc-stat"><div class="adc-num">${open.length}</div><div class="adc-lbl">Open</div></div>
              <div class="adc-stat ${overdue.length > 0 ? 'is-warn' : ''}"><div class="adc-num">${overdue.length}</div><div class="adc-lbl">Overdue</div></div>
              <div class="adc-stat"><div class="adc-num">${done.length}</div><div class="adc-lbl">Done</div></div>
            </div>
          </button>`;
      }).join('')}
    </div>`;
  // Clicking a dept card filters the list to that discipline.
  wrap.querySelectorAll('.actions-dept-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const disc = btn.dataset.disc;
      _actionsPageState.filters.discipline = (_actionsPageState.filters.discipline === disc) ? '' : disc;
      renderActionsPage();
    });
  });
}

// ----------------------------------------------------------------------------
// v4.61 — Per-person dashboard. Click a team member row on the Departments
// tab → a side panel slides in from the right with everything assigned to
// that person (scheduled work + action items + upcoming milestones).
// ----------------------------------------------------------------------------
const _personDashState = {
  memberId: null,
  filter: 'all',  // 'all' | 'tasks' | 'actions'
};

function openPersonDashboard(memberId) {
  _personDashState.memberId = memberId;
  _personDashState.filter = 'all';
  renderPersonDashboard();
}

function closePersonDashboard() {
  _personDashState.memberId = null;
  const panel = document.getElementById('person-dashboard');
  if (panel) panel.classList.remove('is-open');
}

function renderPersonDashboard() {
  const memberId = _personDashState.memberId;
  if (memberId == null) return;
  const member = (state.team || []).find(m => m.id === memberId);
  if (!member) { closePersonDashboard(); return; }

  // Ensure the panel exists in the DOM (we create it lazily on first open).
  let panel = document.getElementById('person-dashboard');
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = 'person-dashboard';
    panel.className = 'person-dashboard';
    document.body.appendChild(panel);
    // Close on outside click. We attach the listener once and gate on the
    // panel being open so it doesn't run for every body click.
    document.addEventListener('click', (e) => {
      if (!panel.classList.contains('is-open')) return;
      if (panel.contains(e.target)) return;
      // Ignore clicks on team member rows (those open / re-open the panel).
      if (e.target.closest('.team-member')) return;
      closePersonDashboard();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.classList.contains('is-open')) closePersonDashboard();
    });
  }

  // Compute the assigned set.
  const todayMs = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const isAssignedTo = (t, name) => {
    if (!name) return false;
    return (t.assignee || '').trim().toLowerCase() === name.trim().toLowerCase();
  };
  const allAssigned = (state.tasks || []).filter(t => isAssignedTo(t, member.name));
  const tasks   = allAssigned.filter(t => !t.is_action);
  const actions = allAssigned.filter(t =>  t.is_action);
  const open = (t) => (Number(t.progress) || 0) < 100;
  const isOverdue = (t) => t.end_date && new Date(t.end_date).getTime() < todayMs && open(t);

  // Stats strip.
  const openCount    = allAssigned.filter(open).length;
  const overdueCount = allAssigned.filter(isOverdue).length;
  const doneActions  = actions.filter(t => !open(t) && t.end_date);
  // Naive avg-close: difference between today and end_date for done actions.
  // (No "completed_at" column — using end_date as a stand-in. Skips if no due date.)
  let avgCloseDays = null;
  if (doneActions.length > 0) {
    const totalDays = doneActions.reduce((sum, t) => {
      const due = new Date(t.end_date).getTime();
      // Roughly: positive => closed BEFORE due, negative => closed AFTER.
      return sum + Math.max(0, (todayMs - due) / 86400000);
    }, 0);
    avgCloseDays = Math.round(totalDays / doneActions.length);
  }

  // Apply filter.
  const filter = _personDashState.filter;
  let visible = allAssigned;
  if (filter === 'tasks')   visible = tasks;
  if (filter === 'actions') visible = actions;

  // Sort: overdue first, then by due date, then by name.
  visible = visible.slice().sort((a, b) => {
    const ao = isOverdue(a) ? 0 : 1;
    const bo = isOverdue(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ad = a.end_date ? new Date(a.end_date).getTime() : Infinity;
    const bd = b.end_date ? new Date(b.end_date).getTime() : Infinity;
    if (ad !== bd) return ad - bd;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Render markup.
  const disc = DISCIPLINE_BY_KEY[member.discipline];
  panel.innerHTML = `
    <header class="person-dashboard-head" style="background:${disc?.color || '#e2e8f0'};color:${disc?.text || '#0f172a'}">
      <div class="person-dashboard-title">
        <strong>${escapeHtml(member.name)}</strong>
        <span class="person-dashboard-disc">${escapeHtml(disc?.label || member.discipline || '')}</span>
        ${member.specialty ? `<span class="person-dashboard-spec">${escapeHtml(member.specialty)}</span>` : ''}
      </div>
      <button type="button" class="person-dashboard-close" title="Close (Esc)">×</button>
    </header>
    <div class="person-dashboard-stats">
      <div class="pd-stat">
        <div class="pd-stat-num">${openCount}</div>
        <div class="pd-stat-lbl">Open</div>
      </div>
      <div class="pd-stat ${overdueCount > 0 ? 'is-warn' : ''}">
        <div class="pd-stat-num">${overdueCount}</div>
        <div class="pd-stat-lbl">Overdue</div>
      </div>
      <div class="pd-stat">
        <div class="pd-stat-num">${avgCloseDays != null ? avgCloseDays + 'd' : '—'}</div>
        <div class="pd-stat-lbl">Avg overrun</div>
      </div>
    </div>
    <div class="person-dashboard-filters">
      <button type="button" class="pd-filter ${filter === 'all'     ? 'is-active' : ''}" data-filter="all">All (${allAssigned.length})</button>
      <button type="button" class="pd-filter ${filter === 'tasks'   ? 'is-active' : ''}" data-filter="tasks">Tasks (${tasks.length})</button>
      <button type="button" class="pd-filter ${filter === 'actions' ? 'is-active' : ''}" data-filter="actions">Actions (${actions.length})</button>
    </div>
    <div class="person-dashboard-list">
      ${visible.length === 0
        ? '<p class="empty-state">Nothing assigned in this view.</p>'
        : visible.map(t => {
            const overdue = isOverdue(t);
            const done = !open(t);
            const due = t.end_date ? fmtDate(t.end_date) : '—';
            const tag = t.is_action ? 'Action' : 'Task';
            return `
              <div class="pd-row ${overdue ? 'is-overdue' : ''} ${done ? 'is-done' : ''}" data-id="${t.id}" data-project="${escapeHtml(t.project || '')}">
                <span class="pd-row-tag pd-row-tag-${t.is_action ? 'action' : 'task'}">${tag}</span>
                <span class="pd-row-name" title="${escapeHtml(t.name || '')}">${escapeHtml(t.name || '')}</span>
                <span class="pd-row-project" title="${escapeHtml(t.project || '')}">${escapeHtml(t.project || '')}</span>
                <span class="pd-row-due">${due}</span>
              </div>`;
          }).join('')
      }
    </div>
  `;

  // Wire close button.
  panel.querySelector('.person-dashboard-close').addEventListener('click', closePersonDashboard);
  // Wire filter chips.
  panel.querySelectorAll('.pd-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      _personDashState.filter = btn.dataset.filter;
      renderPersonDashboard();
    });
  });
  // Click a row → open that project's schedule.
  panel.querySelectorAll('.pd-row').forEach(row => {
    row.addEventListener('click', () => {
      const project = row.dataset.project;
      if (!project) return;
      if (!state.openProjects.includes(project)) {
        state.openProjects.push(project);
      }
      state.filters.project = project;
      saveProjectTabs();
      closePersonDashboard();
      setView('schedule');
    });
  });

  // Show the panel (CSS handles the slide-in).
  panel.classList.add('is-open');
}

function renderTeam() {
  const grid = document.getElementById('team-grid');
  if (!grid) return;

  // Build a member row. Used for both regular and placeholder lists.
  const renderRow = (m) => {
    const ph = isPlaceholder(m.name);
    const focused = state.resources?.focusMemberId === m.id;
    const leadStar = m.is_lead ? '<span class="team-member-lead" title="Department lead">★</span>' : '';
    // v4.64: View button removed. Clicking ANYWHERE on the row focuses that
    // person — the resources timeline + dashboard cards below filter to
    // just their work. Clicks on the action buttons (lead toggle / remove)
    // bypass via stopPropagation in their own handlers.
    return `
      <li class="team-member${ph ? ' is-placeholder' : ''}${m.is_lead ? ' is-lead' : ''}${focused ? ' is-focused' : ''}" data-id="${m.id}" draggable="${ph ? 'false' : 'true'}">
        <span class="team-member-grip" title="Drag to reorder">⋮⋮</span>
        ${leadStar}
        <input type="text" class="team-member-name" value="${escapeHtml(m.name)}" data-id="${m.id}" />
        <input type="text" class="team-member-specialty" list="dl-specialty-levels" value="${escapeHtml(m.specialty || '')}" placeholder="Level / specialty" data-id="${m.id}" title="Experience level (Level 1 / 2 / 3) or specialty tag — type anything." />
        <button type="button" class="team-member-lead-toggle" data-action="toggle-lead" data-id="${m.id}" title="${m.is_lead ? 'Remove as lead' : 'Set as lead'}">${m.is_lead ? '★' : '☆'}</button>
        <button type="button" class="remove-btn" data-action="remove-member" data-id="${m.id}" title="Remove">×</button>
      </li>`;
  };

  grid.innerHTML = DISCIPLINES.map(disc => {
    // v4.56: placeholders are now SHOWN at the bottom of each card (per
    // user request). Reals on top (sorted lead-first then sort_order),
    // placeholders below in a separate visual stripe so the user can see
    // role markers like "ME Placeholder" / "Build Placeholder" are still
    // around to absorb action-item assignments before staffing locks.
    const allInDisc = state.team.filter(m => m.discipline === disc.key);
    const reals = allInDisc
      .filter(m => !isPlaceholder(m.name))
      .sort((a, b) => {
        const aLead = a.is_lead ? 0 : 1;
        const bLead = b.is_lead ? 0 : 1;
        if (aLead !== bLead) return aLead - bLead;
        return (a.sort_order || 0) - (b.sort_order || 0);
      });
    const placeholders = allInDisc
      .filter(m => isPlaceholder(m.name))
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    // Capacity math still only counts reals (the cap helper internally
    // filters placeholders), so passing allInDisc here is fine.
    const all = allInDisc.filter(m => !isPlaceholder(m.name));

    const realRows = reals.map(renderRow).join('');
    const phRows   = placeholders.map(renderRow).join('');
    const cap = computeDisciplineCapacity(disc.key, all);
    const capStats = `
      <div class="team-card-capacity" title="${escapeHtml(cap.tooltip)}">
        <span class="cap-stat"><span class="cap-num">${cap.realCount}</span> people</span>
        <span class="cap-sep">·</span>
        <span class="cap-stat"><span class="cap-num">${cap.scheduledHrs.toLocaleString()}</span> hrs</span>
        ${cap.weeksAhead != null ? `
          <span class="cap-sep">·</span>
          <span class="cap-stat"><span class="cap-num">${cap.weeksAhead}</span> wks @ 90%</span>
        ` : ''}
      </div>`;
    return `
      <section class="team-card" data-discipline="${disc.key}">
        <header class="team-card-head" style="background:${disc.color};color:${disc.text}">
          <h3>${escapeHtml(disc.label)}</h3>
        </header>
        ${capStats}
        <ul class="team-list">${realRows}</ul>
        ${phRows ? `<div class="team-placeholders-label">Placeholders</div><ul class="team-placeholders">${phRows}</ul>` : ''}
        <button type="button" class="team-add-btn" data-action="add-member" data-discipline="${disc.key}">+ Add member</button>
      </section>`;
  }).join('');

  // Wire add-member buttons (one per card).
  grid.querySelectorAll('[data-action="add-member"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const disc = btn.dataset.discipline;
      const created = await api.team.create({ name: 'New member', discipline: disc });
      await loadTeam();
      // Focus the new row's name input so the user types right into it.
      const input = document.querySelector(`.team-member-name[data-id="${created.id}"]`);
      if (input) { input.focus(); input.select(); }
    });
  });

  // Inline name edit (commit on blur or Enter, revert on Escape).
  grid.querySelectorAll('.team-member-name').forEach(input => {
    const id = Number(input.dataset.id);
    const original = input.value;
    input.addEventListener('blur', async () => {
      const v = input.value.trim();
      if (!v || v === original) { input.value = original || ''; return; }
      await api.team.update(id, { name: v });
      await loadTeam();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); input.value = original; input.blur(); }
    });
  });

  // Remove member.
  grid.querySelectorAll('[data-action="remove-member"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const member = state.team.find(m => m.id === id);
      if (!member) return;
      const tasksRef = state.tasks.filter(t => t.assignee === member.name).length;
      const msg = tasksRef > 0
        ? `Remove ${member.name}? They're still listed as the assignee on ${tasksRef} task(s) — those tasks will keep the name but it will be marked "(not on team)".`
        : `Remove ${member.name}?`;
      if (!confirm(msg)) return;
      await api.team.remove(id);
      await loadTeam();
    });
  });

  // Toggle lead — star button next to each team member's name.
  grid.querySelectorAll('[data-action="toggle-lead"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const member = state.team.find(m => m.id === id);
      if (!member) return;
      await api.team.update(id, { is_lead: !member.is_lead });
      await loadTeam();
    });
  });

  // Specialty — save on blur. Trim + treat empty as null so the placeholder
  // text shows again instead of an empty value.
  grid.querySelectorAll('.team-member-specialty').forEach(input => {
    const id = Number(input.dataset.id);
    const original = input.value;
    input.addEventListener('blur', async () => {
      const v = input.value.trim();
      if (v === original) return;
      await api.team.update(id, { specialty: v });
      await loadTeam();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); input.value = original; input.blur(); }
    });
  });

  // v4.64: click anywhere on the row to FOCUS that person. The resources
  // timeline + dashboard cards below filter to just their assignments.
  // Click handlers on the row's buttons stopPropagation so they don't
  // accidentally trigger this. Inputs are exempt — clicking the name to
  // edit it shouldn't kick off a re-render that yanks input focus.
  grid.querySelectorAll('.team-member').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (e.target.closest('input'))  return;
      if (e.target.closest('.team-member-grip')) return;
      const id = Number(row.dataset.id);
      if (!Number.isFinite(id)) return;
      // Toggle: clicking the already-focused row clears focus.
      const newFocus = (state.resources.focusMemberId === id) ? null : id;
      setFocusedMember(newFocus);
    });
  });
  // Lead-toggle + remove buttons get explicit stopPropagation so their
  // existing async handlers run without also triggering setFocusedMember.
  grid.querySelectorAll('[data-action="toggle-lead"], [data-action="remove-member"]').forEach(btn => {
    btn.addEventListener('click', (e) => e.stopPropagation());
  });

  // Drag-to-reorder within the same discipline. Placeholders are draggable=false
  // in markup so they stay pinned to the bottom; this handler only fires on
  // real members. Drop above or below a target row determines the new order.
  let dragSourceId = null;
  grid.querySelectorAll('.team-member[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      dragSourceId = Number(row.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragSourceId));
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
      grid.querySelectorAll('.team-member.drop-above, .team-member.drop-below')
        .forEach(el => el.classList.remove('drop-above', 'drop-below'));
    });
    row.addEventListener('dragover', (e) => {
      if (Number(row.dataset.id) === dragSourceId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const below = (e.clientY - rect.top) > rect.height / 2;
      row.classList.toggle('drop-above', !below);
      row.classList.toggle('drop-below',  below);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      const targetId = Number(row.dataset.id);
      const below = row.classList.contains('drop-below');
      row.classList.remove('drop-above', 'drop-below');
      if (!dragSourceId || dragSourceId === targetId) return;
      const source = state.team.find(m => m.id === dragSourceId);
      const target = state.team.find(m => m.id === targetId);
      if (!source || !target || source.discipline !== target.discipline) return;
      // Build the new order for the discipline's REAL (non-placeholder)
      // members. Placeholders keep their order in a separate list and aren't
      // affected by reordering real ones.
      const reals = state.team
        .filter(m => m.discipline === source.discipline && !isPlaceholder(m.name))
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      const filtered = reals.filter(m => m.id !== dragSourceId);
      const targetIdx = filtered.findIndex(m => m.id === targetId);
      const insertAt = below ? targetIdx + 1 : targetIdx;
      filtered.splice(insertAt, 0, source);
      const order = filtered.map(m => m.id);
      await fetch('/api/team/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
      await loadTeam();
    });
  });

  // The Resources timeline lives on the same page now — render it after the cards so the
  // discipline tabs and per-person rows reflect the team list above.
  renderResources();
}

// ---------- Resources view ----------
// Per-person workload timeline. Pick a discipline → see every active member of that
// discipline as a row, with their assigned tasks drawn as horizontal bars across all
// projects/schedules. Bars stack vertically when overlapping so you can spot conflicts.
const RES_PX_MIN = 1, RES_PX_MAX = 40;
function getResourcesPxPerDay() {
  // 100% = 6 px/day. Lets you see ~half a year on a normal-sized window.
  return Math.max(RES_PX_MIN, Math.min(RES_PX_MAX, (state.resources.zoomPercent / 100) * 6));
}

function projectColorFor(projectName) {
  // Hash project name to a stable HSL color. Works for arbitrary project counts without
  // a hard-coded palette.
  if (!projectName) return { fill: '#cbd5e1', stroke: '#475569', text: '#0f172a' };
  let hash = 0;
  for (let i = 0; i < projectName.length; i++) hash = (hash * 31 + projectName.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return { fill: `hsl(${hue} 70% 78%)`, stroke: `hsl(${hue} 55% 38%)`, text: `hsl(${hue} 60% 22%)` };
}

function resourcesTasksFor(memberName) {
  // All tasks (across all projects) currently assigned to this person, that have valid
  // dates so they can be plotted on the timeline.
  // Excluded:
  //   - Template projects (canonical scaffolding, not real work)
  //   - Sales workspace projects (pre-quote schedules; resourcing isn't real
  //     until they roll into Active)
  const projFilter = state.resources.project;
  return state.tasks.filter(t =>
    t.assignee === memberName &&
    t.start_date && t.end_date &&
    !isTemplateProject(t.project) &&
    projectWorkspace(t.project) !== 'Sales' &&
    (!projFilter || t.project === projFilter)
  );
}

// Walk every plotted task day-by-day, summing allocation %. Returns contiguous segments
// [{ startDay, endDay, total }] for the load strip below each row's bars. Adjacent days
// with the same running total merge into one segment so the row reads as "50% then 100%
// then 50%" rather than thirty individual day pills.
function computeLoadSegments(tasks, minDate) {
  const allocByDay = new Map();
  let firstDay = Infinity, lastDay = -Infinity;
  for (const t of tasks) {
    if (t.is_milestone) continue;
    const a = t.allocation == null ? 90 : Number(t.allocation);
    if (!a || a <= 0) continue;
    const s = Math.round((new Date(t.start_date) - minDate) / 86400000);
    const e = Math.round((new Date(t.end_date)   - minDate) / 86400000);
    firstDay = Math.min(firstDay, s);
    lastDay  = Math.max(lastDay,  e);
    for (let d = s; d <= e; d++) allocByDay.set(d, (allocByDay.get(d) || 0) + a);
  }
  if (allocByDay.size === 0) return [];
  const segs = [];
  let cur = null;
  for (let d = firstDay; d <= lastDay; d++) {
    const total = allocByDay.get(d) || 0;
    if (total === 0) {
      if (cur) { segs.push(cur); cur = null; }
      continue;
    }
    if (cur && cur.total === total && cur.endDay === d - 1) {
      cur.endDay = d;
    } else {
      if (cur) segs.push(cur);
      cur = { startDay: d, endDay: d, total };
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

// Walk every plotted task day-by-day, summing allocation %. Then collapse contiguous
// days where the running total exceeds 100% into stripes. Milestones and zero-allocation
// tasks are skipped — they don't consume capacity.
function computeOverloadRegions(tasks, minDate) {
  const allocByDay = new Map(); // day index → total allocation % that day
  for (const t of tasks) {
    if (t.is_milestone) continue;
    const a = t.allocation == null ? 90 : Number(t.allocation);
    if (!a || a <= 0) continue;
    const startDay = Math.round((new Date(t.start_date) - minDate) / 86400000);
    const endDay   = Math.round((new Date(t.end_date)   - minDate) / 86400000);
    for (let d = startDay; d <= endDay; d++) {
      allocByDay.set(d, (allocByDay.get(d) || 0) + a);
    }
  }
  const regions = [];
  const days = [...allocByDay.keys()].sort((a, b) => a - b);
  let cur = null;
  for (const d of days) {
    const total = allocByDay.get(d);
    if (total > 100) {
      if (cur && cur.endDay === d - 1) {
        cur.endDay = d;
        cur.peak = Math.max(cur.peak, total);
      } else {
        if (cur) regions.push(cur);
        cur = { startDay: d, endDay: d, peak: total };
      }
    } else if (cur) {
      regions.push(cur);
      cur = null;
    }
  }
  if (cur) regions.push(cur);
  return regions;
}

// Greedy stack assignment: sort tasks by start, place each one in the lowest-numbered
// "lane" whose last task ends before this one starts. Returns lanes array.
function assignTaskLanes(tasks) {
  const sorted = [...tasks].sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  const lastEndByLane = []; // lastEndByLane[i] = last end date in lane i
  return sorted.map(t => {
    const start = new Date(t.start_date);
    let lane = 0;
    while (lane < lastEndByLane.length && lastEndByLane[lane] >= start) lane++;
    lastEndByLane[lane] = new Date(t.end_date);
    return { task: t, lane };
  });
}

// ---------- Team dashboard ----------
// Three cards rendered below the resources timeline on the Team page. They give
// each discipline-manager a focused view of their team's workload across every
// open project: what's running late, what's coming up, and (per discipline)
// the key anchor dates that matter most to them.
function renderTeamDashboard() {
  const disc = state.resources?.discipline;
  if (!disc) return;
  const discDef = DISCIPLINE_BY_KEY[disc] || { label: disc };
  // v4.64: if a single member is focused, the dashboard cards narrow to just
  // that person's name. Otherwise we use every name in the discipline.
  const focusId = state.resources.focusMemberId;
  const focusedMember = focusId != null ? state.team.find(m => m.id === focusId) : null;
  const memberNames = focusedMember
    ? new Set([focusedMember.name])
    : new Set(state.team.filter(m => m.discipline === disc && m.active !== 0).map(m => m.name));
  // Departments dashboard skips:
  //   - Template projects (SDC_StandardProject_Template, SDC_Sales_Template, …)
  //     — they're scaffolding, not real work to surface as behind/coming-due.
  //   - Sales-workspace projects — sales schedules are pre-quote work that
  //     hasn't been staffed yet, so they shouldn't show up in engineering
  //     resource management.
  const isProjectExcluded = (p) => isTemplateProject(p) || projectWorkspace(p) === 'Sales';

  // --- Behind schedule ----------------------------------------------------
  // Every assigned task whose business-day drift is negative AND not a true
  // milestone (anchor / spine). v4.64: action items (is_milestone = 1 +
  // is_action = 1) are INCLUDED so the dashboard shows overdue actions too.
  const behind = state.tasks
    .filter(t => (!t.is_milestone || t.is_action) && t.assignee && memberNames.has(t.assignee) && !isProjectExcluded(t.project))
    .map(t => ({ task: t, drift: taskScheduleDelta(t) }))
    .filter(x => x.drift < 0)
    .sort((a, b) => a.drift - b.drift);
  renderDashboardList('dashboard-behind-body', behind, ({ task, drift }) => ({
    project: task.project,
    name: task.name,
    assignee: task.assignee,
    rightChip: { text: `${drift}d`, tone: 'danger' },
    onClick: () => jumpToTask(task),
  }), 'No tasks behind schedule for this team.');

  // --- Coming due ---------------------------------------------------------
  // Tasks starting OR finishing within the next 14 business days (~3 weeks
  // calendar). Helps a manager see "what's hitting the wire" for their crew.
  const todayMs = new Date().setHours(0, 0, 0, 0);
  const horizonMs = addBusinessDaysClient(new Date().toISOString().slice(0, 10), 14);
  const horizonStop = horizonMs ? new Date(horizonMs + 'T23:59:59').getTime() : todayMs + 21 * 86400000;
  const coming = state.tasks
    .filter(t => t.assignee && memberNames.has(t.assignee) && t.start_date && t.end_date && !isProjectExcluded(t.project))
    .map(t => {
      const startMs = new Date(t.start_date + 'T00:00:00').getTime();
      const endMs   = new Date(t.end_date   + 'T00:00:00').getTime();
      const startingSoon = startMs >= todayMs && startMs <= horizonStop;
      const finishingSoon = endMs >= todayMs && endMs <= horizonStop && !startingSoon;
      if (!startingSoon && !finishingSoon) return null;
      return { task: t, kind: startingSoon ? 'starts' : 'finishes', when: startingSoon ? t.start_date : t.end_date };
    })
    .filter(Boolean)
    .sort((a, b) => (a.when || '').localeCompare(b.when || ''));
  renderDashboardList('dashboard-coming-body', coming, ({ task, kind, when }) => ({
    project: task.project,
    name: task.name,
    assignee: task.assignee,
    rightChip: { text: `${kind} ${fmtDate(when)}`, tone: 'info' },
    onClick: () => jumpToTask(task),
  }), 'Nothing starting or finishing in the next 2 weeks.');

  // --- Key dates (discipline-specific) ------------------------------------
  // For each discipline, the anchor type that matters most to its manager.
  // Listed once per project so they can scan across the portfolio.
  const KEY_ANCHOR_BY_DISCIPLINE = {
    mech:     { anchor: 'mech_release_1',   title: 'Mech 1 Release across all projects' },
    controls: { anchor: 'fat',              title: 'FAT across all projects' },
    pm:       { anchor: 'ship_machine',     title: 'Ship Machine across all projects' },
    build:    { anchor: 'ship_machine',     title: 'Ship Machine across all projects' },
    wire:     { anchor: 'machine_power_up', title: 'Machine Power-Up across all projects' },
  };
  const keyDef = KEY_ANCHOR_BY_DISCIPLINE[disc];
  const keyTitleEl = document.getElementById('dashboard-keydates-title');
  const keySubEl   = document.getElementById('dashboard-keydates-sub');
  if (keyTitleEl) keyTitleEl.textContent = keyDef ? keyDef.title : 'Key dates';
  if (keySubEl)   keySubEl.textContent   = keyDef
    ? `Anchor: ${anchorLabelFor(keyDef.anchor)}` : 'No discipline-specific anchor configured.';
  let keyItems = [];
  if (keyDef) {
    keyItems = state.tasks
      .filter(t => inferredAnchorKey(t) === keyDef.anchor && !isProjectExcluded(t.project))
      .sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
  }
  renderDashboardList('dashboard-keydates-body', keyItems, (task) => ({
    project: task.project,
    name: anchorLabelFor(inferredAnchorKey(task)),
    assignee: '',
    rightChip: { text: fmtDate(task.start_date || task.end_date) || '—', tone: 'neutral' },
    onClick: () => jumpToTask(task),
  }), keyDef
    ? 'No projects have this anchor yet.'
    : `No key-date summary configured for ${discDef.label}.`);
}

// Look up a friendly anchor name from its key.
function anchorLabelFor(key) {
  const def = ANCHOR_DEFS.find(a => a.key === key);
  return def ? def.name : key;
}

// Switch to the Schedule view, activate the task's project tab, and scroll the
// row into view. Used by every "View on schedule" link in the dashboard cards.
function jumpToTask(task) {
  if (!task) return;
  if (task.project && !state.openProjects.includes(task.project)) {
    state.openProjects.push(task.project);
  }
  state.filters.project = task.project || '';
  saveProjectTabs();
  setView('schedule');
  setTimeout(() => {
    const tr = document.querySelector(`tr[data-id="${task.id}"]`);
    if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 50);
}

// Generic list renderer for the three dashboard cards. Each row gets a project
// chip on the left, the task / anchor name in the middle, and a tone-colored
// chip on the right (drift, date, or status). Clicking anywhere on the row
// triggers the row's onClick (typically jumpToTask).
function renderDashboardList(bodyId, items, mapper, emptyText) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  if (!items || items.length === 0) {
    body.innerHTML = `<p class="dashboard-empty">${escapeHtml(emptyText)}</p>`;
    return;
  }
  const rows = items.map((item, i) => {
    const r = mapper(item, i);
    const toneCls = `chip-${r.rightChip?.tone || 'neutral'}`;
    return `
      <button type="button" class="dashboard-row" data-i="${i}">
        <span class="dashboard-row-project">${escapeHtml(r.project || '—')}</span>
        <span class="dashboard-row-name">${escapeHtml(r.name || '')}</span>
        ${r.assignee ? `<span class="dashboard-row-assignee">${escapeHtml(r.assignee)}</span>` : ''}
        ${r.rightChip ? `<span class="dashboard-chip ${toneCls}">${escapeHtml(r.rightChip.text)}</span>` : ''}
      </button>
    `;
  }).join('');
  body.innerHTML = rows;
  body.querySelectorAll('.dashboard-row').forEach((row, idx) => {
    row.addEventListener('click', () => items[idx] && mapper(items[idx], idx).onClick?.());
  });
}

// v4.64: persist focus on a specific team member on the Departments tab.
// When set, the resources timeline + dashboard cards both filter to just
// that person's assignments. Toggling the same row again clears focus
// (back to "whole discipline" view).
function setFocusedMember(memberId) {
  state.resources.focusMemberId = memberId;
  // Update the .is-focused class on the team-member rows without a full
  // grid re-render — re-rendering would tear down input edits in progress.
  document.querySelectorAll('.team-member').forEach(row => {
    row.classList.toggle('is-focused', Number(row.dataset.id) === memberId);
  });
  // If the focused person belongs to a different discipline than the one
  // currently shown in the Resources tab, swap to their discipline so the
  // bars actually render.
  if (memberId != null) {
    const m = (state.team || []).find(x => x.id === memberId);
    if (m && m.discipline && m.discipline !== state.resources.discipline) {
      state.resources.discipline = m.discipline;
    }
  }
  renderResources();
  renderTeamDashboard();
  renderTeamFocusBanner();
}

// v4.64: small strip above the Resources timeline that names the focused
// person + offers a Clear button. Hidden when no one is focused.
function renderTeamFocusBanner() {
  let banner = document.getElementById('team-focus-banner');
  const resourcesSection = document.querySelector('#view-team .resources-section');
  if (!resourcesSection) return;
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'team-focus-banner';
    banner.className = 'team-focus-banner hidden';
    resourcesSection.parentNode.insertBefore(banner, resourcesSection);
  }
  const id = state.resources.focusMemberId;
  if (id == null) { banner.classList.add('hidden'); banner.innerHTML = ''; return; }
  const member = (state.team || []).find(m => m.id === id);
  if (!member) { banner.classList.add('hidden'); banner.innerHTML = ''; return; }
  const disc = DISCIPLINE_BY_KEY[member.discipline];
  banner.classList.remove('hidden');
  banner.style.background = disc?.color || '#e2e8f0';
  banner.style.color      = disc?.text  || '#0f172a';
  banner.innerHTML = `
    <span class="team-focus-banner-label">Focused on</span>
    <strong>${escapeHtml(member.name)}</strong>
    ${disc ? `<span class="team-focus-banner-disc">${escapeHtml(disc.label)}</span>` : ''}
    <button type="button" class="team-focus-banner-clear" title="Show the whole discipline again">× Clear focus</button>
  `;
  banner.querySelector('.team-focus-banner-clear').addEventListener('click', () => {
    setFocusedMember(null);
  });
}

function renderResources() {
  // Dashboard cards re-render alongside the resources timeline so they always
  // reflect the currently selected discipline.
  renderTeamDashboard();

  const body = document.getElementById('resources-body');
  const empty = document.getElementById('resources-empty');
  if (!body) return;

  // Discipline tabs
  const discWrap = document.getElementById('resources-disciplines');
  if (discWrap && !discWrap.dataset.bound) {
    discWrap.dataset.bound = '1';
    discWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-discipline]');
      if (!btn) return;
      state.resources.discipline = btn.dataset.discipline;
      renderResources();
    });
  }
  if (discWrap) {
    discWrap.innerHTML = DISCIPLINES.map(d => `
      <button type="button" class="discipline-tab ${state.resources.discipline === d.key ? 'active' : ''}"
              data-discipline="${d.key}"
              style="--disc-color:${d.color};--disc-text:${d.text}">
        ${escapeHtml(d.label)}
      </button>`).join('');
  }

  // Project filter — pull project names from the current task list
  const projSel = document.getElementById('resources-project');
  if (projSel && !projSel.dataset.bound) {
    projSel.dataset.bound = '1';
    projSel.addEventListener('change', () => {
      state.resources.project = projSel.value;
      renderResources();
    });
  }
  if (projSel) {
    const projects = [...new Set(state.tasks.map(t => t.project).filter(Boolean))].sort();
    projSel.innerHTML = '<option value="">All projects</option>' +
      projects.map(p => `<option value="${escapeHtml(p)}" ${state.resources.project === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('');
  }

  // Zoom controls
  const zo = document.getElementById('resources-zoom-out');
  const zi = document.getElementById('resources-zoom-in');
  const zf = document.getElementById('resources-zoom-fit');
  if (zo && !zo.dataset.bound) {
    zo.dataset.bound = '1';
    zo.addEventListener('click', () => { state.resources.zoomPercent = Math.max(10, state.resources.zoomPercent / 1.2); renderResources(); });
  }
  if (zi && !zi.dataset.bound) {
    zi.dataset.bound = '1';
    zi.addEventListener('click', () => { state.resources.zoomPercent = Math.min(800, state.resources.zoomPercent * 1.2); renderResources(); });
  }
  if (zf && !zf.dataset.bound) {
    zf.dataset.bound = '1';
    zf.addEventListener('click', () => { fitResourcesZoom(); });
  }
  document.getElementById('resources-zoom-percent').textContent = `${Math.round(state.resources.zoomPercent)}%`;

  // Build the active member list for the selected discipline. Same ordering as
  // the team cards above: placeholders FIRST (they're the template-stage
  // stand-ins, useful to see at the top when planning), then real members with
  // the LEAD first, then everyone else by their dragged sort_order.
  // v4.64: when a member is focused (clicked on the team panel above), narrow
  // to just that person regardless of discipline.
  let members = state.team
    .filter(m => m.discipline === state.resources.discipline && m.active !== 0)
    .sort((a, b) => {
      const aPh = isPlaceholder(a.name) ? 0 : 1;
      const bPh = isPlaceholder(b.name) ? 0 : 1;
      if (aPh !== bPh) return aPh - bPh;
      const aLead = a.is_lead ? 0 : 1;
      const bLead = b.is_lead ? 0 : 1;
      if (aLead !== bLead) return aLead - bLead;
      return (a.sort_order || 0) - (b.sort_order || 0);
    });
  if (state.resources.focusMemberId != null) {
    members = members.filter(m => m.id === state.resources.focusMemberId);
  }

  // Empty state — no members in this discipline OR no tasks anywhere yet
  if (members.length === 0) {
    body.innerHTML = '';
    if (empty) {
      body.appendChild(empty);
      empty.classList.remove('hidden');
    }
    document.getElementById('resources-legend').innerHTML = '';
    return;
  }
  if (empty) empty.classList.add('hidden');

  // Compute the union date range across every plotted task so all rows share an axis.
  const allTasks = members.flatMap(m => resourcesTasksFor(m.name));
  let firstTaskDate = null, lastTaskDate = null;
  for (const t of allTasks) {
    const s = new Date(t.start_date), e = new Date(t.end_date);
    if (!firstTaskDate || s < firstTaskDate) firstTaskDate = s;
    if (!lastTaskDate  || e > lastTaskDate)  lastTaskDate  = e;
  }
  // No tasks for any member — anchor the timeline around today so the user can still
  // drag through a sensible date range and the empty future doesn't disappear.
  const _today = new Date(); _today.setHours(0,0,0,0);
  if (!firstTaskDate) {
    firstTaskDate = new Date(_today); firstTaskDate.setDate(firstTaskDate.getDate() - 30);
    lastTaskDate  = new Date(_today); lastTaskDate.setDate(lastTaskDate.getDate() + 60);
  }
  // Pad ~6 months on each side so users can drag freely into the past/future to check
  // gaps and upcoming load. The first-task position is remembered below so we can scroll
  // back to it after rendering instead of showing 6 months of empty space at the left edge.
  const PAD_DAYS = 180;
  const minDate = new Date(firstTaskDate); minDate.setDate(minDate.getDate() - PAD_DAYS);
  const maxDate = new Date(lastTaskDate);  maxDate.setDate(maxDate.getDate()  + PAD_DAYS);

  const pxPerDay = getResourcesPxPerDay();
  const totalDays = Math.max(1, Math.round((maxDate - minDate) / 86400000));
  const tlWidth = Math.max(400, totalDays * pxPerDay);
  const NAME_COL_W = 180;
  const BAR_H = 16;
  const LANE_GAP = 3;
  const ROW_PAD = 6;

  // View-mode label so the user can see at what scale they're at.
  let modeLabel = 'days';
  if (pxPerDay < 1.2) modeLabel = 'months';
  else if (pxPerDay < 8) modeLabel = 'weeks';
  document.getElementById('resources-mode-label').textContent = modeLabel;

  // Build the rows. The header is a sticky date axis spanning the timeline column.
  const dateTicks = buildResourceDateTicks(minDate, maxDate, pxPerDay, modeLabel);
  let html = `
    <div class="resources-table" style="--name-col-w:${NAME_COL_W}px;--tl-width:${tlWidth}px;">
      <div class="resources-header">
        <div class="resources-name-cell"></div>
        <div class="resources-axis" style="width:${tlWidth}px">${dateTicks}</div>
      </div>`;

  // Thin strip under the bars showing the running daily total per segment.
  const STRIP_H = 12;
  const STRIP_GAP = 2;

  for (const m of members) {
    const ph = isPlaceholder(m.name);
    const tasks = resourcesTasksFor(m.name);
    const placed = assignTaskLanes(tasks);
    const lanes = placed.length === 0 ? 1 : (Math.max(...placed.map(p => p.lane)) + 1);
    // Reserve room for the load strip below the bars (only when there are tasks AND
    // this is a real person — placeholders don't get a load strip at all).
    const stripExtra = (!ph && tasks.length > 0) ? STRIP_H + STRIP_GAP : 0;
    const rowH = ROW_PAD * 2 + lanes * BAR_H + (lanes - 1) * LANE_GAP + stripExtra;

    // Overload regions = contiguous spans of days where the sum of allocations across all
    // overlapping (non-milestone) tasks exceeds 100%. Two 50% tasks overlapping is fine —
    // the day reads 100% and stays clean. Two 100% tasks reads 200% and gets a red stripe.
    // Placeholders are role-stand-ins (managers' eyes look at the workload SHAPE, not a
    // capacity warning) — skip overload entirely on those rows.
    const overload = ph ? [] : computeOverloadRegions(tasks, minDate);
    const peakLoad = overload.length === 0 ? null : Math.max(...overload.map(r => r.peak));
    const overloadHtml = overload.map(r => {
      const x = r.startDay * pxPerDay;
      const w = Math.max(2, (r.endDay - r.startDay + 1) * pxPerDay);
      return `<div class="res-overload" style="left:${x}px;width:${w}px;height:${rowH}px" title="Peak ${r.peak}% allocation"></div>`;
    }).join('');

    // Load segments — one pill per contiguous span of equal total allocation. Sits below
    // the bars in a 12px strip so users can see "50%, then 100% during the overlap" without
    // having to mentally add up the pieces. Pills color-code: under/full/over 100%.
    // Placeholders skip this entirely — they're role-stand-ins, not capacity-tracked.
    const loadSegs = ph ? [] : computeLoadSegments(tasks, minDate);
    const loadHtml = loadSegs.map(s => {
      const x = s.startDay * pxPerDay;
      const w = Math.max(2, (s.endDay - s.startDay + 1) * pxPerDay);
      const cls = s.total > 100 ? 'load-over' : (s.total === 100 ? 'load-full' : 'load-partial');
      const dayLabel = s.startDay === s.endDay ? '' : ` (${s.endDay - s.startDay + 1}d)`;
      return `
        <div class="res-load-seg ${cls}" style="left:${x}px;width:${w}px;height:${STRIP_H}px;bottom:${ROW_PAD - 2}px"
             title="${s.total}% total${dayLabel}">${s.total}%</div>`;
    }).join('');

    // A task only NEEDS a priority when it overlaps in time with another task for
    // the same person — that's the only case where the system has to pick which to
    // do first. Compute the overlap set here so the per-bar code below can decide
    // whether to render the priority pill.
    const overlapIds = new Set();
    for (let i = 0; i < tasks.length; i++) {
      const a = tasks[i];
      if (a.is_milestone) continue;
      const aS = new Date(a.start_date).getTime();
      const aE = new Date(a.end_date).getTime();
      for (let j = i + 1; j < tasks.length; j++) {
        const b = tasks[j];
        if (b.is_milestone) continue;
        const bS = new Date(b.start_date).getTime();
        const bE = new Date(b.end_date).getTime();
        if (aS <= bE && bS <= aE) {
          overlapIds.add(a.id);
          overlapIds.add(b.id);
        }
      }
    }

    const bars = placed.map(({ task, lane }) => {
      const startOffset = (new Date(task.start_date) - minDate) / 86400000;
      const dur = Math.max(1, Math.round((new Date(task.end_date) - new Date(task.start_date)) / 86400000) + 1);
      const x = startOffset * pxPerDay;
      const w = Math.max(2, dur * pxPerDay);
      const y = ROW_PAD + lane * (BAR_H + LANE_GAP);
      const alloc = task.is_milestone ? null : (task.allocation == null ? 90 : task.allocation);
      const labelDate = `${fmtDate(task.start_date)} – ${fmtDate(task.end_date)}`;
      const tip = `${task.project ? `[${task.project}] ` : ''}${task.name} · ${labelDate}${alloc != null ? ` · ${alloc}%` : ''}`;
      // 100% is the default — at the default we skip the alloc text entirely so the bar's
      // full width belongs to the label (no more "Ro…" clipping just to fit "100%"). For
      // non-default allocations we append " · 50%" to the label string itself, which lets
      // the existing ellipsis handle truncation gracefully when the bar is narrow.
      const baseLabel = task.project ? `${task.project} · ${task.name}` : task.name;
      const labelText = (alloc != null && alloc !== 100) ? `${baseLabel} · ${alloc}%` : baseLabel;
      const lowAllocClass = (alloc != null && alloc < 100) ? ' low-alloc' : '';
      const overClass = state.overAllocatedTaskIds.has(task.id) ? ' over-allocated' : '';
      // Bar color reflects SCHEDULE STATUS — same scheme as the % complete pill
      // in the grid, just blown up to a full bar so you can scan the team page
      // and see what's hot at a glance:
      //   slate   = 0%, not started
      //   red     = 1–99% AND behind schedule
      //   green   = 1–99% AND on/ahead
      //   emerald = 100% complete
      const pct = Math.max(0, Math.min(100, Number(task.progress) || 0));
      const drift = taskScheduleDelta(task);
      let statusClass = 'status-zero';
      if (pct >= 100) statusClass = 'status-done';
      else if (pct > 0) statusClass = drift < 0 ? 'status-behind' : 'status-ontrack';
      const pri = task.priority == null ? 1 : task.priority;
      // Priority pill rules:
      //   - Placeholders never show one — placeholders are role-stand-ins, not
      //     workload-ranked.
      //   - Real people only show one on tasks that OVERLAP another of their tasks.
      //     A solo task at a unique date span doesn't need a priority — it's the
      //     only thing competing for that day, automatically #1.
      const showPriPill = !ph && overlapIds.has(task.id);
      const priPill = showPriPill
        ? `<span class="res-bar-priority" data-task-id="${task.id}" data-priority="${pri}" title="Priority ${pri} — click to change">${pri}</span>`
        : '';
      return `
        <div class="res-bar ${statusClass}${lowAllocClass}${overClass}" style="left:${x}px;top:${y}px;width:${w}px;height:${BAR_H}px;"
             title="${escapeHtml(tip)}"
             data-task-id="${task.id}">
          ${priPill}
          <span class="res-bar-label">${escapeHtml(labelText)}</span>
        </div>`;
    }).join('');
    const totalDuration = tasks.reduce((sum, t) => sum + Math.max(1, Math.round((new Date(t.end_date) - new Date(t.start_date)) / 86400000) + 1), 0);
    // Peak overload pill appears INLINE with the name only when the person is
    // over-allocated (>100%). The previous "X tasks · Yd" meta line under the
    // name was getting cut off at tight row heights — dropped per user request,
    // the bars to the right convey the same info visually.
    const peakInline = peakLoad != null
      ? ` <span class="res-overload-pill">peak ${peakLoad}%</span>` : '';
    html += `
      <div class="resources-row${peakLoad != null ? ' has-overload' : ''}${ph ? ' is-placeholder' : ''}" style="height:${rowH}px">
        <div class="resources-name-cell">
          <span class="resources-name">${escapeHtml(m.name)}${peakInline}</span>
        </div>
        <div class="resources-track" style="width:${tlWidth}px">${overloadHtml}${bars}${loadHtml}</div>
      </div>`;
  }
  html += `</div>`;
  body.innerHTML = html;

  // Legend = the four status colors that drive every bar's fill. Replaces the
  // older per-project color legend (bars haven't used project color since the
  // schedule-status palette took over).
  const legend = document.getElementById('resources-legend');
  legend.innerHTML = [
    { cls: 'status-zero',    label: 'Not started' },
    { cls: 'status-behind',  label: 'Behind schedule' },
    { cls: 'status-ontrack', label: 'On track / ahead' },
    { cls: 'status-done',    label: 'Done' },
  ].map(({ cls, label }) =>
    `<span class="legend-item"><span class="legend-swatch res-bar ${cls}" style="position:static;width:14px;height:14px;padding:0;display:inline-block;vertical-align:middle"></span>${escapeHtml(label)}</span>`
  ).join('');

  // Click a priority pill → cycle through 1..N (where N is the number of this
  // person's tasks that overlap with at least one other). Wraps N → 1. Server-side
  // conflict resolution displaces whoever was previously at the new priority.
  body.querySelectorAll('.res-bar-priority').forEach(pill => {
    pill.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(pill.dataset.taskId);
      const cur = Number(pill.dataset.priority) || 1;
      const task = state.tasks.find(t => t.id === id);
      if (!task || !task.assignee) return;
      // Find tasks belonging to this assignee that are in an overlapping group.
      // The cycle modulus is the size of that group (count of tasks with priorities
      // in the same conflict).
      const peers = state.tasks.filter(t =>
        t.assignee === task.assignee &&
        !t.is_milestone &&
        t.start_date && t.end_date
      );
      const overlapPeers = peers.filter(t =>
        peers.some(o => o.id !== t.id &&
          new Date(o.start_date) <= new Date(t.end_date) &&
          new Date(o.end_date) >= new Date(t.start_date))
      );
      const N = overlapPeers.length;
      if (N < 2) return; // single task — no cycling needed
      const next = (cur % N) + 1;
      pill.textContent = String(next); // optimistic update so the click reads instant
      pill.dataset.priority = String(next);
      pill.title = `Priority ${next} — click to change`;
      await api.update(id, { priority: next });
      await loadTasks();
    });
  });
  body.querySelectorAll('.res-bar').forEach(b => {
    b.addEventListener('click', (e) => {
      // Click on the priority pill is handled separately and stops propagation; this
      // guard catches any other interactive descendants we add later.
      if (e.target.closest('.res-bar-priority, .res-bar-priority-input')) return;
      e.stopPropagation();
      const id = Number(b.dataset.taskId);
      // Same popup for every bar — placeholder or real person. Lets the manager
      // reassign to anyone in the discipline (including back to a placeholder) or
      // jump to the task's row on the Schedule grid.
      openResourceBarMenu(b, id);
    });
  });

  setupResourcesPan();

  // After rendering, scroll horizontally so the first plotted task sits ~40px from the
  // left edge instead of leaving the user staring at 180 days of empty padding. This
  // remembers a per-discipline scroll position so re-renders (zoom, filter, edits) don't
  // jump them back to "first task" unexpectedly — only fresh switches do.
  const firstTaskOffsetDays = (firstTaskDate - minDate) / 86400000;
  const desiredLeft = Math.max(0, firstTaskOffsetDays * pxPerDay - 40);
  const scrollKey = `${state.resources.discipline}|${state.resources.project}`;
  if (state.resources.lastScrollKey !== scrollKey) {
    state.resources.lastScrollKey = scrollKey;
    body.scrollLeft = desiredLeft;
  }
}

// Popup launched on EVERY resource-bar click — placeholder rows or real-person rows.
// Lists every team member in the discipline (real people + placeholders) so the
// manager can move a task wherever, plus an "Open in schedule" option to jump to
// the task's row on the grid. Whoever is currently assigned is dimmed in the list
// since picking them is a no-op.
function openResourceBarMenu(barEl, taskId) {
  document.getElementById('placeholder-reassign')?.remove();
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  const disc = state.resources.discipline;
  const members = state.team.filter(m => m.discipline === disc && m.active !== 0)
    .sort((a, b) => {
      const aPh = isPlaceholder(a.name) ? 1 : 0;
      const bPh = isPlaceholder(b.name) ? 1 : 0;
      if (aPh !== bPh) return aPh - bPh; // real people first
      return (a.sort_order || 0) - (b.sort_order || 0);
    });

  const r = barEl.getBoundingClientRect();
  const POPUP_W = 280;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - POPUP_W - 8));
  const top  = r.bottom + 6;
  const pop = document.createElement('div');
  pop.id = 'placeholder-reassign';
  pop.className = 'project-add-picker'; // reuse picker styling
  pop.style.left = left + 'px';
  pop.style.top  = top + 'px';
  pop.style.width = POPUP_W + 'px';
  const projLabel = task.project ? `<span class="picker-row-count">${escapeHtml(task.project)}</span>` : '';
  const rows = members.length === 0
    ? '<div class="picker-empty">No team members in this discipline yet. Add them on the Team tab.</div>'
    : members.map(m => {
        const isCurrent = m.name === task.assignee;
        const cls = ['picker-row'];
        if (isCurrent) cls.push('is-current');
        if (isPlaceholder(m.name)) cls.push('is-placeholder');
        const tag = isCurrent ? ' <span class="picker-row-count">current</span>' : '';
        return `<button class="${cls.join(' ')}" data-name="${escapeHtml(m.name)}" type="button">${escapeHtml(m.name)}${tag}</button>`;
      }).join('');
  pop.innerHTML = `
    <div class="picker-section-title">Reassign ${projLabel}</div>
    <div class="picker-row-task">${escapeHtml(task.name)}</div>
    ${rows}
    <div class="picker-divider"></div>
    <button class="picker-row picker-row-clear" type="button" data-action="unassign">Leave unassigned</button>
    <button class="picker-row" type="button" data-action="open-schedule">📅 Open in schedule</button>`;
  document.body.appendChild(pop);
  pop.querySelectorAll('.picker-row[data-name]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      pop.remove();
      if (name === task.assignee) return; // no-op when picking the current one
      await api.update(taskId, { assignee: name });
      await loadTasks();
    });
  });
  pop.querySelector('[data-action="unassign"]').addEventListener('click', async () => {
    pop.remove();
    await api.update(taskId, { assignee: null });
    await loadTasks();
  });
  pop.querySelector('[data-action="open-schedule"]').addEventListener('click', () => {
    pop.remove();
    setView('schedule');
    requestAnimationFrame(() => {
      const tr = document.querySelector(`tr[data-id="${taskId}"]`);
      if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
  setTimeout(() => {
    const onDoc = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== barEl) {
        pop.remove();
        document.removeEventListener('mousedown', onDoc);
      }
    };
    document.addEventListener('mousedown', onDoc);
  }, 0);
}

function buildResourceDateTicks(minDate, maxDate, pxPerDay, mode) {
  // Render ticks at month, week, or day boundaries depending on the zoom level. Each tick
  // is an absolutely-positioned label inside the axis div; pillars/grid lines come from CSS.
  const ticks = [];
  const start = new Date(minDate);
  start.setHours(0, 0, 0, 0);
  if (mode === 'months') {
    let cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= maxDate) {
      const offset = (cur - minDate) / 86400000;
      ticks.push({ x: offset * pxPerDay, label: cur.toLocaleString('en-US', { month: 'short', year: '2-digit' }) });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
  } else if (mode === 'weeks') {
    let cur = new Date(start);
    cur.setDate(cur.getDate() - cur.getDay()); // back to Sunday
    while (cur <= maxDate) {
      const offset = (cur - minDate) / 86400000;
      ticks.push({ x: offset * pxPerDay, label: `${cur.getMonth() + 1}/${cur.getDate()}` });
      cur.setDate(cur.getDate() + 7);
    }
  } else {
    let cur = new Date(start);
    while (cur <= maxDate) {
      const offset = (cur - minDate) / 86400000;
      ticks.push({ x: offset * pxPerDay, label: `${cur.getMonth() + 1}/${cur.getDate()}` });
      cur.setDate(cur.getDate() + 1);
    }
  }
  return ticks.map(t => `<span class="resources-tick" style="left:${t.x}px">${escapeHtml(t.label)}</span>`).join('');
}

// Click-and-drag horizontal/vertical pan on the resources body so the user can scroll
// past the actual task range to inspect future or historical assignments. Same pattern
// the schedule grid uses (4-px movement threshold distinguishes pan from a bar click).
function setupResourcesPan() {
  const body = document.getElementById('resources-body');
  if (!body || body.dataset.panBound === '1') return;
  body.dataset.panBound = '1';

  body.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // Don't intercept clicks on bars (they navigate) or interactive controls.
    if (e.target.closest('.res-bar, button, input, select, a, label')) return;

    const startX = e.clientX, startY = e.clientY;
    const startScrollLeft = body.scrollLeft;
    const startScrollTop  = body.scrollTop;
    let panning = false;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!panning && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        panning = true;
        body.classList.add('panning');
      }
      if (panning) {
        ev.preventDefault();
        body.scrollLeft = startScrollLeft - dx;
        body.scrollTop  = startScrollTop  - dy;
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      body.classList.remove('panning');
      // If the user actually panned, swallow the click that fires after mouseup so we
      // don't accidentally trigger a load-segment tooltip click or similar.
      if (panning) {
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        body.addEventListener('click', swallow, { capture: true, once: true });
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function fitResourcesZoom() {
  // Pick a zoom that fits the full task range into the visible body width.
  const body = document.getElementById('resources-body');
  if (!body) return;
  const visibleW = Math.max(400, body.clientWidth - 220); // minus name column
  const allTasks = state.team
    .filter(m => m.discipline === state.resources.discipline && m.active !== 0)
    .flatMap(m => resourcesTasksFor(m.name));
  if (allTasks.length === 0) { state.resources.zoomPercent = 100; renderResources(); return; }
  let minD = null, maxD = null;
  for (const t of allTasks) {
    const s = new Date(t.start_date), e = new Date(t.end_date);
    if (!minD || s < minD) minD = s;
    if (!maxD || e > maxD) maxD = e;
  }
  const totalDays = Math.max(1, Math.round((maxD - minD) / 86400000) + 14);
  const desiredPxPerDay = visibleW / totalDays;
  state.resources.zoomPercent = Math.max(10, Math.min(800, (desiredPxPerDay / 6) * 100));
  renderResources();
}

// ---------- Setup view ----------
function ensureSetupDraft() {
  if (!state.setupDraft) {
    state.setupDraft = JSON.parse(JSON.stringify(state.settings));
  }
}

function renderSetup() {
  ensureSetupDraft();
  const d = state.setupDraft;

  // (Row-height now lives in the schedule toolbar — used to be a slider here.)

  // Palette
  const list = document.getElementById('palette-list');
  list.innerHTML = (d.brand_palette || []).map((c, i) => `
    <div class="palette-row" data-i="${i}">
      <input type="color" value="${c.hex}" data-field="hex" />
      <input type="text" value="${c.hex.toUpperCase()}" class="hex-input" data-field="hex-text" maxlength="7" />
      <input type="text" value="${escapeHtml(c.name)}" data-field="name" placeholder="Name" />
      <button type="button" class="remove-btn" data-action="remove-color" title="Remove">×</button>
    </div>`).join('');

  // Theme
  const t = d.theme || {};
  for (const key of ['primary', 'dark', 'accent']) {
    const v = t[key] || '#000000';
    document.getElementById(`theme-${key}`).value = v;
    document.getElementById(`theme-${key}-hex`).value = v.toUpperCase();
  }

  // Section colors — three pickable section header colors (10/40/50). Defaults seeded from
  // SECTION_COLOR_DEFAULTS in loadSettings.
  if (!d.section_colors) d.section_colors = { ...SECTION_COLOR_DEFAULTS };
  for (const key of ['design_build', 'machine_testing', 'teardown_install']) {
    const v = d.section_colors[key] || SECTION_COLOR_DEFAULTS[key];
    const dash = key.replace(/_/g, '-');
    document.getElementById(`section-${dash}`).value = v;
    document.getElementById(`section-${dash}-hex`).value = v.toUpperCase();
  }

  // Anchor color — single fill + text shared by all three project anchors.
  if (!d.anchor_color) d.anchor_color = { ...ANCHOR_COLOR_DEFAULTS };
  document.getElementById('anchor-fill').value     = d.anchor_color.fill;
  document.getElementById('anchor-fill-hex').value = d.anchor_color.fill.toUpperCase();
  document.getElementById('anchor-text').value     = d.anchor_color.text;
  document.getElementById('anchor-text-hex').value = d.anchor_color.text.toUpperCase();

  // % complete pill colors — 4 states (zero / behind / ontrack / done). One
  // color picker per state; text is always black so there's nothing to
  // configure on that side.
  d.pct_colors = normalizePctColors(d.pct_colors);
  for (const k of PCT_COLOR_KEYS) {
    const v = d.pct_colors[k];
    document.getElementById(`pct-${k}-fill`).value     = v;
    document.getElementById(`pct-${k}-fill-hex`).value = v.toUpperCase();
  }

  // Hierarchy colors — one row per group. Each row has a fill picker, a text picker,
  // matching hex inputs, and a small live preview pill.
  if (!d.hierarchy_colors) d.hierarchy_colors = JSON.parse(JSON.stringify(HIERARCHY_COLOR_DEFAULTS));
  for (const k of HIERARCHY_KEYS) {
    d.hierarchy_colors[k] = { ...HIERARCHY_COLOR_DEFAULTS[k], ...(d.hierarchy_colors[k] || {}) };
  }
  const hbody = document.getElementById('hierarchy-colors-list');
  hbody.innerHTML = HIERARCHY_KEYS.map(k => {
    const c = d.hierarchy_colors[k];
    return `
      <tr data-key="${k}">
        <td>${escapeHtml(c.label || HIERARCHY_COLOR_DEFAULTS[k].label)}</td>
        <td><span class="color-pair">
          <input type="color" data-field="fill" value="${c.fill}" />
          <input type="text"  data-field="fill-hex" class="hex-input" maxlength="7" value="${c.fill.toUpperCase()}" />
        </span></td>
        <td><span class="color-pair">
          <input type="color" data-field="text" value="${c.text}" />
          <input type="text"  data-field="text-hex" class="hex-input" maxlength="7" value="${c.text.toUpperCase()}" />
        </span></td>
        <td class="preview-cell"><span class="phase-chip" style="background:${c.fill};color:${c.text}">${escapeHtml(c.label || k)}</span></td>
      </tr>`;
  }).join('');

  // Phases
  const tbody = document.getElementById('phases-list');
  tbody.innerHTML = (d.phases || []).map((p, i) => `
    <tr data-i="${i}">
      <td class="col-drag" title="Drag to reorder (coming soon)">⋮⋮</td>
      <td><input type="text" data-field="label" value="${escapeHtml(p.label)}" /></td>
      <td><input type="text" class="key-input" data-field="key" value="${escapeHtml(p.key)}" /></td>
      <td>
        <span class="color-pair">
          <input type="color" data-field="color" value="${p.color}" />
          <input type="text" class="hex-input" data-field="color-text" value="${p.color.toUpperCase()}" maxlength="7" />
        </span>
      </td>
      <td>
        <span class="color-pair">
          <input type="color" data-field="text" value="${p.text}" />
          <input type="text" class="hex-input" data-field="text-text" value="${p.text.toUpperCase()}" maxlength="7" />
        </span>
      </td>
      <td class="preview-cell"><span class="phase-chip" style="background:${p.color};color:${p.text}">${escapeHtml(p.label)}</span></td>
      <td><button type="button" class="remove-btn" data-action="remove-phase" title="Remove">×</button></td>
    </tr>`).join('');

  // Standard Financial Milestones — defaults applied to new projects.
  if (!Array.isArray(d.default_financial_milestones)) {
    d.default_financial_milestones = state.settings?.default_financial_milestones || [];
  }
  const finBody = document.getElementById('default-financials-list');
  if (finBody) {
    const anchorOptions = [
      { key: '',                  label: '— (none)' },
      { key: 'receipt_of_po',     label: 'Receipt of PO' },
      { key: 'machine_power_up',  label: 'Machine Power-Up' },
      { key: 'fat',               label: 'FAT' },
      { key: 'ship_machine',      label: 'Ship Machine' },
    ];
    finBody.innerHTML = d.default_financial_milestones.map((f, i) => `
      <tr data-i="${i}">
        <td><input type="text" data-field="name" value="${escapeHtml(f.name || '')}" placeholder="e.g. Down Payment" /></td>
        <td class="num"><input type="number" min="0" step="any" data-field="percent" value="${f.percent ?? ''}" /></td>
        <td>
          <select data-field="sync_to_anchor">
            ${anchorOptions.map(o => `<option value="${o.key}" ${(f.sync_to_anchor || '') === o.key ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
          </select>
        </td>
        <td><button type="button" class="remove-btn" data-action="remove-default-financial" title="Remove">×</button></td>
      </tr>
    `).join('');
  }

  // Standard Project Milestones library.
  if (!Array.isArray(d.project_milestone_library)) {
    d.project_milestone_library = state.settings?.project_milestone_library || [];
  }
  const libBody = document.getElementById('milestone-library-list');
  if (libBody) {
    const sectionOptions = HIERARCHY.map(g => ({ key: g.key, label: g.label }));
    libBody.innerHTML = d.project_milestone_library.map((m, i) => {
      const sec = m.suggested_section || '';
      const group = sectionOptions.find(s => s.key === sec);
      const deptOpts = group ? (GROUP_BY_KEY[sec]?.departments || []) : [];
      return `
        <tr data-i="${i}">
          <td><input type="text" data-field="name" value="${escapeHtml(m.name || '')}" /></td>
          <td>
            <select data-field="suggested_section">
              <option value="">—</option>
              ${sectionOptions.map(o => `<option value="${o.key}" ${sec === o.key ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
            </select>
          </td>
          <td>
            <select data-field="suggested_dept" ${deptOpts.length === 0 ? 'disabled' : ''}>
              <option value="">—</option>
              ${deptOpts.map(d => `<option value="${d.key}" ${(m.suggested_dept || '') === d.key ? 'selected' : ''}>${escapeHtml(d.label)}</option>`).join('')}
            </select>
          </td>
          <td><button type="button" class="remove-btn" data-action="remove-milestone-template" title="Remove">×</button></td>
        </tr>
      `;
    }).join('');
  }

  document.getElementById('setup-status').textContent = '';
  bindSetupHandlers();
  renderArrowReference();
}

// ---------- Arrow & milestone reference (Setup view) ----------
const ARROW_DEMO_SCENARIOS_BAR = [
  { type: 'FS', lag:  0, label: 'FS — Finish to Start',         syntax: '5 (or 5FS)' },
  { type: 'FS', lag:  2, label: 'FS +2d — lag (gap after pred)', syntax: '5FS +2d' },
  { type: 'FS', lag: -2, label: 'FS −2d — lead (overlap)',       syntax: '5FS -2d' },
  { type: 'SS', lag:  0, label: 'SS — Start to Start',           syntax: '5SS' },
  { type: 'SS', lag:  2, label: 'SS +2d — succ starts later',    syntax: '5SS +2d' },
  { type: 'SS', lag: -2, label: 'SS −2d — succ starts earlier',  syntax: '5SS -2d' },
  { type: 'FF', lag:  0, label: 'FF — Finish to Finish',         syntax: '5FF' },
  { type: 'FF', lag:  2, label: 'FF +2d',                        syntax: '5FF +2d' },
  { type: 'FF', lag: -2, label: 'FF −2d',                        syntax: '5FF -2d' },
  { type: 'SF', lag:  0, label: 'SF — Start to Finish',          syntax: '5SF' },
  { type: 'SF', lag:  2, label: 'SF +2d',                        syntax: '5SF +2d' },
  { type: 'SF', lag: -2, label: 'SF −2d',                        syntax: '5SF -2d' },
];
const ARROW_DEMO_SCENARIOS_MS = [
  { type: 'FS', lag: 0, predMs: false, succMs: true,  label: 'Bar → Milestone (FS)',        syntax: '5' },
  { type: 'FS', lag: 0, predMs: true,  succMs: false, label: 'Milestone → Bar (FS)',        syntax: '5' },
  { type: 'FS', lag: 0, predMs: true,  succMs: true,  label: 'Milestone → Milestone (FS)',  syntax: '5' },
  { type: 'SS', lag: 0, predMs: true,  succMs: false, label: 'Milestone → Bar (SS)',        syntax: '5SS' },
  { type: 'FF', lag: 0, predMs: false, succMs: true,  label: 'Bar → Milestone (FF)',        syntax: '5FF' },
  { type: 'FS', lag: 2, predMs: true,  succMs: true,  label: 'Milestone → Milestone +2d',   syntax: '5FS +2d' },
];

const ARROW_DEMO_OPTS = {
  barW: 90,
  barH: 18,
  rowGap: 38,
  pxPerDay: 8,
  topY: 18,
  arrowColor: '#334155',
  arrowStroke: 1.4,
  msLabelStyle: 'right-pill',
};

function makeDemoBars(scenario) {
  const { barW, pxPerDay, topY, rowGap, barH } = ARROW_DEMO_OPTS;
  const predX = 60;
  const lagPx = (scenario.lag || 0) * pxPerDay;
  let succX;
  if (scenario.type === 'FS')      succX = predX + barW + lagPx;
  else if (scenario.type === 'SS') succX = predX + lagPx;
  else if (scenario.type === 'FF') succX = predX + lagPx;
  else                              succX = predX - barW + lagPx; // SF: succ ends at pred start (+lag)
  const predY = topY;
  const succY = topY + rowGap;

  const pred = {
    x: predX, y: predY, w: barW, h: barH,
    milestone: !!scenario.predMs,
    label: 'Predecessor',
  };
  const succ = {
    x: succX, y: succY, w: barW, h: barH,
    milestone: !!scenario.succMs,
    label: 'Successor',
  };

  // For milestones: x/w refer to the diamond's bounding box (a square centered on the row).
  // The diamond has half-width = h * 0.425. Convert from "bar where diamond would be" to diamond bounds.
  if (pred.milestone) {
    const cx = predX + barW / 2;
    const r = barH * 0.425;
    pred.cx = cx; pred.cy = predY + barH / 2;
    pred.x = cx - r; pred.w = 2 * r;
  }
  if (succ.milestone) {
    const cx = succX + barW / 2;
    const r = barH * 0.425;
    succ.cx = cx; succ.cy = succY + barH / 2;
    succ.x = cx - r; succ.w = 2 * r;
  }
  return { pred, succ };
}

function renderDemoSvg(svg, scenario) {
  const { arrowColor, arrowStroke, msLabelStyle, barH } = ARROW_DEMO_OPTS;
  const { pred, succ } = makeDemoBars(scenario);
  // Compute viewBox to fit pred+succ+labels (extra room on both sides for SS detours / pill labels)
  const minX = Math.min(pred.x, succ.x) - 50;
  const maxX = Math.max(pred.x + pred.w, succ.x + succ.w) + 150;
  const vbW = Math.max(320, maxX - minX);
  const vbH = 96;
  svg.setAttribute('viewBox', `${minX} 0 ${vbW} ${vbH}`);
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Row guides
  for (const row of [pred, succ]) {
    const g = document.createElementNS(SVG_NS, 'line');
    g.setAttribute('x1', minX); g.setAttribute('x2', minX + vbW);
    g.setAttribute('y1', row.y + row.h / 2); g.setAttribute('y2', row.y + row.h / 2);
    g.setAttribute('class', 'demo-row-guide');
    svg.appendChild(g);
  }

  // Bars first (under the arrow), then arrow, then milestone labels (on top of arrow).
  drawDemoTaskBody(svg, pred, 'a');
  drawDemoTaskBody(svg, succ, 'b');

  const { linePath, headPath } = computeArrowPath(pred, succ, scenario.type);
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('d', linePath);
  line.setAttribute('class', 'demo-arrow-line');
  line.setAttribute('stroke', arrowColor);
  line.setAttribute('stroke-width', String(arrowStroke));
  svg.appendChild(line);
  const head = document.createElementNS(SVG_NS, 'path');
  head.setAttribute('d', headPath);
  head.setAttribute('fill', arrowColor);
  svg.appendChild(head);

  // Milestone labels on top of arrow line
  drawDemoTaskLabel(svg, pred, msLabelStyle);
  drawDemoTaskLabel(svg, succ, msLabelStyle);
}

function drawDemoTaskBody(svg, task, variant) {
  if (task.milestone) {
    const cx = task.cx, cy = task.cy;
    const r = task.h * 0.425;
    const d = document.createElementNS(SVG_NS, 'polygon');
    d.setAttribute('points', `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`);
    d.setAttribute('class', 'demo-diamond');
    svg.appendChild(d);
  } else {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', task.x);
    rect.setAttribute('y', task.y);
    rect.setAttribute('width', task.w);
    rect.setAttribute('height', task.h);
    rect.setAttribute('rx', 3);
    rect.setAttribute('class', 'demo-bar' + (variant === 'b' ? ' b' : ''));
    svg.appendChild(rect);
    // Bar labels are inside the bar — drawn here with the body, not on top of arrows.
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', task.x + task.w / 2);
    label.setAttribute('y', task.y + task.h / 2);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'demo-bar-label');
    label.textContent = task.label;
    svg.appendChild(label);
  }
}

function drawDemoTaskLabel(svg, task, msLabelStyle) {
  if (!task.milestone) return; // bar labels handled in drawDemoTaskBody
  const cx = task.cx, cy = task.cy;
  const r = task.h * 0.425;
  const text = task.label;
  const padX = 6;
  const glyph = 6.4;
  const lblW = Math.round(text.length * glyph + padX * 2);
  const lblH = 16;

  let lx, ly, anchor;
  if (msLabelStyle === 'right' || msLabelStyle === 'right-pill') {
    lx = cx + r + 4; ly = cy; anchor = 'start';
  } else if (msLabelStyle === 'below') {
    lx = cx; ly = cy + r + 9; anchor = 'middle';
  } else { // above
    lx = cx; ly = cy - r - 6; anchor = 'middle';
  }

  if (msLabelStyle === 'right-pill' || msLabelStyle === 'below' || msLabelStyle === 'above') {
    const pill = document.createElementNS(SVG_NS, 'rect');
    const px = anchor === 'middle' ? lx - lblW / 2 : lx;
    pill.setAttribute('x', px);
    pill.setAttribute('y', ly - lblH / 2);
    pill.setAttribute('width', lblW);
    pill.setAttribute('height', lblH);
    pill.setAttribute('rx', 4);
    pill.setAttribute('class', 'demo-pill');
    svg.appendChild(pill);
  }
  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('class', 'demo-bar-label');
  label.setAttribute('x', anchor === 'start' ? lx + padX : lx);
  label.setAttribute('y', ly);
  label.setAttribute('text-anchor', anchor);
  label.setAttribute('dominant-baseline', 'middle');
  label.textContent = text;
  svg.appendChild(label);
}

function renderArrowReference() {
  const barGrid = document.getElementById('arrow-demo-bar-grid');
  const msGrid  = document.getElementById('arrow-demo-ms-grid');
  if (!barGrid || !msGrid) return;
  barGrid.innerHTML = ARROW_DEMO_SCENARIOS_BAR.map((s, i) => `
    <div class="arrow-demo-card">
      <div class="arrow-demo-title">${escapeHtml(s.label)}</div>
      <svg class="arrow-demo-svg" data-bar-i="${i}" preserveAspectRatio="xMidYMid meet"></svg>
      <div class="arrow-demo-syntax">Pred: <code>${escapeHtml(s.syntax)}</code></div>
    </div>`).join('');
  msGrid.innerHTML = ARROW_DEMO_SCENARIOS_MS.map((s, i) => `
    <div class="arrow-demo-card">
      <div class="arrow-demo-title">${escapeHtml(s.label)}</div>
      <svg class="arrow-demo-svg" data-ms-i="${i}" preserveAspectRatio="xMidYMid meet"></svg>
      <div class="arrow-demo-syntax">Pred: <code>${escapeHtml(s.syntax)}</code></div>
    </div>`).join('');

  redrawArrowReference();

  // Wire control changes once
  const sel = document.getElementById('ms-label-style');
  const colorInput = document.getElementById('arrow-color-pick');
  const strokeSel = document.getElementById('arrow-stroke-pick');
  if (sel && !sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => { ARROW_DEMO_OPTS.msLabelStyle = sel.value; redrawArrowReference(); });
  }
  if (colorInput && !colorInput.dataset.bound) {
    colorInput.dataset.bound = '1';
    colorInput.addEventListener('input', () => { ARROW_DEMO_OPTS.arrowColor = colorInput.value; redrawArrowReference(); });
  }
  if (strokeSel && !strokeSel.dataset.bound) {
    strokeSel.dataset.bound = '1';
    strokeSel.addEventListener('change', () => { ARROW_DEMO_OPTS.arrowStroke = parseFloat(strokeSel.value); redrawArrowReference(); });
  }
}

function redrawArrowReference() {
  document.querySelectorAll('.arrow-demo-svg[data-bar-i]').forEach(svg => {
    const i = +svg.dataset.barI;
    renderDemoSvg(svg, ARROW_DEMO_SCENARIOS_BAR[i]);
  });
  document.querySelectorAll('.arrow-demo-svg[data-ms-i]').forEach(svg => {
    const i = +svg.dataset.msI;
    renderDemoSvg(svg, ARROW_DEMO_SCENARIOS_MS[i]);
  });
}

function bindSetupHandlers() {
  // (Row-height handlers moved to the schedule toolbar — see the btn-row-h-up/down
  // wiring in init. Setup no longer owns this control.)

  // Palette row edits
  document.getElementById('palette-list').oninput = (e) => {
    const row = e.target.closest('.palette-row');
    if (!row) return;
    const i = +row.dataset.i;
    const field = e.target.dataset.field;
    const item = state.setupDraft.brand_palette[i];
    if (field === 'hex') {
      item.hex = e.target.value;
      row.querySelector('[data-field="hex-text"]').value = e.target.value.toUpperCase();
    } else if (field === 'hex-text') {
      const v = normalizeHex(e.target.value);
      if (v) {
        item.hex = v;
        row.querySelector('[data-field="hex"]').value = v;
      }
    } else if (field === 'name') {
      item.name = e.target.value;
    }
  };
  document.getElementById('palette-list').onclick = (e) => {
    if (e.target.dataset.action === 'remove-color') {
      const row = e.target.closest('.palette-row');
      const i = +row.dataset.i;
      state.setupDraft.brand_palette.splice(i, 1);
      renderSetup();
    }
  };

  // Theme edits
  for (const key of ['primary', 'dark', 'accent']) {
    document.getElementById(`theme-${key}`).oninput = (e) => {
      state.setupDraft.theme[key] = e.target.value;
      document.getElementById(`theme-${key}-hex`).value = e.target.value.toUpperCase();
    };
    document.getElementById(`theme-${key}-hex`).oninput = (e) => {
      const v = normalizeHex(e.target.value);
      if (v) {
        state.setupDraft.theme[key] = v;
        document.getElementById(`theme-${key}`).value = v;
      }
    };
  }

  // Section color edits — live-apply so the user sees the change in the Schedule grid as
  // soon as they pick. Persisted on save.
  for (const key of ['design_build', 'machine_testing', 'teardown_install']) {
    const dash = key.replace(/_/g, '-');
    document.getElementById(`section-${dash}`).oninput = (e) => {
      state.setupDraft.section_colors[key] = e.target.value;
      document.getElementById(`section-${dash}-hex`).value = e.target.value.toUpperCase();
      applySectionColors(state.setupDraft.section_colors);
    };
    document.getElementById(`section-${dash}-hex`).oninput = (e) => {
      const v = normalizeHex(e.target.value);
      if (v) {
        state.setupDraft.section_colors[key] = v;
        document.getElementById(`section-${dash}`).value = v;
        applySectionColors(state.setupDraft.section_colors);
      }
    };
  }

  // Anchor color edits — live-apply so anchor diamonds + grid rows update as you pick.
  for (const k of ['fill', 'text']) {
    document.getElementById(`anchor-${k}`).oninput = (e) => {
      state.setupDraft.anchor_color[k] = e.target.value;
      document.getElementById(`anchor-${k}-hex`).value = e.target.value.toUpperCase();
      applyAnchorColor(state.setupDraft.anchor_color);
      // Re-render the Gantt so the diamond fill picks up the new color (CSS variables
      // alone don't reach into the SVG attributes we set on each diamond).
      renderGantt();
    };
    document.getElementById(`anchor-${k}-hex`).oninput = (e) => {
      const v = normalizeHex(e.target.value);
      if (!v) return;
      state.setupDraft.anchor_color[k] = v;
      document.getElementById(`anchor-${k}`).value = v;
      applyAnchorColor(state.setupDraft.anchor_color);
      renderGantt();
    };
  }

  // % complete pill colors — one picker per state. Live-apply via CSS custom
  // properties so the grid's pills repaint instantly without a re-render.
  for (const k of PCT_COLOR_KEYS) {
    document.getElementById(`pct-${k}-fill`).oninput = (e) => {
      state.setupDraft.pct_colors[k] = e.target.value;
      document.getElementById(`pct-${k}-fill-hex`).value = e.target.value.toUpperCase();
      applyPctColors(state.setupDraft.pct_colors);
    };
    document.getElementById(`pct-${k}-fill-hex`).oninput = (e) => {
      const v = normalizeHex(e.target.value);
      if (!v) return;
      state.setupDraft.pct_colors[k] = v;
      document.getElementById(`pct-${k}-fill`).value = v;
      applyPctColors(state.setupDraft.pct_colors);
    };
  }

  // Hierarchy color edits — live-apply so the user can preview both the Gantt bars and
  // the grid header pills as they pick.
  document.getElementById('hierarchy-colors-list').oninput = (e) => {
    const row = e.target.closest('tr[data-key]');
    if (!row) return;
    const k = row.dataset.key;
    const field = e.target.dataset.field;
    const entry = state.setupDraft.hierarchy_colors[k];
    if (field === 'fill') {
      entry.fill = e.target.value;
      row.querySelector('[data-field="fill-hex"]').value = e.target.value.toUpperCase();
    } else if (field === 'fill-hex') {
      const v = normalizeHex(e.target.value);
      if (!v) return;
      entry.fill = v;
      row.querySelector('[data-field="fill"]').value = v;
    } else if (field === 'text') {
      entry.text = e.target.value;
      row.querySelector('[data-field="text-hex"]').value = e.target.value.toUpperCase();
    } else if (field === 'text-hex') {
      const v = normalizeHex(e.target.value);
      if (!v) return;
      entry.text = v;
      row.querySelector('[data-field="text"]').value = v;
    } else {
      return;
    }
    // Update preview chip + apply live to the rest of the app.
    const chip = row.querySelector('.preview-cell .phase-chip');
    chip.style.background = entry.fill;
    chip.style.color = entry.text;
    applyHierarchyColors(state.setupDraft.hierarchy_colors);
  };

  // Phase edits
  document.getElementById('phases-list').oninput = (e) => {
    const row = e.target.closest('tr[data-i]');
    if (!row) return;
    const i = +row.dataset.i;
    const field = e.target.dataset.field;
    const p = state.setupDraft.phases[i];
    if (field === 'label')   p.label = e.target.value;
    else if (field === 'key') p.key = e.target.value.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    else if (field === 'color')      { p.color = e.target.value; row.querySelector('[data-field="color-text"]').value = e.target.value.toUpperCase(); }
    else if (field === 'color-text') { const v = normalizeHex(e.target.value); if (v) { p.color = v; row.querySelector('[data-field="color"]').value = v; } }
    else if (field === 'text')       { p.text = e.target.value; row.querySelector('[data-field="text-text"]').value = e.target.value.toUpperCase(); }
    else if (field === 'text-text')  { const v = normalizeHex(e.target.value); if (v) { p.text = v; row.querySelector('[data-field="text"]').value = v; } }
    // Update preview chip
    const chip = row.querySelector('.preview-cell .phase-chip');
    chip.style.background = p.color;
    chip.style.color = p.text;
    chip.textContent = p.label;
  };
  document.getElementById('phases-list').onclick = (e) => {
    if (e.target.dataset.action === 'remove-phase') {
      const row = e.target.closest('tr[data-i]');
      const i = +row.dataset.i;
      const p = state.setupDraft.phases[i];
      const used = state.tasks.filter(t => t.phase === p.key).length;
      const ok = used === 0 || confirm(`${used} task(s) currently use the "${p.label}" phase. Remove anyway? Their phase will become blank.`);
      if (!ok) return;
      state.setupDraft.phases.splice(i, 1);
      renderSetup();
    }
  };

  // Default Financial Milestones edits — applied to new projects on first use.
  const finList = document.getElementById('default-financials-list');
  if (finList) {
    finList.oninput = finList.onchange = (e) => {
      const row = e.target.closest('tr[data-i]');
      if (!row) return;
      const i = +row.dataset.i;
      const field = e.target.dataset.field;
      const entry = state.setupDraft.default_financial_milestones[i];
      if (!entry) return;
      if (field === 'name')                entry.name = e.target.value;
      else if (field === 'percent')        entry.percent = e.target.value === '' ? null : Number(e.target.value);
      else if (field === 'sync_to_anchor') entry.sync_to_anchor = e.target.value || null;
    };
    finList.onclick = (e) => {
      if (e.target.dataset.action === 'remove-default-financial') {
        const i = +e.target.closest('tr[data-i]').dataset.i;
        state.setupDraft.default_financial_milestones.splice(i, 1);
        renderSetup();
      }
    };
    const addBtn = document.getElementById('btn-add-default-financial');
    if (addBtn && !addBtn.dataset.bound) {
      addBtn.dataset.bound = '1';
      addBtn.addEventListener('click', () => {
        state.setupDraft.default_financial_milestones.push({ name: '', percent: null, sync_to_anchor: null });
        renderSetup();
      });
    }
  }

  // Project Milestone Library edits — quick-pick suggestions for in-flow milestones.
  const libList = document.getElementById('milestone-library-list');
  if (libList) {
    libList.oninput = libList.onchange = (e) => {
      const row = e.target.closest('tr[data-i]');
      if (!row) return;
      const i = +row.dataset.i;
      const field = e.target.dataset.field;
      const entry = state.setupDraft.project_milestone_library[i];
      if (!entry) return;
      if (field === 'name')                  entry.name = e.target.value;
      else if (field === 'suggested_section') { entry.suggested_section = e.target.value || null; entry.suggested_dept = null; renderSetup(); return; }
      else if (field === 'suggested_dept')    entry.suggested_dept = e.target.value || null;
    };
    libList.onclick = (e) => {
      if (e.target.dataset.action === 'remove-milestone-template') {
        const i = +e.target.closest('tr[data-i]').dataset.i;
        state.setupDraft.project_milestone_library.splice(i, 1);
        renderSetup();
      }
    };
    const addBtn = document.getElementById('btn-add-milestone-template');
    if (addBtn && !addBtn.dataset.bound) {
      addBtn.dataset.bound = '1';
      addBtn.addEventListener('click', () => {
        state.setupDraft.project_milestone_library.push({ name: '', suggested_section: null, suggested_dept: null, suggested_sub: null });
        renderSetup();
      });
    }
  }
}

function normalizeHex(v) {
  v = v.trim().toLowerCase();
  if (!v.startsWith('#')) v = '#' + v;
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

async function saveSetup() {
  const status = document.getElementById('setup-status');
  status.textContent = 'Saving…';
  try {
    await Promise.all([
      api.putSetting('brand_palette',     state.setupDraft.brand_palette),
      api.putSetting('theme',             state.setupDraft.theme),
      api.putSetting('phases',            state.setupDraft.phases),
      api.putSetting('section_colors',    state.setupDraft.section_colors),
      api.putSetting('hierarchy_colors',  state.setupDraft.hierarchy_colors),
      api.putSetting('anchor_color',      state.setupDraft.anchor_color),
      api.putSetting('pct_colors',        state.setupDraft.pct_colors || PCT_COLOR_DEFAULTS),
      api.putSetting('default_financial_milestones', state.setupDraft.default_financial_milestones || []),
      api.putSetting('project_milestone_library',    state.setupDraft.project_milestone_library || []),
    ]);
    status.textContent = 'Saved. Reloading…';
    setTimeout(() => location.reload(), 250);
  } catch (err) {
    status.textContent = 'Save failed — see console.';
    console.error(err);
  }
}

function discardSetup() {
  state.setupDraft = null;
  renderSetup();
}

// ---------- Data ----------
// Anchor milestones — hard-coded project-spine markers. Five of them, in order:
//   - Receipt of PO     → kicks the project off (above section 10 in the grid)
//   - Mech 1 Release    → inside section 10 → Engineering → Mechanical. Gates the
//                         shop's ability to start building — a key plan-of-record
//                         date for everyone downstream.
//   - Machine Power-Up  → inside section 10 → Shop → Wire (END of wire work — the
//                         moment the panel turns on).
//   - FAT               → end of section 40 (gates teardown)
//   - Ship Machine      → between teardown and install inside section 50
// Auto-created per project; can't be deleted. They render as concentric diamonds
// in the anchor color. Mech 1 and Machine Power-Up live WITHIN regular hierarchy
// buckets — the others sit above or between sections as standalone rows.
const ANCHOR_DEFS = [
  { key: 'receipt_of_po',    name: 'Receipt of PO',    defaultOffsetDays: 0  },
  { key: 'mech_release_1',   name: 'Mech 1 Release',   defaultOffsetDays: 20,
    phaseGroup: 'design_build', department: 'engineering', subDepartment: 'mech' },
  { key: 'machine_power_up', name: 'Machine Power-Up', defaultOffsetDays: 45,
    phaseGroup: 'design_build', department: 'shop', subDepartment: 'wire' },
  { key: 'fat',              name: 'FAT',              defaultOffsetDays: 60 },
  { key: 'ship_machine',     name: 'Ship Machine',     defaultOffsetDays: 75 },
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function offsetISO(days) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Match an existing task to an anchor by either anchor_key (when the column has been
// populated) OR by name (fallback for tasks created before the column existed).
function inferredAnchorKey(t) {
  if (t.anchor_key) return t.anchor_key;
  const n = String(t.name || '').trim().toLowerCase();
  if (n === 'receipt of po')                              return 'receipt_of_po';
  if (n === 'mech 1 release' || n === 'mech release 1' || n === 'mech1 release') return 'mech_release_1';
  if (n === 'machine power-up' || n === 'machine powerup' || n === 'machine power up') return 'machine_power_up';
  if (n === 'fat')                                        return 'fat';
  if (n === 'ship machine')                               return 'ship_machine';
  return null;
}

// Backlog is a "duration milestone" — a project-spine task with real calendar
// duration but no work content (allocation 0). Lives above section 10 with the
// PO anchor. Detected by anchor_key='backlog' (or name fallback for legacy
// rows). No % complete pill, no drift chip, no allocation pill.
function isBacklogTask(t) {
  if (!t) return false;
  // v4.69: also match on anchor_key='backlog' — the server's estimate-create
  // INSERT was supposed to stamp it but the actual SQL leaves anchor_key
  // NULL (legacy oversight). Either signal counts now, so a Backlog row
  // shows in the special spine slot even if its phase_group got set or its
  // name was tweaked. Detection order:
  //   1. anchor_key === 'backlog'
  //   2. name === 'backlog' AND phase_group is null
  if (String(t.anchor_key || '').toLowerCase() === 'backlog') return true;
  return String(t.name || '').trim().toLowerCase() === 'backlog' && !t.phase_group;
}

// Make sure each open project has a Receipt of PO + FAT anchor task. Anchors are real
// rows in the tasks table — flagged with anchor_key — so they participate in
// scheduling, predecessors, and the Gantt like any other milestone. Critically, this
// matches by NAME as well as by anchor_key so we don't create duplicates if the API
// didn't accept anchor_key on a previous run (e.g. server hadn't been restarted).
async function ensureAnchorsForProject(project) {
  if (!project) return;
  const have = new Set(state.tasks
    .filter(t => t.project === project)
    .map(inferredAnchorKey)
    .filter(Boolean));
  let created = false;
  for (const a of ANCHOR_DEFS) {
    if (have.has(a.key)) continue;
    const date = a.defaultOffsetDays === 0 ? todayISO() : offsetISO(a.defaultOffsetDays);
    await api.create({
      name: a.name,
      project,
      anchor_key: a.key,
      is_milestone: true,
      start_date: date,
      end_date: date,
      // Machine Power-Up sits inside section 10 → Shop → Wire so it flows with the
      // wire team's work. Other anchors stay free-floating (rendered specially).
      phase_group:    a.phaseGroup    || null,
      department:     a.department    || null,
      sub_department: a.subDepartment || null,
    });
    created = true;
  }
  // v4.69: also ensure a Backlog row exists. The estimate-create flow stamps
  // one, but template projects (and any project where the user deleted the
  // backlog) end up without it — and the user expects to see Backlog right
  // under Receipt of PO. Default duration: 10 business days = 2 weeks,
  // matching the estimate-create default. Allocation 0 (no real work).
  const hasBacklog = state.tasks.some(t => t.project === project && isBacklogTask(t));
  if (!hasBacklog) {
    const po = state.tasks.find(t => t.project === project && inferredAnchorKey(t) === 'receipt_of_po');
    if (po && po.start_date) {
      await api.create({
        name: 'Backlog',
        project,
        anchor_key: 'backlog',
        is_milestone: false,
        phase_group: null,
        department: null,
        sub_department: null,
        duration_days: 10,
        progress: 0,
        allocation: 0,
        start_date: po.start_date,
        end_date: po.start_date,           // server cascade will set end from duration_days
        predecessors: `${po.id}FS`,
      });
      created = true;
    }
  }
  return created;
}

// De-duplicate anchor milestones (Receipt of PO, FAT) at the data layer so EVERY
// downstream consumer — grid, Gantt, predecessor parsing, over-allocation — sees
// exactly ONE of each. The DB may still have duplicates until the server-side dedup
// migration runs (requires a server restart); this hides them everywhere in the UI.
// Normalize the raw task list: dedup anchor milestones (Receipt of PO / FAT / Ship
// Machine), and remap legacy phase_group / department values left over from earlier
// restructures so the rest of the app sees clean, current-shape data even before the
// server is restarted (which is when the persistent SQL migrations actually run).
function dedupAnchors(all) {
  // Dedup PER PROJECT — anchors are scoped to a project, so an "older" anchor in
  // a different project doesn't outrank a fresh import in this one. Previously
  // this was global, which meant imported projects lost their Receipt of PO / FAT
  // / Ship Machine to the template's older anchors and showed up empty in the UI.
  const oldest = {}; // key = `${project}::${anchor_key}` → lowest id
  for (const t of all) {
    const k = inferredAnchorKey(t);
    if (!k) continue;
    const scope = `${t.project || ''}::${k}`;
    if (!(scope in oldest) || t.id < oldest[scope]) oldest[scope] = t.id;
  }
  return all
    .filter(t => {
      const k = inferredAnchorKey(t);
      if (!k) return true;
      return t.id === oldest[`${t.project || ''}::${k}`];
    })
    .map(t => {
      // Legacy section-50 split ('teardown' or 'install' as their own phase_group)
      // is now reunified under 'teardown_install'. Pull those rows back into shape
      // so they render in the right section without waiting on a server restart.
      if (t.phase_group === 'teardown') {
        return { ...t, phase_group: 'teardown_install', department: t.department || 'teardown' };
      }
      if (t.phase_group === 'install') {
        return { ...t, phase_group: 'teardown_install', department: t.department || 'install' };
      }
      // Section 50 INSTALL has engineering/shop as SUB-departments, not departments.
      // Wrap legacy rows that still have department='engineering' or 'shop' directly
      // under teardown_install (no sub-dept) into install/<engineering|shop>.
      if (t.phase_group === 'teardown_install'
          && (t.department === 'engineering' || t.department === 'shop')
          && !t.sub_department) {
        return { ...t, sub_department: t.department, department: 'install' };
      }
      // Section 50 tasks with no department default to TEARDOWN. Without this they
      // bucket at the section level (right under "50 TEARDOWN & INSTALL" with no
      // indent) which looks orphaned next to the proper TEARDOWN/INSTALL grouping.
      if (t.phase_group === 'teardown_install' && !t.department) {
        return { ...t, department: 'teardown' };
      }
      return t;
    });
}

async function loadTasks() {
  // Pull the raw list first so ensureAnchorsForProject sees ANY duplicates and skips
  // creation. After backfill we collapse duplicates at the data layer.
  let raw = await api.list();
  state.tasks = raw;
  // Backfill anchors for every project that doesn't yet have them. Runs once per page
  // load — subsequent loads see the rows (or a duplicate row) and skip.
  const projects = uniqueValues('project');
  let backfilled = false;
  for (const p of projects) {
    if (await ensureAnchorsForProject(p)) backfilled = true;
  }
  if (backfilled) raw = await api.list();
  state.tasks = dedupAnchors(raw);
  state.overAllocatedTaskIds = computeOverAllocatedTasks(state.tasks);
  // Hydrate project tabs the first time we get tasks so they include any pre-existing
  // projects the user already had data for. Subsequent loads are a no-op (saved tabs win).
  if (!state._tabsHydrated) {
    loadProjectTabs();
    state._tabsHydrated = true;
  }
  // Refresh financial milestones for projects whose data we already cached. The
  // overlay renders from state.financials, so this keeps it current with the latest
  // anchor dates after every task save (FAT moves → "Acceptance at SDC" follows).
  if (state.showFinancials) {
    await loadFinancialsForAllOpenProjects();
  }
  render();
}

// Walk each assignee's tasks in priority order, building a day → cumulative-alloc map.
// A task is "over-allocated" if its allocation, ADDED on top of higher-priority tasks
// already on the books, would push the day total over 100% anywhere in its span.
// This is what drives the bold-red assignee cell in the Schedule grid: priority 1 tasks
// always fit, priority N tasks only fit if priorities 1..N-1 left enough headroom.
function computeOverAllocatedTasks(tasks) {
  const flagged = new Set();
  const byAssignee = {};
  for (const t of tasks) {
    if (!t.assignee || !t.start_date || !t.end_date || t.is_milestone) continue;
    // Placeholders aren't real people — they're role-stand-ins on templates. A
    // placeholder showing up on every task in a section is expected (that's its job)
    // and shouldn't paint everything red.
    if (isPlaceholder(t.assignee)) continue;
    const a = t.allocation == null ? 90 : Number(t.allocation);
    if (!a || a <= 0) continue;
    (byAssignee[t.assignee] ||= []).push(t);
  }
  for (const list of Object.values(byAssignee)) {
    // Sort by priority asc, then id asc as a stable tiebreaker so two priority-1 tasks
    // get a deterministic walk order.
    list.sort((x, y) => (x.priority || 1) - (y.priority || 1) || x.id - y.id);
    const allocByDay = new Map();
    for (const t of list) {
      const a = t.allocation == null ? 90 : Number(t.allocation);
      const startMs = new Date(t.start_date + 'T00:00:00Z').getTime();
      const endMs   = new Date(t.end_date   + 'T00:00:00Z').getTime();
      let pushesOver = false;
      for (let d = startMs; d <= endMs; d += 86400000) {
        if ((allocByDay.get(d) || 0) + a > 100) { pushesOver = true; break; }
      }
      if (pushesOver) flagged.add(t.id);
      // Always book this task into the running map — even if it pushes over, we still
      // count it for downstream priorities so they see the realistic load.
      for (let d = startMs; d <= endMs; d += 86400000) {
        allocByDay.set(d, (allocByDay.get(d) || 0) + a);
      }
    }
  }
  return flagged;
}
async function loadTeam() {
  state.team = await api.team.list();
  // Re-render whichever view depends on the team list. The Schedule grid only renders
  // assignee names (any string), but the Team tab and Resources tab both need a fresh
  // list, and the Schedule grid's inline-edit dropdown reads state.team at click time
  // anyway — so we just re-render the active view.
  render();
}

// ---------- Wiring ----------
function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  // Update the legacy .tab buttons (if any still exist) and the sidebar
  // icons — both share the data-view attribute, so a single CSS active
  // class works for both. .tab was the old topbar nav, replaced in v4.11
  // by the sidebar, but the selector is harmless if no .tab elements
  // remain in the DOM.
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.app-sidebar-icon[data-view]').forEach(t => t.classList.toggle('is-active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'setup') renderSetup();
  else if (view === 'team') renderTeam();
  else if (view === 'projects')  renderProjectsPage();
  else if (view === 'favorites') renderFavoritesPage();
  else if (view === 'recents')   renderRecentsPage();
  else if (view === 'actions')   renderActionsPage();
  else render();
}

// Sync vertical scroll between grid and gantt so rows always line up.
function setupScrollSync() {
  const grid = document.getElementById('schedule-grid');
  const gantt = document.getElementById('schedule-gantt');
  if (!grid || !gantt) return;
  let lock = false;
  grid.addEventListener('scroll', () => {
    if (lock) return;
    lock = true;
    gantt.scrollTop = grid.scrollTop;
    requestAnimationFrame(() => { lock = false; });
  });
  gantt.addEventListener('scroll', () => {
    if (lock) return;
    lock = true;
    grid.scrollTop = gantt.scrollTop;
    requestAnimationFrame(() => { lock = false; });
  });
}

// ---------- Layout (grid width, column widths, gantt visible) ----------
const DEFAULT_COL_WIDTHS = { line: 36, id: 50, name: 340, assignee: 110, start: 90, finish: 90, duration: 80, pred: 110, progress: 110, allocation: 52, priority: 44, notes: 200 };
// Per-column hard floors used by the resize handle. Line column is tight enough that
// you can't drag below "the number is still legible". Allocation only ever holds "100%"
// in the body and "ALLOC" in the header, so its floor is just-wider-than-the-header.
const COL_MIN_WIDTHS = { line: 30, name: 80, assignee: 60, start: 70, finish: 70, duration: 50, pred: 60, progress: 60, allocation: 44, priority: 36, notes: 100 };
const COLUMN_DEFS = [
  { key: 'line',     label: '#' },
  { key: 'name',     label: 'Task' },
  { key: 'assignee', label: 'Assigned To' },
  { key: 'priority', label: 'Pri' },
  { key: 'start',    label: 'Start' },
  { key: 'finish',   label: 'Finish' },
  { key: 'duration', label: 'Duration' },
  { key: 'pred',     label: 'Predecessors' },
  { key: 'allocation', label: 'Alloc' },
  { key: 'progress', label: '% Complete' },
  { key: 'notes',    label: 'Comments' },
];
// Columns we don't auto-show when introducing a column. The user can still toggle them
// on from the columns menu — they just don't appear by default for fresh installs and
// aren't force-shown for existing users on app load. Priority is hidden because the
// Resources view's pill is the primary editor. Progress / allocation / duration are
// hidden because they all live as click-to-edit pills inside the Task name column now
// (v4.27) — the dedicated columns are redundant and just eat horizontal space.
const DEFAULT_HIDDEN_COLS = new Set(['line', 'priority', 'progress', 'allocation', 'duration']);

// Bump LAYOUT_VERSION whenever we change a default column width that existing users have
// already cached in localStorage. The migration block below resets only the affected
// column so we don't blow away anything else they've customized.
const LAYOUT_VERSION = 6;

function loadLayout() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('sdcSchedulerLayout') || '{}'); } catch {}

  // Migration: tighten the Allocation column to its new compact default. Drops the saved
  // width so the merge below picks up DEFAULT_COL_WIDTHS.allocation instead.
  if ((saved.layoutVersion || 1) < 2) {
    if (saved.colWidths && 'allocation' in saved.colWidths) delete saved.colWidths.allocation;
  }
  // Migration v4: progress moved into the Task column as a click-to-edit pill.
  if ((saved.layoutVersion || 1) < 4) {
    if (Array.isArray(saved.visibleCols)) {
      saved.visibleCols = saved.visibleCols.filter(k => k !== 'progress');
    }
    if (saved.colWidths && (saved.colWidths.name || 0) < 320) {
      delete saved.colWidths.name;
    }
  }
  // Migration v5: bring allocation BACK as its own column (we'd briefly merged it
  // into the Task pill cluster in v4; turns out it's set-once-and-forget data that
  // doesn't belong next to the dynamic % complete chip).
  if ((saved.layoutVersion || 1) < 5) {
    if (Array.isArray(saved.visibleCols) && !saved.visibleCols.includes('allocation')) {
      saved.visibleCols.push('allocation');
    }
  }
  // Migration v6: hide allocation + duration columns by default. Both values
  // now live as click-to-edit pills inside the Task name column's meta row
  // (alloc · duration underneath the task name), so the dedicated columns
  // are redundant and just eat horizontal space. Users who want them back
  // can still toggle them on from the columns menu.
  if ((saved.layoutVersion || 1) < 6) {
    if (Array.isArray(saved.visibleCols)) {
      saved.visibleCols = saved.visibleCols.filter(k => k !== 'allocation' && k !== 'duration');
    }
  }

  const rh = Number(saved.rowHeight) || ROW_H_DEFAULT;
  // Default visible columns exclude `line` (#) — the row-number column doubles as a drag
  // handle but mostly adds clutter; users can re-enable it from the columns toggle when
  // they need predecessor numbers visible.
  const defaultVisible = COLUMN_DEFS.map(c => c.key).filter(k => k !== 'line');
  return {
    gridWidth: saved.gridWidth || 720,
    showGantt: saved.showGantt !== false,
    colWidths: { ...DEFAULT_COL_WIDTHS, ...(saved.colWidths || {}) },
    visibleCols: saved.visibleCols || defaultVisible,
    columnOrder: saved.columnOrder || COLUMN_DEFS.map(c => c.key),
    rowHeight: Math.max(ROW_H_MIN, Math.min(ROW_H_MAX, rh)),
    layoutVersion: LAYOUT_VERSION,
  };
}

function colClass(key) {
  return key === 'start' || key === 'finish' ? 'col-date' : `col-${key}`;
}

function renderHeaders() {
  const order = state.layout.columnOrder.filter(k => COLUMN_DEFS.find(d => d.key === k));
  // Slot new columns at their canonical position from COLUMN_DEFS, not at the end —
  // otherwise adding the line column on the left would push it to the end for existing users.
  for (let i = 0; i < COLUMN_DEFS.length; i++) {
    const key = COLUMN_DEFS[i].key;
    if (!order.includes(key)) order.splice(i, 0, key);
  }
  state.layout.columnOrder = order;
  // Auto-show newly introduced columns unless they're in the default-hidden set.
  for (const def of COLUMN_DEFS) {
    if (state.layout.visibleCols.includes(def.key)) continue;
    if (DEFAULT_HIDDEN_COLS.has(def.key)) continue;
    state.layout.visibleCols.push(def.key);
  }

  const colgroup = document.getElementById('tasks-colgroup');
  const theadRow = document.getElementById('tasks-thead-row');
  if (!colgroup || !theadRow) return;

  colgroup.innerHTML = order.map(k => `<col data-col="${k}" />`).join('');
  theadRow.innerHTML = order.map(k => {
    const def = COLUMN_DEFS.find(d => d.key === k);
    // v4.34: Task column header shows multi-label "ALOC | TASK | DUR | %COM"
    // matching the body cell layout. Since the body cell packs all four
    // pieces inline (alloc, name, dur, % pill), the header labels each
    // sub-region so the user can read which value is which.
    // v4.37: header mirrors the body cell's flex skeleton EXACTLY —
    // alloc + dash + task + dur + %com — so labels land directly above
    // their corresponding body values. The dash placeholder ensures the
    // TASK label sits where the body's task name does (the body has a
    // dash element between alloc and name).
    // v4.44: TASK banner on top (not bold — other column headers like
    // "ASSIGNED TO" aren't bold either). Below it the four sub-labels:
    // ALOC | DESCRIPTION | DUR | %COM. DESCRIPTION sits centered above
    // the body name area (matching TASK's range from left: 64 to right: 110).
    const labelHtml = (k === 'name')
      ? `<span class="th-label th-label-name">
           <span class="th-label-task">${escapeHtml(def.label).toUpperCase()}</span>
           <span class="th-label-alloc">ALOC</span>
           <span class="th-label-desc">DESCRIPTION</span>
           <span class="th-label-dur">DUR</span>
           <span class="th-label-pct">%COM</span>
         </span>`
      : `<span class="th-label">${escapeHtml(def.label)}</span>`;
    return `<th class="${colClass(k)}" data-col="${k}" draggable="true">
              ${labelHtml}<span class="col-resize-handle" draggable="false"></span>
            </th>`;
  }).join('');

  applyColWidths();
  applyColumnVisibility();
  setupColumnResize();
  setupColumnReorder();
}

function saveLayout() {
  localStorage.setItem('sdcSchedulerLayout', JSON.stringify(state.layout));
}

// ---------- Schedule view modes ----------
// Three independent toggles (flatten / sortByStart / ganttOnly) live on state and are
// persisted to localStorage. Each one is reversible — clicking the button again
// returns the schedule to the previous view.
const SCHED_VIEW_KEY = 'sdcSchedulerScheduleView';
function loadScheduleView() {
  try {
    const saved = JSON.parse(localStorage.getItem(SCHED_VIEW_KEY) || '{}');
    // showFinancials / showBaseline are persisted alongside the schedule-view
    // flags but live on state.show* (not state.scheduleView) since the overlays
    // aren't section-rendering modes — they're extra layers. Hydrate as side effects.
    state.showFinancials = !!saved.showFinancials;
    state.showBaseline   = !!saved.showBaseline;
    return {
      flatten:       !!saved.flatten,
      sortByStart:   !!saved.sortByStart,
      ganttOnly:     !!saved.ganttOnly,
      criticalPath:  !!saved.criticalPath,
      criticalOnly:  !!saved.criticalOnly,
      // Default ON when never saved before. Falsey-check would default to
      // OFF on first load, which would surprise users who saw the labels
      // in v3.52 and expect them on after upgrading.
      showArrowLags: saved.showArrowLags === undefined ? true : !!saved.showArrowLags,
      // Default OFF — opt-in feature, since it clutters the chart a bit. The
      // user enables it when they want to see allocation/duration at a glance
      // without having to read the grid.
      showBarMeta:   !!saved.showBarMeta,
      // v4.30: inline allocation prefix in the Task column ("85%  Task Name").
      // Defaults to ON since the user explicitly asked for it; the View pill's
      // α icon turns it off when presenting to a customer or anyone else
      // who shouldn't see the staffing percentages.
      showInlineAlloc: saved.showInlineAlloc === undefined ? true : !!saved.showInlineAlloc,
      // v4.46: 3-way toggle for action items rendering:
      //   'schedule' — only scheduled work (is_action = 0). Default.
      //   'combined' — schedule rows AND action rows. Actions sort to the
      //                bottom of their sub-dep bucket.
      //   'actions'  — only action items (is_action = 1).
      actionsMode: (['schedule', 'combined', 'actions'].includes(saved.actionsMode)
        ? saved.actionsMode
        : 'schedule'),
    };
  } catch {
    return { flatten: false, sortByStart: false, ganttOnly: false, criticalPath: false, criticalOnly: false, showArrowLags: true, showBarMeta: false, showInlineAlloc: true, actionsMode: 'schedule' };
  }
}
function saveScheduleView() {
  try {
    localStorage.setItem(SCHED_VIEW_KEY, JSON.stringify({
      ...state.scheduleView,
      showFinancials: state.showFinancials,
      showBaseline:   state.showBaseline,
    }));
  } catch {}
}
function applyScheduleView() {
  // Refresh the View pill in the toolbar so its three icons reflect the current
  // toggle state. Critical path stays in the Quick filters popover (renderFilters).
  syncViewPill();
  // The pane class (.gantt-only) on schedule-split is owned by applyGanttVisibility
  // — it knows about both showGantt and ganttOnly. Just delegate.
  applyGanttVisibility();
  // v4.30: body.hide-alloc-pre hides the inline "85% " prefix in the Task
  // column when the user turns the α View pill icon off. Pure CSS swap, no
  // re-render needed since the span is always in the DOM.
  document.body.classList.toggle('hide-alloc-pre', state.scheduleView && state.scheduleView.showInlineAlloc === false);
}

// Update the .is-active class on each View pill icon to match the current
// schedule-view state. Called whenever a toggle changes or the view re-renders.
// The flatten icon represents the COMBINED flatten + sortByStart toggle —
// active iff BOTH flags are on (so the icon doesn't look on when only half
// the linked pair is active, e.g. from settings persisted before v3.58).
function syncViewPill() {
  const setActive = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('is-active', !!on);
  };
  const sv = state.scheduleView || {};
  setActive('btn-view-flatten',    sv.flatten && sv.sortByStart);
  setActive('btn-view-alloc-pre',  sv.showInlineAlloc !== false);
  setActive('btn-view-financials', state.showFinancials);
  setActive('btn-view-lags',       sv.showArrowLags !== false);
  setActive('btn-view-bar-meta',   sv.showBarMeta);
}
function toggleScheduleView(key) {
  state.scheduleView[key] = !state.scheduleView[key];
  // Gantt-only forces the Gantt visible — otherwise turning it on while the Gantt is
  // hidden by the show-Gantt checkbox would leave the user with nothing on screen.
  if (key === 'ganttOnly' && state.scheduleView.ganttOnly && !state.layout.showGantt) {
    state.layout.showGantt = true;
    saveLayout();
    const cb = document.getElementById('toggle-show-gantt');
    if (cb) cb.checked = true;
    const splitForVisibility = document.getElementById('schedule-split');
    if (splitForVisibility) splitForVisibility.classList.remove('gantt-hidden');
  }
  saveScheduleView();
  applyScheduleView();
  render();
}

function applyColWidths() {
  let sum = 0;
  for (const [name, w] of Object.entries(state.layout.colWidths)) {
    const col = document.querySelector(`#tasks-table colgroup col[data-col="${name}"]`);
    if (col) col.style.width = w + 'px';
    if (state.layout.columnOrder.includes(name) && state.layout.visibleCols.includes(name)) sum += w;
  }
  // table-layout: fixed only honors col widths when the table has an explicit width.
  // Set total table width = sum of visible col widths so widths render exactly as configured.
  const table = document.getElementById('tasks-table');
  if (table) table.style.width = sum + 'px';
}

function applyGridWidth() {
  document.getElementById('schedule-grid').style.width = state.layout.gridWidth + 'px';
}

function applyRowHeight() {
  const rh = state.layout.rowHeight;
  document.documentElement.style.setProperty('--row-h', rh + 'px');
  const display = document.getElementById('row-height-display');
  if (display) display.textContent = rh;
  // v4.27: no more row-h-compact toggle. The Task column's stacked layout
  // (name + meta row) STAYS visible at every row height. Instead, the name
  // font scales down with --row-h via CSS clamp (see .name-cell-main) so
  // smaller rows just have smaller text. The meta row pills are already at
  // their minimum readable size (9px) and don't shrink further. ROW_H_MIN
  // bumped to fit the stacked content at the floor.
  document.body.classList.remove('row-h-compact');
}

// Bar height tracks row height. v4.23 bumped the ratio from 0.5 → 0.7 so the
// bar dominates each row visually (was leaving big empty bands above + below
// short bars in compact mode). Milestone diamonds — sized off bar_height
// (outer radius = h × 1.20 / 2 = h × 0.60) — still fit because the floor of
// 4px padding keeps adjacent rows from touching, and we don't allow padding
// below 4px even when row height is at the floor of 14px (14 × 0.7 = 9.8 →
// 10 bar, 4 padding). Text fit inside bars is handled separately in
// clipBarLabels by scaling font-size to barH.
function getGanttBarMetrics() {
  const rh = state.layout.rowHeight;
  // frappe-gantt total per-row = bar_height + padding, so we split rh between them.
  const bar_height = Math.max(BAR_H_MIN, Math.round(rh * 0.7));
  const padding = Math.max(4, rh - bar_height);
  return { bar_height, padding };
}

function setRowHeight(h) {
  const next = Math.max(ROW_H_MIN, Math.min(ROW_H_MAX, Math.round(h)));
  if (next === state.layout.rowHeight) return;
  state.layout.rowHeight = next;
  applyRowHeight();
  saveLayout();
  if (state.gantt) renderGantt();
}

function applyGanttVisibility() {
  const split = document.getElementById('schedule-split');
  if (!split) return;
  // Pane mode is derived from two underlying flags so existing keys persist:
  //   - layout.showGantt   = false → "grid" only
  //   - scheduleView.ganttOnly = true → "gantt" only
  //   - else → "both"
  const ganttOnly = !!state.scheduleView?.ganttOnly;
  const showGantt = state.layout.showGantt !== false;
  let pane = 'both';
  if (ganttOnly) pane = 'gantt';
  else if (!showGantt) pane = 'grid';
  split.classList.toggle('gantt-hidden', pane === 'grid');
  split.classList.toggle('gantt-only',  pane === 'gantt');
  // Sync segmented control active state.
  document.querySelectorAll('.seg-btn[data-pane]').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.pane === pane);
  });
}

function applyColumnVisibility() {
  const visible = new Set(state.layout.visibleCols);
  document.querySelectorAll('#tasks-table [data-col]').forEach(el => {
    el.classList.toggle('col-hidden', !visible.has(el.dataset.col));
  });
}

// Render the Show/hide columns dropdown. Two responsibilities:
//   1. Each row has a checkbox that toggles visibility (col-hidden class on
//      the matching <col>/<th>/<td> elements).
//   2. Each row has a drag-handle (⋮⋮) and is itself draggable. Reordering
//      rows inside the menu reorders state.layout.columnOrder, which the
//      grid headers + body + colgroup all read from on the next renderHeaders
//      / renderTable cycle.
// Rows render in current grid order (state.layout.columnOrder) so what you
// see in the menu top-to-bottom matches what's in the grid left-to-right.
function renderColumnsMenu() {
  const menu = document.getElementById('columns-menu');
  if (!menu) return;
  const visible = new Set(state.layout.visibleCols);
  // Use columnOrder for the row sequence; any COLUMN_DEFS entry not in
  // columnOrder appears after, so newly-added columns still show up.
  const orderedKeys = [
    ...state.layout.columnOrder.filter(k => COLUMN_DEFS.find(d => d.key === k)),
    ...COLUMN_DEFS.map(c => c.key).filter(k => !state.layout.columnOrder.includes(k)),
  ];
  menu.innerHTML = orderedKeys.map(key => {
    const def = COLUMN_DEFS.find(d => d.key === key);
    if (!def) return '';
    const isName = def.key === 'name';
    return `
      <div class="col-menu-row ${isName ? 'is-locked' : ''}" data-col="${def.key}" draggable="${!isName}" title="${isName ? 'Task column is always shown and always first — can\'t reorder or hide.' : 'Drag to reorder. Checkbox toggles visibility.'}">
        <span class="col-menu-drag">⋮⋮</span>
        <label class="col-menu-label">
          <input type="checkbox" data-col="${def.key}" ${visible.has(def.key) ? 'checked' : ''} ${isName ? 'disabled' : ''} />
          ${escapeHtml(def.label)}
        </label>
      </div>`;
  }).join('');

  // Visibility checkboxes — same behavior as before.
  menu.addEventListener('change', (e) => {
    if (e.target.matches('input[type="checkbox"]')) {
      const key = e.target.dataset.col;
      if (e.target.checked) {
        if (!state.layout.visibleCols.includes(key)) state.layout.visibleCols.push(key);
      } else {
        state.layout.visibleCols = state.layout.visibleCols.filter(k => k !== key);
      }
      applyColumnVisibility();
      saveLayout();
    }
  });

  // Drag-and-drop reordering. Mirrors setupColumnReorder() on the table
  // headers — same state.layout.columnOrder update, same renderHeaders +
  // renderTable refresh. After dropping, also re-render the menu so the
  // rows visually re-sort to match the new order.
  menu.querySelectorAll('.col-menu-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', row.dataset.col);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      menu.querySelectorAll('.col-menu-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const fromKey = e.dataTransfer.getData('text/plain');
      const toKey = row.dataset.col;
      if (!fromKey || fromKey === toKey) return;
      // The "name" column is locked at position 0 — refuse drops that would
      // move anything to its slot or move name itself.
      if (toKey === 'name' || fromKey === 'name') return;
      const order = [...state.layout.columnOrder];
      const fromIdx = order.indexOf(fromKey);
      if (fromIdx === -1) return;
      order.splice(fromIdx, 1);
      const toIdx = order.indexOf(toKey);
      order.splice(toIdx === -1 ? order.length : toIdx, 0, fromKey);
      state.layout.columnOrder = order;
      saveLayout();
      // Re-render grid (headers + colgroup + rows) and the menu rows.
      renderHeaders();
      renderTable();
      renderColumnsMenu();
    });
  });
}

function setupRowHeightHandle() {
  const handle = document.getElementById('row-height-bar');
  if (!handle) return;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const startY = e.clientY;
    const startH = state.layout.rowHeight;
    let pendingH = startH;
    let raf = false;
    const onMove = (ev) => {
      // Drag down → taller rows. ~1px drag = ~1px row height change.
      pendingH = startH + (ev.clientY - startY);
      if (raf) return;
      raf = true;
      requestAnimationFrame(() => {
        setRowHeight(pendingH);
        raf = false;
      });
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Click-and-drag pan: pure scrollLeft/scrollTop. No CSS transforms.
function setupGanttPan() {
  const panel = document.getElementById('schedule-gantt');
  if (!panel) return;
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!panel.contains(e.target)) return;
    if (e.target.closest('.bar-wrapper')) return;
    if (e.target.closest('button, input, select, a')) return;
    if (e.target.closest('.schedule-divider, .row-height-bar')) return;

    // Walk up and grab every scrollable ancestor — set scroll on all of them so it
    // doesn't matter which one actually owns the scrollbar.
    const scrollers = [];
    let el = e.target;
    while (el && el !== document.body) {
      const s = window.getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflow + s.overflowX + s.overflowY)) {
        scrollers.push({ el, sx: el.scrollLeft, sy: el.scrollTop });
      }
      if (el === panel) break;
      el = el.parentElement;
    }
    if (scrollers.length === 0) scrollers.push({ el: panel, sx: panel.scrollLeft, sy: panel.scrollTop });

    e.preventDefault();
    panel.classList.add('panning');
    const startX = e.clientX;
    const startY = e.clientY;

    const onMove = (ev) => {
      ev.preventDefault();
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      scrollers.forEach(s => {
        s.el.scrollLeft = s.sx - dx;
        s.el.scrollTop  = s.sy - dy;
      });
    };
    const onUp = () => {
      panel.classList.remove('panning');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, true);
}

function setupSplitDivider() {
  const divider = document.getElementById('schedule-divider');
  const grid = document.getElementById('schedule-grid');
  const split = document.getElementById('schedule-split');
  if (!divider || !grid || !split) return;
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    divider.classList.add('dragging');
    const splitRect = split.getBoundingClientRect();
    const onMove = (ev) => {
      const w = Math.max(280, Math.min(splitRect.right - 200, ev.clientX - splitRect.left));
      grid.style.width = w + 'px';
      state.layout.gridWidth = Math.round(w);
    };
    const onUp = () => {
      divider.classList.remove('dragging');
      saveLayout();
      // Re-render gantt so its width recalculates
      if (state.gantt) renderGantt();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function setupColumnResize() {
  document.querySelectorAll('#tasks-table thead th .col-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const th = handle.parentElement;
      const colName = th.dataset.col;
      const startX = e.clientX;
      // Read the STORED col width (not the rendered TH width which includes padding/border).
      // Otherwise dx=0 still kicks the column wider by ~17px the moment the drag begins.
      const startW = state.layout.colWidths[colName] ?? th.getBoundingClientRect().width;
      const min = COL_MIN_WIDTHS[colName] ?? 40;
      handle.classList.add('resizing');
      document.body.classList.add('resizing-col');
      const onMove = (ev) => {
        const w = Math.max(min, startW + (ev.clientX - startX));
        state.layout.colWidths[colName] = Math.round(w);
        applyColWidths();
      };
      const onUp = () => {
        handle.classList.remove('resizing');
        document.body.classList.remove('resizing-col');
        saveLayout();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

function toggleGanttVisible(visible) {
  state.layout.showGantt = !!visible;
  applyGanttVisibility();
  saveLayout();
  if (visible) renderGantt(); // it may need to re-render if hidden during prior render
}

// ---------- Customer view ----------
// "👤 For Customer" toggles a clean view for showing the schedule to a
// customer. Hides the toolbar / topbar / project tabs / extra grid columns
// via the body.customer-view CSS class, forces pane=both so they see grid +
// Gantt together, and zoom-to-fits the chart so the full project span is
// visible. State (pane mode, zoom, scroll) is saved on entry and restored
// on exit so toggling off returns the user to their exact editing layout.
// Keep the floating "≡ Flatten" button in customer view in sync with the
// flatten + sortByStart toggle. Same is-active class the toolbar's ≡ View-
// pill icon uses (so both buttons read consistent at a glance).
function syncCustomerViewFlattenBtn() {
  const btn = document.getElementById('btn-customer-view-flatten');
  if (!btn) return;
  const sv = state.scheduleView || {};
  btn.classList.toggle('is-active', !!(sv.flatten && sv.sortByStart));
}

function enterCustomerView() {
  if (document.body.classList.contains('customer-view')) return;
  // Snapshot what we're about to change so exitCustomerView() can put it
  // back. Pane mode is derived from the two flags that own pane state.
  const ganttOnly = !!state.scheduleView?.ganttOnly;
  const showGantt = state.layout?.showGantt !== false;
  state._cvSavedPane = ganttOnly ? 'gantt' : (showGantt ? 'both' : 'grid');
  state._cvSavedZoom = state.zoomPercent;
  state._cvSavedScroll = getGanttScroller()?.scrollLeft ?? 0;

  // Apply class first so the body width / panel widths reflow to the
  // customer layout BEFORE zoomToFit measures the Gantt panel size.
  document.body.classList.add('customer-view');
  // Force both panes so the customer sees grid + Gantt.
  setPaneMode('both');
  // Reflect the current flatten state on the floating button — flatten may
  // already be on (carried over from the editing view) and we want the
  // button to show as active immediately, not only after the user clicks it.
  syncCustomerViewFlattenBtn();
  // Defer zoomToFit two animation frames so the CSS reflow + setPaneMode's
  // re-render have settled; otherwise zoomToFit measures the pre-class
  // panel size and the chart ends up too wide for the (now-smaller) panel.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try { zoomToFit(); } catch (_) {}
    });
  });
}

function exitCustomerView() {
  if (!document.body.classList.contains('customer-view')) return;
  document.body.classList.remove('customer-view');
  // Restore pane mode (was forced to 'both' on entry).
  if (state._cvSavedPane) {
    setPaneMode(state._cvSavedPane);
    state._cvSavedPane = null;
  }
  // Restore zoom + scroll. setZoom would re-render, so we set the state
  // directly and call renderGantt once at the end.
  if (state._cvSavedZoom != null) {
    state.zoomPercent = state._cvSavedZoom;
    state._cvSavedZoom = null;
    if (state.view === 'schedule') renderGantt();
    const scroller = getGanttScroller();
    if (scroller && state._cvSavedScroll != null) {
      scroller.scrollLeft = state._cvSavedScroll;
    }
    state._cvSavedScroll = null;
  }
}

// Set the schedule pane layout. 'grid' = grid only (Gantt hidden). 'both' = split.
// 'gantt' = Gantt full-width (grid hidden). The two existing flags drive everything;
// this just keeps them in sync and re-applies styles + re-renders the Gantt.
// v4.52: the schedule/combined/actions toggle is a visible seg-control
// again. Keep the original function name (existing callers like + Add
// action's auto-switch Schedule → Combined still call this) and sync
// both the seg-control AND the hidden v4.51 dropdown helper.
function syncActionsModeButtons() {
  syncModeSegControl();
  syncViewModeButton();
  renderViewModeMenu();
}

// v4.51: View dropdown — Smartsheet-style picker holding both pane mode
// (Grid / Both / Gantt) and content mode (Schedule / Combined / Actions)
// in one popover divided by a line. The button label reflects both
// current values ("Both · Schedule") so the user can see state without
// opening the menu.
function getCurrentPaneMode() {
  if (state.scheduleView?.ganttOnly) return 'gantt';
  if (state.layout?.showGantt === false) return 'grid';
  return 'both';
}
function paneLabel(mode) {
  return mode === 'grid' ? 'Grid' : mode === 'gantt' ? 'Gantt' : 'Both';
}
function actionsLabel(mode) {
  return mode === 'combined' ? 'Combined' : mode === 'actions' ? 'Actions' : 'Schedule';
}
function syncViewModeButton() {
  const label = document.getElementById('view-mode-label');
  if (!label) return;
  const pane = getCurrentPaneMode();
  const am = state.scheduleView?.actionsMode || 'schedule';
  label.textContent = `${paneLabel(pane)} · ${actionsLabel(am)}`;
}
function renderViewModeMenu() {
  const menu = document.getElementById('view-mode-menu');
  if (!menu) return;
  const pane = getCurrentPaneMode();
  const am = state.scheduleView?.actionsMode || 'schedule';
  const item = (active, value, label, group) =>
    `<button type="button" class="dropdown-item ${active ? 'is-active' : ''}" data-${group}="${value}">
       <span class="dropdown-item-check">${active ? '✓' : ''}</span>
       <span>${label}</span>
     </button>`;
  menu.innerHTML = `
    <div class="view-mode-section">
      ${item(pane === 'grid',  'grid',  'Grid only',  'pane')}
      ${item(pane === 'both',  'both',  'Both',       'pane')}
      ${item(pane === 'gantt', 'gantt', 'Gantt only', 'pane')}
    </div>
    <div class="dropdown-sep"></div>
    <div class="view-mode-section">
      ${item(am === 'schedule', 'schedule', 'Schedule (duration tasks only)',         'actions')}
      ${item(am === 'combined', 'combined', 'Combined (scheduled + action items)',    'actions')}
      ${item(am === 'actions',  'actions',  'Actions (ad-hoc to-do items only)',      'actions')}
    </div>`;
  menu.querySelectorAll('[data-pane]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // setPaneMode now calls syncViewModeButton + renderViewModeMenu at
      // the end on its own — no extra sync needed here.
      setPaneMode(btn.dataset.pane);
    });
  });
  menu.querySelectorAll('[data-actions]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = btn.dataset.actions;
      if (state.scheduleView.actionsMode !== m) {
        state.scheduleView.actionsMode = m;
        saveScheduleView();
        render();
        // render() doesn't touch the dropdown — sync the button label and
        // re-render the menu so the new active row gets its checkmark + tint.
        syncViewModeButton();
        renderViewModeMenu();
      }
    });
  });
}
function setupViewModeDropdown() {
  const btn = document.getElementById('btn-view-mode');
  const menu = document.getElementById('view-mode-menu');
  if (!btn || !menu) return;
  syncViewModeButton();
  renderViewModeMenu();
  const closeMenu = () => menu.classList.add('hidden');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.classList.contains('hidden');
    // Close any other dropdown menus that might be open.
    document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== menu) m.classList.add('hidden'); });
    if (opening) {
      renderViewModeMenu(); // refresh checkmarks against current state
      menu.classList.remove('hidden');
    } else {
      menu.classList.add('hidden');
    }
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== btn) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
}

// ----------------------------------------------------------------------------
// v4.51 — Zoom dropdown. Single toolbar button that opens a popover holding
// three controls:
//   • TIME SCALE — radio rows: Days / Weeks / Months. Picks the Gantt's
//     view_mode (the existing #zoom-mode select is the underlying control).
//   • ZOOM       — minus / current % / plus. Drives setZoom() at the same
//     1.25x step the legacy + / − buttons used.
//   • ROW HEIGHT — minus / friendly value (10-100, increments of 10) / plus.
//     The internal layout.rowHeight value still tracks pixels (18-120) so
//     setRowHeight() doesn't need to change; the friendly value is a UI-only
//     projection mapped via px-to-friendly / friendly-to-px helpers below.
// The popover uses the standard .dropdown-menu chrome so styling matches
// the other dropdowns (Columns, View, Baseline).
// ----------------------------------------------------------------------------
// v4.55 friendly scales for the Zoom dropdown.
// ROW HEIGHT: 0 → 16px (smallest), 100 → 30px (largest). Step of 10 friendly
//   units = 1.4px. Note the friendly minimum is 0 (not 10).
// ZOOM: 1-10 EXPONENTIAL — each click multiplies zoomPercent by ~1.527 (the
//   9th root of 50, since friendly 1 = 5% and friendly 10 = 250% covers a
//   50× range). Levels:
//     1 → 5%    (Month, very far out)
//     2 → 7.6%
//     3 → 11.7%
//     4 → 17.8%
//     5 → 27.2%  (Week kicks in around here)
//     6 → 41.5%
//     7 → 63.4%
//     8 → 96.8%
//     9 → 147.8% (Day kicks in around here)
//     10 → 225.6%
//   getZoomConfig auto-switches Month/Week/Day based on pct, so the time
//   scale follows the zoom level automatically without a separate selector.
const ZOOM_FRIENDLY_MIN_PCT = 5;
const ZOOM_FRIENDLY_MAX_PCT = 250;
const ZOOM_FRIENDLY_MAX_LEVEL = 10;
const ZOOM_FRIENDLY_MULTIPLIER = Math.pow(
  ZOOM_FRIENDLY_MAX_PCT / ZOOM_FRIENDLY_MIN_PCT,
  1 / (ZOOM_FRIENDLY_MAX_LEVEL - 1)
); // ≈ 1.527
function pxToFriendlyRowH(px) {
  const t = (px - ROW_H_FRIENDLY_MIN_PX) / (ROW_H_FRIENDLY_MAX_PX - ROW_H_FRIENDLY_MIN_PX); // 0..1
  return Math.max(0, Math.min(100, Math.round((t * 100) / 10) * 10));
}
function friendlyRowHToPx(friendly) {
  const t = friendly / 100; // 0..1
  return Math.round(ROW_H_FRIENDLY_MIN_PX + t * (ROW_H_FRIENDLY_MAX_PX - ROW_H_FRIENDLY_MIN_PX));
}
function zoomToFriendly(pct) {
  // Exponential mapping: friendly = 1 + log(pct / 5) / log(multiplier).
  // Round to nearest integer + clamp to 1-10.
  if (pct <= ZOOM_FRIENDLY_MIN_PCT) return 1;
  const f = 1 + Math.log(pct / ZOOM_FRIENDLY_MIN_PCT) / Math.log(ZOOM_FRIENDLY_MULTIPLIER);
  return Math.max(1, Math.min(ZOOM_FRIENDLY_MAX_LEVEL, Math.round(f)));
}
function friendlyToZoom(friendly) {
  return ZOOM_FRIENDLY_MIN_PCT * Math.pow(ZOOM_FRIENDLY_MULTIPLIER, friendly - 1);
}
function renderZoomMenu() {
  const menu = document.getElementById('zoom-menu');
  if (!menu) return;
  const friendlyZoom = zoomToFriendly(state.zoomPercent);
  const friendlyRow  = pxToFriendlyRowH(state.layout?.rowHeight || ROW_H_FRIENDLY_MIN_PX);
  // v4.54: Time scale section dropped from the popover. Each zoom level (1-5)
  // now carries its own time-scale preset, so getZoomConfig auto-switches
  // Month → Week → Day as you step +/-. No need for a manual selector.
  menu.innerHTML = `
    <div class="zoom-menu-section">
      <div class="zoom-menu-title">Zoom</div>
      <div class="zoom-menu-row">
        <button type="button" class="btn-icon" data-zoom="out" ${friendlyZoom <= 1 ? 'disabled' : ''} title="Zoom out — small step (~1.5× per click). Mouse-wheel inside the Gantt is finer (~1.06× per tick).">−</button>
        <span class="zoom-menu-value">${friendlyZoom}</span>
        <button type="button" class="btn-icon" data-zoom="in"  ${friendlyZoom >= ZOOM_FRIENDLY_MAX_LEVEL ? 'disabled' : ''} title="Zoom in — small step (~1.5× per click). Mouse-wheel inside the Gantt is finer (~1.06× per tick).">+</button>
      </div>
    </div>
    <div class="dropdown-sep"></div>
    <div class="zoom-menu-section">
      <div class="zoom-menu-title">Row height</div>
      <div class="zoom-menu-row">
        <button type="button" class="btn-icon" data-row="down" ${friendlyRow <= 0   ? 'disabled' : ''} title="Shorter rows">−</button>
        <span class="zoom-menu-value">${friendlyRow}</span>
        <button type="button" class="btn-icon" data-row="up"   ${friendlyRow >= 100 ? 'disabled' : ''} title="Taller rows">+</button>
      </div>
    </div>`;
  // Zoom +/− — step by exactly 1 friendly unit (1-10). Each level is
  // ~1.527× the previous, so the displayed value moves reliably one step
  // per click. Mouse-wheel inside the Gantt stays finer (~1.06× per tick).
  menu.querySelectorAll('[data-zoom]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dir = btn.dataset.zoom;
      const shown = zoomToFriendly(state.zoomPercent);
      const target = dir === 'in'
        ? Math.min(ZOOM_FRIENDLY_MAX_LEVEL, shown + 1)
        : Math.max(1, shown - 1);
      setZoom(friendlyToZoom(target));
      renderZoomMenu();
    });
  });
  // Row +/− — steps in friendly increments of 10. setRowHeight clamps to the
  // px range so we never escape ROW_H_MIN/ROW_H_MAX.
  menu.querySelectorAll('[data-row]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dir = btn.dataset.row;
      const current = pxToFriendlyRowH(state.layout.rowHeight);
      const next = dir === 'up' ? Math.min(100, current + 10) : Math.max(10, current - 10);
      setRowHeight(friendlyRowHToPx(next));
      renderZoomMenu();
    });
  });
}
function setupZoomDropdown() {
  const btn = document.getElementById('btn-zoom-menu');
  const menu = document.getElementById('zoom-menu');
  if (!btn || !menu) return;
  renderZoomMenu();
  const closeMenu = () => menu.classList.add('hidden');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.classList.contains('hidden');
    document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== menu) m.classList.add('hidden'); });
    if (opening) {
      renderZoomMenu();
      menu.classList.remove('hidden');
    } else {
      menu.classList.add('hidden');
    }
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== btn) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
}

// ----------------------------------------------------------------------------
// v4.52 — Pane + Mode seg-controls on the toolbar (replaces the v4.51
// combined View dropdown). Two visible 3-button seg-controls: pane layout
// (Grid/Both/Gantt) and content mode (Schedule/Combined/Actions). Each
// button has its own is-active state synced to the underlying state via
// syncPaneSegControl / syncModeSegControl.
// ----------------------------------------------------------------------------
function syncPaneSegControl() {
  const mode = getCurrentPaneMode(); // 'grid' | 'both' | 'gantt'
  document.querySelectorAll('#pane-seg .seg-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.pane === mode);
  });
}
function setupPaneSegControl() {
  const seg = document.getElementById('pane-seg');
  if (!seg) return;
  seg.querySelectorAll('.seg-btn[data-pane]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setPaneMode(btn.dataset.pane);
    });
  });
  syncPaneSegControl();
}
function syncModeSegControl() {
  const mode = state.scheduleView?.actionsMode || 'schedule';
  document.querySelectorAll('#mode-seg .seg-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.actionsMode === mode);
  });
}
function setupModeSegControl() {
  const seg = document.getElementById('mode-seg');
  if (!seg) return;
  seg.querySelectorAll('.seg-btn[data-actions-mode]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = btn.dataset.actionsMode;
      if (!['schedule', 'combined', 'actions'].includes(m)) return;
      if (state.scheduleView.actionsMode === m) return;
      state.scheduleView.actionsMode = m;
      saveScheduleView();
      syncModeSegControl();
      render();
    });
  });
  syncModeSegControl();
}

function setPaneMode(mode) {
  if (!['grid', 'both', 'gantt'].includes(mode)) return;
  const becomingVisible = !state.layout.showGantt && mode !== 'grid';
  state.layout.showGantt = (mode !== 'grid');
  state.scheduleView.ganttOnly = (mode === 'gantt');
  // When the Gantt becomes visible (grid → both / grid → gantt / both → gantt) auto
  // zoom-to-fit so the project span centers in the freshly-sized panel.
  if (mode === 'both' || mode === 'gantt') {
    state._fitOnNextRender = true;
  }
  saveLayout();
  saveScheduleView();
  applyGanttVisibility();
  applyScheduleView();
  // When the Gantt panel was just unhidden, the browser hasn't finished laying out
  // the now-visible panel yet — its clientWidth still reads stale (often 0). Defer
  // renderGantt to the next animation frame so the fit calc measures the actual
  // new panel width. For grid-only, no Gantt rendering needed anyway.
  if (becomingVisible) {
    requestAnimationFrame(() => renderGantt());
  } else if (mode !== 'grid') {
    renderGantt();
  }
  // v4.52: keep the pane seg-control's is-active states in sync no matter
  // where setPaneMode was called from (seg-btn click, customer-view exit,
  // future keyboard shortcuts, etc.). Also pings the hidden v4.51 dropdown
  // helper so it stays consistent if anything still references it.
  syncPaneSegControl();
  syncViewModeButton();
  renderViewModeMenu();
}

// ----------------------------------------------------------------------------
// Revision pill — reads window.RELEASE_NOTES (newest first) from release-notes.js.
// The topbar shows the version of the FIRST entry; clicking opens a popover
// listing every entry. To bump the rev, prepend a new entry in release-notes.js.
// ----------------------------------------------------------------------------
function setupRevisionPill() {
  const btn = document.getElementById('btn-revision');
  const pop = document.getElementById('revision-popover');
  if (!btn || !pop) return;

  // The topbar has position: sticky with z-index: 10, which creates a stacking
  // context. The project-tab-bar below it has z-index: 11. Re-parent the popover
  // to <body> so its z-index isn't capped by the topbar's stacking context —
  // otherwise the tab bar paints on top of the popover when it drops down.
  if (pop.parentElement !== document.body) document.body.appendChild(pop);

  const entries = Array.isArray(window.RELEASE_NOTES) ? window.RELEASE_NOTES : [];
  const verEl = document.getElementById('revision-version');
  if (verEl) verEl.textContent = entries[0]?.version || '—';

  // Build the popover body once. Each entry becomes a card with version + date + bullets.
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const entriesHtml = entries.length
    ? entries.map(e => `
        <div class="revision-entry">
          <div class="revision-entry-head">
            <span class="revision-entry-version">Rev ${escapeHtml(e.version)}</span>
            <span class="revision-entry-date">${escapeHtml(fmtDate(e.date))}</span>
          </div>
          <ul class="revision-entry-notes">
            ${(e.notes || []).map(n => `<li>${escapeHtml(n)}</li>`).join('')}
          </ul>
        </div>
      `).join('')
    : '<div class="revision-entry"><em>No release notes yet.</em></div>';
  pop.innerHTML = `
    <div class="revision-popover-head">
      <h3 class="revision-popover-title">Release notes</h3>
      <span class="revision-popover-subtitle">Newest first</span>
    </div>
    <div class="revision-popover-body">${entriesHtml}</div>
  `;

  const positionPopover = () => {
    const r = btn.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + 'px';
    // Anchor to the right edge of the button, then clamp into the viewport.
    const popW = pop.offsetWidth || 380;
    let left = r.right - popW;
    if (left < 8) left = 8;
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
    pop.style.left = left + 'px';
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willShow = pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !willShow);
    if (willShow) positionPopover();
  });
  document.addEventListener('click', (e) => {
    if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      pop.classList.add('hidden');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') pop.classList.add('hidden');
  });
  window.addEventListener('resize', () => {
    if (!pop.classList.contains('hidden')) positionPopover();
  });
}

async function init() {
  await loadSettings();

  document.getElementById('btn-save-setup').addEventListener('click', saveSetup);
  document.getElementById('btn-reset-setup').addEventListener('click', discardSetup);
  document.getElementById('btn-add-color').addEventListener('click', () => {
    ensureSetupDraft();
    state.setupDraft.brand_palette.push({ name: 'New color', hex: '#888888' });
    renderSetup();
  });
  document.getElementById('btn-add-phase').addEventListener('click', () => {
    ensureSetupDraft();
    const newKey = `phase_${Date.now().toString(36).slice(-4)}`;
    state.setupDraft.phases.push({ key: newKey, label: 'New phase', color: '#d9d9d9', text: '#061d39' });
    renderSetup();
  });


  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => setView(t.dataset.view));
  });

  // Layout (split, columns, show-gantt) — hydrate from localStorage and wire up handlers
  state.layout = loadLayout();
  state.scheduleView = loadScheduleView();
  applyGridWidth();
  applyRowHeight();
  renderHeaders();
  applyGanttVisibility();
  applyScheduleView();
  renderColumnsMenu();
  setupSplitDivider();
  setupRowHeightHandle();
  setupGanttPan();
  // v4.52: Two visible seg-controls on the toolbar row replace the v4.51
  // combined dropdown. Pane (Grid/Both/Gantt) + Actions mode (Schedule/
  // Combined/Actions) are now direct click-to-select buttons. The hidden
  // legacy #btn-view-mode is still wired by setupViewModeDropdown() but
  // nobody can open it — its menu element exists just so the helper
  // functions don't bail. The seg-controls are the visible UI.
  setupViewModeDropdown();
  setupPaneSegControl();
  setupModeSegControl();
  // v4.51: Zoom dropdown — single toolbar button popover with Time scale /
  // Zoom (1-10) / Row height (10-100). Drives the legacy zoom/row controls.
  setupZoomDropdown();
  // View pill — four icon-toggles in the toolbar:
  //   ≡   Flatten sub-sections + sort by start date (linked toggle)
  //   $   Show financial milestones overlay
  //   ↔   Show arrow lag labels (±N wks)
  //   %   Show bar allocation + duration meta
  // Critical path stays as a Quick-filter chip (see renderFilters). The View
  // pill state is reflected via .is-active classes maintained by syncViewPill.
  const wireViewToggle = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (key === 'financials') {
        state.showFinancials = !state.showFinancials;
        saveScheduleView();
        if (state.showFinancials) await loadFinancialsForAllOpenProjects();
        syncViewPill();
        renderGantt();
      } else if (key === 'showArrowLags') {
        // Arrow-lag labels only affect the Gantt overlay, not the grid — so
        // skip the heavy render() and just re-render the Gantt to redraw
        // arrows with or without labels.
        state.scheduleView.showArrowLags = !state.scheduleView.showArrowLags;
        saveScheduleView();
        syncViewPill();
        renderGantt();
      } else if (key === 'showBarMeta') {
        // Bar meta (allocation % above bars, duration wks below) only affects
        // the Gantt — same fast path as the arrow lag toggle.
        state.scheduleView.showBarMeta = !state.scheduleView.showBarMeta;
        saveScheduleView();
        syncViewPill();
        renderGantt();
      } else if (key === 'flatten+sort') {
        // Single icon that toggles BOTH flatten AND sortByStart together —
        // flatten without sort almost never makes sense (you flatten because
        // you want a chronological view of section 10/40/50), so user
        // requested they live behind one click.
        const turningOn = !(state.scheduleView.flatten && state.scheduleView.sortByStart);
        state.scheduleView.flatten     = turningOn;
        state.scheduleView.sortByStart = turningOn;
        saveScheduleView();
        applyScheduleView();
        syncViewPill();
        render();
      } else {
        state.scheduleView[key] = !state.scheduleView[key];
        saveScheduleView();
        applyScheduleView();
        syncViewPill();
        render();
      }
    });
  };
  wireViewToggle('btn-view-flatten',    'flatten+sort');
  wireViewToggle('btn-view-alloc-pre',  'showInlineAlloc');
  wireViewToggle('btn-view-financials', 'financials');
  wireViewToggle('btn-view-lags',       'showArrowLags');
  wireViewToggle('btn-view-bar-meta',   'showBarMeta');
  syncViewPill();

  // Baseline — dropdown menu. The menu rebuilds on every open so its items
  // reflect the current state (turn-on vs reset, show vs hide, turn-off).
  // Replaces the previous segmented pair (Set / Show) which didn't surface the
  // "turn off completely" action — users had to right-click to find Clear.
  //
  // Implementation notes:
  //   - Each item carries its own onClick. We render BOTH separators and item
  //     buttons into the menu HTML and then wire click handlers by walking
  //     element children paired with the items array — keeping the same index
  //     for both arrays (previous code used querySelectorAll('.dropdown-item')
  //     which skipped separators, throwing item indices off-by-one so the wrong
  //     handler fired, or no handler at all). That's why "Turn off baseline"
  //     looked like a no-op.
  //   - All confirmations use the in-app showConfirmAt() anchored to the click
  //     location, NOT native confirm().
  const baseMenuBtn = document.getElementById('btn-baseline-menu');
  const baseMenu    = document.getElementById('baseline-menu');
  if (baseMenuBtn && baseMenu) {
    syncBaselineButtons();
    const closeBaselineMenu = () => baseMenu.classList.add('hidden');
    const renderBaselineMenu = () => {
      const project = state.filters.project;
      const has = projectHasBaseline(project);
      const items = [];
      if (!project) {
        items.push({ label: '(Open a project tab first)', disabled: true });
      } else if (!has) {
        items.push({
          label: '▷ Turn on baseline',
          hint: `Snapshot today's start/end dates as the plan-of-record for "${project}".`,
          onClick: async (clickX, clickY) => {
            const ok = await showConfirmAt(clickX, clickY, {
              message: `Set a baseline for "${project}"? Today's start/end dates become the plan-of-record.`,
              confirmLabel: 'Turn on',
            });
            if (!ok) return;
            await api.baseline.set(project);
            await loadTasks();
            state.showBaseline = true;
            saveScheduleView();
            syncBaselineButtons();
            renderGantt();
          },
        });
      } else {
        items.push({
          label: state.showBaseline ? '☑ Show overlay (on)' : '☐ Show overlay (off)',
          hint: 'Toggle the dashed-outline overlay on the Gantt. The baseline snapshot stays saved either way.',
          // No confirmation — purely visual toggle, no data is destroyed.
          onClick: () => {
            state.showBaseline = !state.showBaseline;
            saveScheduleView();
            syncBaselineButtons();
            renderGantt();
          },
        });
        items.push({
          label: '↻ Reset baseline',
          hint: 'Overwrite the snapshot with today\'s start/end dates as the new plan-of-record.',
          onClick: async (clickX, clickY) => {
            const ok = await showConfirmAt(clickX, clickY, {
              message: `Reset the baseline for "${project}"? Today's dates become the new plan-of-record (the previous snapshot is overwritten).`,
              confirmLabel: 'Reset',
            });
            if (!ok) return;
            await api.baseline.set(project);
            await loadTasks();
            syncBaselineButtons();
            renderGantt();
          },
        });
        items.push({ separator: true });
        items.push({
          label: '✖ Turn off baseline',
          danger: true,
          hint: 'Clear the baseline snapshot entirely. Drift comparisons will no longer be available until you turn it back on.',
          onClick: async (clickX, clickY) => {
            const ok = await showConfirmAt(clickX, clickY, {
              message: `Turn off the baseline for "${project}"? The saved snapshot will be cleared and drift comparisons will go away.`,
              confirmLabel: 'Turn off',
              danger: true,
            });
            if (!ok) return;
            await api.baseline.clear(project);
            await loadTasks();
            state.showBaseline = false;
            saveScheduleView();
            syncBaselineButtons();
            renderGantt();
          },
        });
      }
      // Render and wire in lock-step so separators keep their slot in BOTH the
      // DOM and the items array — fixes the index-mismatch bug that made Turn
      // off baseline behave like a no-op.
      baseMenu.innerHTML = '';
      items.forEach((it) => {
        if (it.separator) {
          const sep = document.createElement('div');
          sep.className = 'dropdown-sep';
          baseMenu.appendChild(sep);
          return;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dropdown-item';
        if (it.disabled) btn.classList.add('is-disabled');
        if (it.danger)   btn.classList.add('is-danger');
        if (it.disabled) btn.disabled = true;
        if (it.hint)     btn.title = it.hint;
        btn.textContent = it.label;
        if (!it.disabled && it.onClick) {
          btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const x = ev.clientX, y = ev.clientY;
            closeBaselineMenu();
            await it.onClick(x, y);
          });
        }
        baseMenu.appendChild(btn);
      });
    };
    baseMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willShow = baseMenu.classList.contains('hidden');
      if (willShow) {
        renderBaselineMenu();
        baseMenu.classList.remove('hidden');
        // Position below the button, left-aligned.
        const r = baseMenuBtn.getBoundingClientRect();
        baseMenu.style.top  = (r.bottom + 4) + 'px';
        baseMenu.style.left = Math.max(8, r.left) + 'px';
      } else {
        closeBaselineMenu();
      }
    });
    // Reparent to body so the dropdown doesn't get clipped by the toolbar's
    // overflow boundaries.
    if (baseMenu.parentElement !== document.body) document.body.appendChild(baseMenu);
    document.addEventListener('click', (e) => {
      if (!baseMenu.contains(e.target) && e.target !== baseMenuBtn && !baseMenuBtn.contains(e.target)) {
        closeBaselineMenu();
      }
    });
  }

  // Columns dropdown toggle
  const colBtn = document.getElementById('btn-columns');
  const colMenu = document.getElementById('columns-menu');
  colBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    colMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!colMenu.contains(e.target) && e.target !== colBtn) colMenu.classList.add('hidden');
  });

  setupScrollSync();

  // + New Task button creates an empty task in UNASSIGNED and focuses its name cell for
  // inline rename. The user drags it into a section after.
  document.getElementById('btn-add').addEventListener('click', newTaskInline);
  const addActionBtn = document.getElementById('btn-add-action');
  if (addActionBtn) addActionBtn.addEventListener('click', newActionInline);
  // Cell-edit handler is attached once here — renderTable rebuilds tbody.innerHTML so the
  // tbody element survives across renders and accumulating listeners is wasteful.
  const tbodyEl = document.getElementById('tasks-tbody');
  tbodyEl.addEventListener('click', handleCellClick);
  tbodyEl.addEventListener('contextmenu', handleRowContextMenu);
  setupGridPan();
  setupRowCrossHighlight();

  // Filters popover — toggled by the topbar's Filters button. Inner controls are
  // re-bound by renderFilters each time it runs.
  const filtersBtn = document.getElementById('btn-filters');
  const filtersPop = document.getElementById('filters-popover');
  if (filtersBtn && filtersPop) {
    // Same stacking-context fix as the revision popover: the topbar has
    // position:sticky + z-index:10, which traps any descendant's z-index. Reparent
    // to <body> so the popover paints above the project-tab-bar (z-index:11) and
    // anything else that sits between the topbar and the schedule body.
    if (filtersPop.parentElement !== document.body) document.body.appendChild(filtersPop);
    filtersBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willShow = filtersPop.classList.contains('hidden');
      filtersPop.classList.toggle('hidden', !willShow);
      if (willShow) {
        // v4.51: re-render the popover content before showing so the For
        // Customer checkbox (and any other live state) reflects current
        // values. exitCustomerView etc. don't trigger a full render() so
        // without this the checkbox could go stale.
        renderFilters();
        // Anchor the popover to the button's bottom-left so it always opens on screen.
        const r = filtersBtn.getBoundingClientRect();
        filtersPop.style.top  = (r.bottom + 4) + 'px';
        filtersPop.style.left = Math.max(8, r.left) + 'px';
      }
    });
    document.addEventListener('click', (e) => {
      if (!filtersPop.contains(e.target) && e.target !== filtersBtn && !filtersBtn.contains(e.target)) {
        filtersPop.classList.add('hidden');
      }
    });
  }

  // Revision pill — top-right of the topbar. Shows the current version and opens a
  // popover listing every release-notes entry (newest first). Entries live in
  // release-notes.js so bumping the rev is just an array edit.
  setupRevisionPill();

  // Project tab bar
  // + New tab — opens the Workspaces side panel so the user can pick or build
  // a schedule. Right-click → legacy picker fallback (the estimate +
  // Smartsheet flows still live there until they're migrated to the panel).
  document.getElementById('btn-add-project').addEventListener('click', () => {
    openSidebarPanel('workspaces');
  });
  document.getElementById('btn-add-project').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showProjectAddPicker();
  });

  // Left sidebar icons — each navigates to a top-level view. The
  // [data-view] attribute matches the view's section id (#view-<view>) so we
  // just call setView() and let the standard view-switching machinery handle
  // it. Revision pill (📌) opens the revision popover via its own existing
  // handler below — not handled here.
  document.querySelectorAll('.app-sidebar-icon[data-view]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const v = btn.dataset.view;
      if (!v) return;
      // v4.64: Departments tab is password-gated via the SDC-themed modal
      // (was a browser prompt() in v4.63). Auth caches in sessionStorage so
      // the prompt fires once per browser session, not on every click.
      // Change TEAM_PASSWORD at the top of this file to rotate the password.
      if (v === 'team' && !sessionStorage.getItem('sdcTeamAuth')) {
        const pwd = await showPasswordDialog({
          title: 'Departments',
          message: 'Manager-only area. Enter the team password to continue.',
        });
        if (pwd == null) return; // cancelled
        if (pwd !== TEAM_PASSWORD) {
          await showAlertDialog({ title: 'Wrong password', message: "That doesn't match. Ask a manager for the password if you need access." });
          return;
        }
        sessionStorage.setItem('sdcTeamAuth', '1');
      }
      setView(v);
    });
  });

  // ⚖ Quote vs Schedule toolbar button — wires once at startup, then the
  // enabled/disabled state + tooltip is refreshed every render() by
  // syncToolbarProjectAction (so it reflects the active project tab).
  const quoteToolbarBtn = document.getElementById('btn-toolbar-quote');
  if (quoteToolbarBtn) {
    quoteToolbarBtn.addEventListener('click', () => {
      const p = state.filters.project;
      if (!p) return;
      openQuoteCompareModal(p);
    });
  }

  // Zoom-to-fit button — zoomToFit reads the visible task span and snaps the Gantt zoom
  // so it all fits in the viewport. Wheel-zoom still works for finer adjustments.
  document.getElementById('btn-zoom-fit').addEventListener('click', zoomToFit);

  // Undo button — pops the top entry of state.undoStack and re-applies the
  // BEFORE snapshot via api.update. Disabled when the stack is empty.
  const undoBtn = document.getElementById('btn-undo');
  if (undoBtn) {
    undoBtn.addEventListener('click', performUndo);
    syncUndoButton();  // start with the right disabled state
  }
  // Redo button — opposite direction. Pops state.redoStack and re-applies.
  // A new edit (pushUndoSnapshot) clears the redo stack to keep history linear.
  const redoBtn = document.getElementById('btn-redo');
  if (redoBtn) {
    redoBtn.addEventListener('click', performRedo);
    syncRedoButton();
  }
  // "👤 For Customer" — toggles a clean customer-facing view by adding the
  // body.customer-view class. CSS hides the toolbar / tabs / extra columns;
  // JS forces pane=both and runs zoomToFit so the customer sees grid + Gantt
  // fitted to the full project span. A floating "✕ Exit customer view"
  // button appears top-right (visible only while the class is set) to get
  // back to the editing view — the main toolbar is hidden so the original
  // button isn't clickable anymore.
  //
  // Replaces the older Export-PDF flow which tried to drive the browser
  // print dialog directly. That approach was fighting too many issues at
  // once (panel size mismatch between screen and print, viewBox scaling,
  // beforeprint timing). Far simpler to just put the on-screen app into a
  // customer-friendly state and let the user screenshot / share / print it
  // themselves — Ctrl+P from customer view still works, with the same
  // hidden chrome.
  const customerBtn = document.getElementById('btn-customer-view');
  const customerExitBtn = document.getElementById('btn-customer-view-exit');
  const customerFlattenBtn = document.getElementById('btn-customer-view-flatten');
  if (customerBtn) {
    customerBtn.addEventListener('click', () => {
      if (document.body.classList.contains('customer-view')) {
        exitCustomerView();
      } else {
        if (!state.filters.project) {
          showAlertDialog('Pick a project tab first — customer view is per-project.');
          return;
        }
        enterCustomerView();
      }
    });
  }
  if (customerExitBtn) {
    customerExitBtn.addEventListener('click', exitCustomerView);
  }
  // The Flatten button in customer view is a slim mirror of the toolbar's
  // ≡ View pill — both toggle flatten + sortByStart in lockstep (the same
  // linked pair used everywhere else in the app; flatten without start-date
  // sort almost never makes sense, per v3.58). After flipping the flag we
  // call render() to redraw the grid + Gantt under the new layout and
  // syncCustomerViewFlattenBtn() to update the button's is-active fill.
  if (customerFlattenBtn) {
    customerFlattenBtn.addEventListener('click', () => {
      const turningOn = !(state.scheduleView.flatten && state.scheduleView.sortByStart);
      state.scheduleView.flatten     = turningOn;
      state.scheduleView.sortByStart = turningOn;
      saveScheduleView();
      applyScheduleView();
      syncViewPill();
      syncCustomerViewFlattenBtn();
      render();
    });
  }

  // Topbar zoom controls: − / mode / + . The mode picker jumps to a representative zoom
  // for that scale (Day=200%, Week=70%, Month=10%) so the user can switch directly.
  const zoomIn = document.getElementById('btn-zoom-in');
  const zoomOut = document.getElementById('btn-zoom-out');
  const zoomMode = document.getElementById('zoom-mode');
  if (zoomIn) zoomIn.addEventListener('click', () => setZoom(state.zoomPercent * 1.25));
  if (zoomOut) zoomOut.addEventListener('click', () => setZoom(state.zoomPercent / 1.25));
  if (zoomMode) zoomMode.addEventListener('change', (e) => {
    const target = e.target.value;
    const presets = { Day: 200, Week: 70, Month: 10 };
    setZoom(presets[target] || 100);
  });

  // Row height +/- controls. Plus grows rows by ROW_H_STEP, minus shrinks. The
  // percentage label is updated by setRowHeight via updateRowHeightLabel().
  const rowHUp   = document.getElementById('btn-row-h-up');
  const rowHDown = document.getElementById('btn-row-h-down');
  if (rowHUp)   rowHUp  .addEventListener('click', () => setRowHeight(state.layout.rowHeight + ROW_H_STEP));
  if (rowHDown) rowHDown.addEventListener('click', () => setRowHeight(state.layout.rowHeight - ROW_H_STEP));

  // Wheel inside the Gantt = continuous multiplicative zoom (~6% per wheel tick), rAF-throttled.
  // Scroll wheel BACK (toward user / deltaY > 0) zooms IN. Scroll forward zooms OUT.
  const WHEEL_FACTOR = 1.06;
  let pendingFactor = 1;
  let zoomScheduled = false;
  const onZoomWheel = (e) => {
    if (!state.gantt) return;
    e.preventDefault();
    pendingFactor *= e.deltaY > 0 ? WHEEL_FACTOR : (1 / WHEEL_FACTOR);
    if (zoomScheduled) return;
    zoomScheduled = true;
    requestAnimationFrame(() => {
      setZoom(state.zoomPercent * pendingFactor);
      pendingFactor = 1;
      zoomScheduled = false;
    });
  };
  document.getElementById('schedule-gantt').addEventListener('wheel', onZoomWheel, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Blur any active inline editor so the user can dismiss without saving.
      if (document.activeElement && document.activeElement.tagName === 'INPUT') document.activeElement.blur();
    }
  });

  loadTasks();
  loadTeam();
}

document.addEventListener('DOMContentLoaded', init);
