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
const DISCIPLINES = [
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
    quick: { behind: false, ahead: false, milestones: false, assigned: false, overallocated: false },
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
  scheduleView: { flatten: false, sortByStart: false, ganttOnly: false, criticalPath: false, criticalOnly: false },
  settings: null,
  setupDraft: null, // editable copy while user is in Setup view
  layout: null,     // { gridWidth, showGantt, colWidths, rowHeight } - hydrated in init
  resources: { discipline: 'mech', project: '', zoomPercent: 100 },
  overAllocatedTaskIds: new Set(),
  // Open project schedules — like browser tabs. The empty string acts as the "All
  // projects" pseudo-tab so the user can always step back to the global view. Persisted
  // to localStorage so reloads remember which schedules you had open and which one was
  // active. The Team and Setup views ignore this — they show data across all projects.
  openProjects: [''],
  // Project names flagged as templates: protected from accidental close, marked with
  // a star in the tab. Stored in localStorage as a string array.
  templateProjects: [],
  // Project financial milestones, keyed by project name. Loaded on demand when the
  // Financials modal opens or the $ Financial overlay is enabled. Each value is the
  // full array from /api/financials?project=… in display order (sort_order, then id).
  financials: {},
  // Toggle for the $ Financial Gantt overlay. Persisted to localStorage via
  // saveScheduleView so it sticks across reloads.
  showFinancials: false,
};

const ROW_H_MIN = 14;
const ROW_H_MAX = 120;
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
  for (const t of filtered) {
    // Anchors render at fixed spine positions outside the bucket walk. Machine
    // Power-Up is the one exception — it lives inside section 10 Wire and flows
    // through its bucket. Match by anchor_key (not phase_group presence) so stale
    // data on the spine anchors can't sneak them into a bucket.
    const k = inferredAnchorKey(t);
    if (k && k !== 'machine_power_up') continue;
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
  for (const group of HIERARCHY) {
    if (state.scheduleView?.flatten) {
      // Same bucket rule as the table walk: keep Machine Power-Up, drop the other
      // anchors regardless of their stored phase_group.
      const sectionTasks = filtered.filter(t => {
        if (t.phase_group !== group.key) return false;
        const k = inferredAnchorKey(t);
        return !k || k === 'machine_power_up';
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
  if (d % 5 === 0 && d >= 5) return `${d / 5}w`;
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

function uniqueValues(field) {
  return [...new Set(state.tasks.map(t => t[field]).filter(Boolean))].sort();
}

// Compute how far ahead/behind a task is at today's date. Returns business-day
// integer: positive = ahead of plan, negative = behind, 0 = on track / N/A.
// Mirrors the math in drawScheduleStatus so the chip and the filter agree.
function taskScheduleDelta(task) {
  if (!task || task.is_milestone || !task.start_date || !task.end_date) return 0;
  if (inferredAnchorKey(task)) return 0;
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
    // Anchors are always kept — they're the project spine, not "tasks" the user
    // is asking to focus on. The quick filters target real work rows below.
    const isAnchor = !!inferredAnchorKey(t);
    if (isAnchor) return true;
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
    case 'name':     return `<td class="${cls}" data-col="name">${escapeHtml(t.name)}</td>`;
    case 'assignee': {
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
    case 'duration': return `<td class="${cls}" data-col="duration">${durationLabel(t)}</td>`;
    case 'pred':     return `<td class="${cls}" data-col="pred"></td>`; /* filled in by updateLineNumbers */
    case 'progress': {
      const p = t.progress || 0;
      return `<td class="${cls}" data-col="progress"><span class="progress-bar"><span style="width:${p}%"></span></span> ${p}%</td>`;
    }
    case 'allocation': {
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
  return `<tr data-id="${t.id}" class="depth-${depth} ${t.is_milestone ? 'is-milestone' : ''}" data-color-key="${colorKey}" style="--row-phase-color:${stripe}">${cells}</tr>`;
}

function headerRowHtml(level, label, path, collapsed, dataAttrs = {}) {
  const cols = state.layout.columnOrder.length;
  const caret = collapsed ? '▸' : '▾';
  const attrs = Object.entries(dataAttrs)
    .map(([k, v]) => ` data-${k}="${escapeHtml(String(v))}"`).join('');
  return `
    <tr class="group-header level-${level} ${collapsed ? 'collapsed' : ''}" data-path="${escapeHtml(path)}"${attrs}>
      <td colspan="${cols}">
        <span class="group-caret">${caret}</span>
        <span class="group-label">${escapeHtml(label)}</span>
      </td>
    </tr>`;
}

function renderTable() {
  const tbody = document.getElementById('tasks-tbody');
  let filtered = applyFilters(state.tasks);
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

  // Bucket tasks by hierarchy path. Anchor milestones render as fixed rows outside
  // the section walk (Receipt of PO above 10, FAT between 40/50, Ship Machine
  // between teardown and install). The ONE exception is Machine Power-Up: it lives
  // inside section 10 → Shop → Wire and flows naturally with the wire team's work,
  // so it stays in the bucket walk (with anchor styling layered on at render time).
  // We match by anchor_key explicitly — checking phase_group alone would let stale
  // data on the other three anchors (e.g. a legacy Receipt of PO row with phase_group
  // = teardown_install from an old migration) double-render: once on the spine, once
  // in whichever bucket the stale phase_group points to.
  const buckets = {};
  for (const t of filtered) {
    const k = inferredAnchorKey(t);
    if (k && k !== 'machine_power_up') continue;
    const path = groupPath(t.phase_group, t.department, t.sub_department);
    (buckets[path] ||= []).push(t);
  }
  // Sort each bucket — by start_date when the user has flipped the "By date" toggle,
  // otherwise by their manual sort_order so drag-reordering sticks.
  const sortBucket = (arr) => {
    if (state.scheduleView.sortByStart) {
      arr.sort((a, b) =>
        (a.start_date || '￿').localeCompare(b.start_date || '￿')
        || (a.sort_order || 0) - (b.sort_order || 0));
    } else {
      arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    }
  };
  for (const k in buckets) sortBucket(buckets[k]);

  // Flatten mode collects every task under each section into one ordered list and
  // skips dept / sub-dept walks. Built once so it's cheap to look up per section.
  // Same anchor-keep rule as the bucketed walk: only Machine Power-Up flows into
  // its section's flat list; the other anchors render outside the walk regardless
  // of what their stored phase_group says.
  const flatBySection = {};
  if (state.scheduleView.flatten) {
    for (const t of filtered) {
      const k = inferredAnchorKey(t);
      if (k && k !== 'machine_power_up') continue;
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
  const anchorRowHtml = (t) => {
    const order = state.layout.columnOrder;
    const cells = order.map(k => {
      if (k === 'name') {
        return `<td data-col="name"><span class="anchor-name-chip">${escapeHtml(t.name || '')}</span></td>`;
      }
      return cellHtml(t, k);
    }).join('');
    return `<tr data-id="${t.id}" class="depth-1 anchor-row" data-anchor-key="${escapeHtml(inferredAnchorKey(t) || '')}">${cells}</tr>`;
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
  if (receiptAnchor) html += anchorRowHtml(receiptAnchor);

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
  const td = e.target.closest('td[data-col]');
  if (!td) return;
  const tr = td.closest('tr[data-id]');
  if (!tr) return;
  const id = Number(tr.dataset.id);
  const col = td.dataset.col;
  if (col === 'line') return; // auto-computed, not editable
  enterCellEdit(td, id, col);
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
  const finalize = async (commit) => {
    if (done) return;
    done = true;
    if (commit && input.value !== original) {
      try { await saveCellEdit(taskId, col, input.value, task); }
      catch (err) { console.error(err); }
    }
    await loadTasks();
  };

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
    case 'duration': return durationLabel(task);
    case 'pred':     return predDisplay(task.predecessors || '');
    case 'progress': return String(task.progress || 0);
    case 'allocation': return String(task.allocation == null ? 90 : task.allocation);
    case 'priority': return String(task.priority == null ? 1 : task.priority);
  }
  return '';
}

function createEditInput(col, value) {
  if (col === 'assignee') {
    // Constrained to active team members. Names are grouped by discipline so the user can
    // tell at a glance who's a mech engineer vs. an electrician. Existing assignees that
    // aren't on the team list show up as a "(not on team)" option so legacy data stays
    // visible — saving picks any one of these and stores the name string verbatim.
    const sel = document.createElement('select');
    sel.className = 'cell-edit-input';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— unassigned —';
    sel.appendChild(blank);
    const seen = new Set();
    for (const disc of DISCIPLINES) {
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
      const days = parseDurationInput(value); // business days
      if (days == null) break;
      // Duration is the SOURCE OF TRUTH. Save it explicitly. End date is derived,
      // so it'll shift by however many calendar days the working span needs.
      data.duration_days = days;
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
  }
  if (Object.keys(data).length > 0) await api.update(id, data);
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
  // Phase-based bar colors first (legacy / fallback for tasks without a hierarchy match).
  const phaseRules = PHASES.map(p =>
    `.gantt .bar-wrapper.phase-${p.key} .bar { fill: ${p.color}; stroke: ${p.text}; stroke-width: 1; }
     .gantt .bar-wrapper.phase-${p.key} .bar-progress { fill: ${p.text}; opacity: 0.55; }
     .gantt .bar-wrapper.phase-${p.key} .bar-label { fill: ${p.text}; font-weight: 600; }`
  ).join('\n');

  // Hierarchy-based bar colors — listed AFTER phase rules so they win on equal specificity.
  // Tasks pick the deepest match (sub-dept > combined dept > procurement).
  const hierarchyRules = Object.entries(HIERARCHY_BAR_COLORS).map(([key, c]) =>
    `.gantt .bar-wrapper.bar-color-${key} .bar { fill: ${c.fill}; stroke: ${c.text}; stroke-width: 1; }
     .gantt .bar-wrapper.bar-color-${key} .bar-progress { fill: ${c.text}; opacity: 0.5; }
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

  el.textContent = phaseRules + '\n' + hierarchyRules + '\n' + overAlloc + '\n' + critical;
}

function renderGanttLegend() {
  const legend = document.getElementById('gantt-legend');
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
  const ordered = state.scheduleView?.sortByStart
    ? [...applyFilters(state.tasks)].sort((a, b) =>
        (a.start_date || '￿').localeCompare(b.start_date || '￿')
        || (a.sort_order || 0) - (b.sort_order || 0))
    : sortByPhaseThenOrder(applyFilters(state.tasks));
  // Same Only-critical filter renderTable applies, mirrored here so the Gantt only
  // shows the critical bars + anchor markers when the toggle is on.
  const onlyCrit = state.scheduleView?.criticalOnly && state.scheduleView?.criticalPath;
  const critForFilter = onlyCrit ? computeCriticalPath() : null;
  const filtered = ordered
    .filter(t => t.start_date && t.end_date)
    .filter(t => !isTaskInCollapsedGroup(t))
    .filter(t => inferredAnchorKey(t) || (t.phase_group && validSectionKeys.has(t.phase_group)))
    .filter(t => !critForFilter || critForFilter.has(String(t.id)) || inferredAnchorKey(t));

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

  // Invisible phantom tasks ~30 days before the earliest task and ~30 days after the latest,
  // so the user can pan past either edge enough to put a corner task near the middle.
  const minStart = Math.min(...filtered.map(t => new Date(t.start_date).getTime()));
  const maxEnd   = Math.max(...filtered.map(t => new Date(t.end_date).getTime()));
  const PAD_MS = 30 * 86400000;
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
  drawMilestoneDiamonds();
  drawMilestoneLabels();
  clipBarLabels();
  drawScheduleStatus();
  drawFinancialOverlay();
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
  const factor = next / state.zoomPercent;

  const oldScroller = getGanttScroller();
  const oldScrollLeft = oldScroller ? oldScroller.scrollLeft : 0;
  const viewW = oldScroller ? oldScroller.clientWidth : 0;
  const oldCenterPx = oldScrollLeft + viewW / 2;

  state.zoomPercent = next;
  renderGantt();

  const newScroller = getGanttScroller();
  if (newScroller) newScroller.scrollLeft = factor * oldCenterPx - viewW / 2;
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
  svg.querySelectorAll('.milestone-diamond').forEach(d => d.remove());

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
    // Anchor milestones (Receipt of PO, FAT) render as a CONCENTRIC double-diamond:
    // a larger outline ring around a smaller filled diamond, with a clear gap between
    // them. Distinct shape AND color (red) so they read as project-spine markers from
    // across the chart.
    const isAnchor = !!inferredAnchorKey(task);
    const size = h * (isAnchor ? 1.05 : 0.85);

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
      // Outer ring — pure outline, ~75% larger than the inner diamond, in the anchor
      // text/stroke shade. The gap between inner and outer diamonds is what makes the
      // icon distinct.
      const outerSize = size * 1.75;
      const outerPts = `${cx},${cy - outerSize/2} ${cx + outerSize/2},${cy} ${cx},${cy + outerSize/2} ${cx - outerSize/2},${cy}`;
      const outer = document.createElementNS(SVG_NS, 'polygon');
      outer.setAttribute('points', outerPts);
      outer.setAttribute('class', 'milestone-diamond anchor-outer');
      outer.setAttribute('fill', 'none');
      outer.setAttribute('stroke', ac.text);
      outer.setAttribute('stroke-width', '1.75');
      outer.setAttribute('stroke-linejoin', 'miter');
      wrap.appendChild(outer);
    }

    const points = `${cx},${cy - size/2} ${cx + size/2},${cy} ${cx},${cy + size/2} ${cx - size/2},${cy}`;
    const diamond = document.createElementNS(SVG_NS, 'polygon');
    diamond.setAttribute('points', points);
    diamond.setAttribute('class', 'milestone-diamond' + (isAnchor ? ' anchor-inner' : ''));
    // Non-anchor milestones render as a solid slate-500 diamond — distinct from the
    // lime concentric anchors, neutral enough that it reads as "this is a milestone,
    // but it's NOT one of the four spine markers."
    diamond.setAttribute('fill',   isAnchor ? ac.fill : '#475569');
    diamond.setAttribute('stroke', isAnchor ? ac.text : '#334155');
    diamond.setAttribute('stroke-width', isAnchor ? '1.5' : '1');
    wrap.appendChild(diamond);
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
    // Always center the label inside the bar — frappe-gantt repositions it OUTSIDE
    // (text-anchor=start at bar.right + 5) when the original text was too wide. We
    // override that so labels live inside the bar exclusively.
    label.setAttribute('x', barX + barW / 2);
    label.setAttribute('y', barY + barH / 2);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'middle');

    const fullText = task.name || '';
    // Measure unconstrained.
    label.textContent = fullText;
    let labelW;
    try { labelW = label.getBBox().width; }
    catch (_) { labelW = fullText.length * 6.5; }
    const PAD = 8; // breathing room inside the bar
    if (labelW + PAD <= barW) {
      // Fits — make sure any previous title is cleared.
      const t = wrap.querySelector('title');
      if (t) t.remove();
      continue;
    }
    // Doesn't fit. Binary-search for the longest prefix + ellipsis that fits.
    let lo = 0, hi = fullText.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      label.textContent = fullText.slice(0, mid) + '…';
      let w;
      try { w = label.getBBox().width; }
      catch (_) { w = (mid + 1) * 6.5; }
      if (w + PAD <= barW) lo = mid;
      else hi = mid - 1;
    }
    label.textContent = lo > 0 ? fullText.slice(0, lo) + '…' : '';
    // Hover tooltip with the full name.
    let title = wrap.querySelector('title');
    if (!title) {
      title = document.createElementNS(SVG_NS, 'title');
      wrap.insertBefore(title, wrap.firstChild);
    }
    title.textContent = fullText;
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

  // Milestone labels: always plain text to the right of the diamond. No pill, no
  // alternate-side heuristic — arrows pass underneath via z-order if they overlap.
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
    const r = h * 0.425;
    const labelOffset = 6; // gap between diamond's right vertex and label
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
  }
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
const ARROW_DEFAULTS = { headSize: 6 };
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
  if (Math.abs(exitX - adj.x) < 0.5) {
    linePath = `M ${exitX} ${exitY} L ${exitX} ${adj.y}`;
  } else if (Math.abs(exitY - adj.y) < 0.5) {
    linePath = `M ${exitX} ${exitY} L ${adj.x} ${exitY}`;
  } else if (headDir === 'DOWN' || headDir === 'UP') {
    // Final segment is vertical → corner at (entryX, exitY): horizontal then vertical.
    linePath = `M ${exitX} ${exitY} L ${entryX} ${exitY} L ${entryX} ${adj.y}`;
  } else {
    // Final segment is horizontal → corner at (exitX, entryY): vertical then horizontal.
    linePath = `M ${exitX} ${exitY} L ${exitX} ${entryY} L ${adj.x} ${entryY}`;
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

  return { linePath, headPath };
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

  // Index every bar's geometry. Milestones use the diamond bbox (smaller than the
  // bar-wrapper rect frappe-gantt creates for them).
  const isMilestone = (id) => !!state.tasks.find(t => String(t.id) === String(id))?.is_milestone;
  const bars = [...svg.querySelectorAll('.bar-wrapper')].map(w => {
    const rect = w.querySelector('.bar');
    const id = String(w.getAttribute('data-id'));
    const x = +rect.getAttribute('x');
    const y = +rect.getAttribute('y');
    const ww = +rect.getAttribute('width');
    const hh = +rect.getAttribute('height');
    if (isMilestone(id)) {
      const cx = x + ww / 2;
      const r = hh * 0.425;
      return { id, x: cx - r, y, w: 2 * r, h: hh, milestone: true };
    }
    return { id, x, y, w: ww, h: hh, milestone: false };
  });
  const barById = Object.fromEntries(bars.map(b => [b.id, b]));

  const arrowColor = '#334155';
  const headSize = 6;

  // Build the job list, then group by pred + direction so successors leaving the same
  // side of one pred can stagger their exit y values.
  const arrowJobs = [];
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
    const { linePath, headPath } = computeArrowPath(job.pred, job.succ, job.parsed.type, {
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
  }
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
  // ("behind", "ahead", "milestones only", etc.). Anchors are always exempt so
  // the schedule spine stays visible regardless of which chips are on.
  const chipDefs = [
    { key: 'behind',        label: 'Behind schedule' },
    { key: 'ahead',         label: 'Ahead of schedule' },
    { key: 'milestones',    label: 'Milestones only' },
    { key: 'assigned',      label: 'Assigned (real work)' },
    { key: 'overallocated', label: 'Over-allocated' },
  ];
  pop.innerHTML = `
    <div class="filters-popover-title">Quick filters</div>
    <div class="filters-quick-chips">
      ${chipDefs.map(c => `
        <button type="button" class="filter-chip ${qf[c.key] ? 'is-active' : ''}" data-quick="${c.key}">
          ${escapeHtml(c.label)}
        </button>
      `).join('')}
    </div>
    <div class="filters-popover-actions">
      <button type="button" id="btn-clear-filters" class="btn-ghost btn-tight">Clear all</button>
    </div>
  `;
  pop.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.quick;
      if (!state.filters.quick) state.filters.quick = {};
      state.filters.quick[k] = !state.filters.quick[k];
      render();
    });
  });
  pop.querySelector('#btn-clear-filters').addEventListener('click', () => {
    state.filters.quick = { behind: false, ahead: false, milestones: false, assigned: false, overallocated: false };
    render();
  });
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
}

function saveProjectTabs() {
  localStorage.setItem('sdcOpenProjects', JSON.stringify(state.openProjects));
  localStorage.setItem('sdcActiveProject', state.filters.project || '');
  localStorage.setItem('sdcTemplateProjects', JSON.stringify(state.templateProjects || []));
}

function isTemplateProject(p) {
  return !!p && Array.isArray(state.templateProjects) && state.templateProjects.includes(p);
}

function renderProjectTabs() {
  const wrap = document.getElementById('project-tabs');
  if (!wrap) return;
  wrap.innerHTML = state.openProjects.map(p => {
    const isAll = p === '';
    const isActive = (state.filters.project || '') === p;
    const isTemplate = isTemplateProject(p);
    const label = isAll ? 'All projects' : p;
    // Templates can't be closed via the × — they have to be unmarked first via
    // right-click. The All-projects pseudo-tab also has no close button.
    const close = (isAll || isTemplate) ? ''
      : `<span class="project-tab-close" data-project="${escapeHtml(p)}" title="Close schedule">×</span>`;
    const star  = isTemplate ? '<span class="project-tab-star" title="Template — protected">★</span>' : '';
    const cls = ['project-tab'];
    if (isActive) cls.push('active');
    if (isAll)    cls.push('is-all');
    if (isTemplate) cls.push('is-template');
    return `
      <button class="${cls.join(' ')}" data-project="${escapeHtml(p)}" type="button">
        ${star}<span class="project-tab-label">${escapeHtml(label)}</span>
        ${close}
      </button>`;
  }).join('');

  wrap.querySelectorAll('.project-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.project-tab-close')) return;
      state.filters.project = btn.dataset.project;
      saveProjectTabs();
      render();
    });
    // Right-click → context menu (Duplicate, Mark/Unmark template, Close).
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = btn.dataset.project;
      if (p === '') return; // No actions on the All-projects pseudo-tab.
      showProjectTabMenu(e.clientX, e.clientY, p);
    });
  });
  wrap.querySelectorAll('.project-tab-close').forEach(x => {
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = x.dataset.project;
      if (isTemplateProject(p)) return; // safety: shouldn't render but belt+suspenders
      state.openProjects = state.openProjects.filter(q => q !== p);
      if ((state.filters.project || '') === p) state.filters.project = '';
      saveProjectTabs();
      render();
    });
  });

  // Schedule view's project header: name + task count for the active project. The
  // info strip lives at the LEFT of the toolbar row (alongside layout / zoom / fit
  // controls on the right), so we only replace its INNER text spans, not the row.
  const info = document.querySelector('.schedule-project-info');
  if (info) {
    if (!state.filters.project) {
      // On All-projects: offer a one-click "save EVERYTHING as one project" action.
      // Re-tags every task in the database (regardless of whatever project field
      // each one currently carries) to a single new name. Solves "my data is split
      // across two tabs and I just want one project".
      const total = state.tasks.length;
      const distinctProjects = new Set(state.tasks.map(t => t.project || '__null__')).size;
      const showSaveAll = total > 0 && distinctProjects > 0;
      const saveAllBtn = showSaveAll
        ? `<button id="btn-save-all-as-one" class="orphan-save-btn" type="button" title="Take every task in the database (across every project) and re-tag them under one new project name. The All-projects view becomes a true aggregate.">Save all ${total} task${total === 1 ? '' : 's'} as one project →</button>`
        : '';
      info.innerHTML = '<span class="schedule-project-label">All projects</span>'
        + '<span class="schedule-project-meta">Tasks across every open schedule</span>'
        + saveAllBtn;
      const sb = document.getElementById('btn-save-all-as-one');
      if (sb) sb.addEventListener('click', saveAllAsOneProject);
    } else {
      const p = state.filters.project;
      const n = state.tasks.filter(t => t.project === p).length;
      info.innerHTML = `<span class="schedule-project-label">${escapeHtml(p)}</span>`
        + `<span class="schedule-project-meta">${n} task${n === 1 ? '' : 's'}</span>`
        + `<button type="button" class="project-header-financials" id="btn-header-financials" title="Edit financial milestones for ${escapeHtml(p)}">$ Financials</button>`;
      const finBtn = document.getElementById('btn-header-financials');
      if (finBtn) finBtn.addEventListener('click', () => openFinancialsModal(p));
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
}

// Right-click menu on a project tab. Lets the user rename, duplicate, merge, mark
// as template, close the tab (UI-only), or fully delete the project's data.
function showProjectTabMenu(x, y, project) {
  const isTemplate = isTemplateProject(project);
  const items = [
    { label: 'Rename project…',          onClick: () => renameProject(project) },
    { label: 'Duplicate to new project…', onClick: () => duplicateProject(project) },
    { label: 'Merge another project into this…', onClick: () => mergeAnotherProjectInto(project, x, y) },
    { label: 'Financial milestones…',     onClick: () => openFinancialsModal(project) },
    { label: isTemplate ? 'Unmark as template' : 'Mark as template ★', onClick: () => toggleTemplate(project) },
  ];
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
  if (tasks.length === 0) {
    alert(`"${project}" has no tasks to delete.`);
    return;
  }
  const ok = confirm(
    `Delete EVERY task in "${project}"?\n\n`
    + `${tasks.length} task${tasks.length === 1 ? '' : 's'} will be permanently removed, `
    + `including its anchor milestones. This can't be undone.`);
  if (!ok) return;
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
  // Migrate the open-tabs list and the template flag so the new name keeps the
  // exact same UI state the old one had.
  state.openProjects = state.openProjects.map(p => p === oldName ? trimmed : p);
  if (isTemplateProject(oldName)) {
    state.templateProjects = state.templateProjects.map(p => p === oldName ? trimmed : p);
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
async function duplicateProject(source) {
  const newName = prompt(`Duplicate "${source}" to a new project named:`, `${source}_copy`);
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
  const unopened = all.filter(p => !state.openProjects.includes(p));
  const pop = document.createElement('div');
  pop.id = 'project-add-picker';
  pop.className = 'project-add-picker';
  // Anchor the popup to the button's RIGHT edge so it can never run off the right
  // side of the screen. Falls back to button.left if the popup would clip the left.
  const POPUP_W = 320;
  const desiredLeft = r.right - POPUP_W;
  const safeLeft = Math.max(8, Math.min(desiredLeft, window.innerWidth - POPUP_W - 8));
  pop.style.left = safeLeft + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
  pop.style.width = POPUP_W + 'px';
  pop.innerHTML = `
    <div class="picker-section-title">Open existing schedule <span class="picker-section-hint">(right-click to delete)</span></div>
    ${unopened.length === 0 ? '<div class="picker-empty">No other projects yet.</div>' :
      unopened.map(p => `<button class="picker-row" data-project="${escapeHtml(p)}" type="button">${escapeHtml(p)}</button>`).join('')}
    <div class="picker-divider"></div>
    <div class="picker-section-title">Or start a new schedule</div>
    <div class="picker-new-row">
      <input type="text" class="picker-new-input" placeholder="e.g. Job 2026-015 — Sample Project" />
      <button class="btn-primary picker-new-btn" type="button">Open</button>
    </div>`;
  document.body.appendChild(pop);
  pop.querySelectorAll('.picker-row').forEach(row => {
    row.addEventListener('click', () => {
      const p = row.dataset.project;
      if (!state.openProjects.includes(p)) state.openProjects.push(p);
      state.filters.project = p;
      saveProjectTabs();
      pop.remove();
      render();
    });
    // Right-click any closed-project row to delete it permanently. Skips templates
    // (they're protected from accidental loss). Shares the same deleteProject path
    // as the project tab's right-click delete, so one cleanup story.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = row.dataset.project;
      if (isTemplateProject(p)) {
        alert(`"${p}" is marked as a template. Open it, right-click the tab, and unmark it before deleting.`);
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

function render() {
  renderProjectTabs();
  renderFilters();
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

async function deleteTaskById(id) {
  // Anchor milestones (Receipt of PO, FAT) are project-spine markers and aren't deletable.
  const t = state.tasks.find(x => x.id === id);
  if (t && t.anchor_key) {
    alert(`"${t.name}" is an anchor milestone and can't be deleted. You can edit its date, predecessors, and progress like any other task.`);
    return;
  }
  if (!confirm('Delete this task? This cannot be undone.')) return;
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
  showContextMenu(e.clientX, e.clientY, [
    { label: 'Move to section…', onClick: () => moveTaskInline(id, e.clientX, e.clientY) },
    { label: 'Delete task', danger: true, onClick: () => deleteTaskById(id) },
  ]);
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

    // Show on Gantt checkbox — drives the same state.showFinancials flag the toolbar
    // toggle uses. Re-renders the Gantt immediately so the user sees the overlay
    // appear/disappear without closing the modal.
    const showCb = modal.querySelector('#financials-show-on-gantt');
    if (showCb) {
      showCb.addEventListener('change', async () => {
        state.showFinancials = showCb.checked;
        const finBtn = document.getElementById('btn-financial');
        if (finBtn) finBtn.classList.toggle('is-active', state.showFinancials);
        saveScheduleView();
        if (state.showFinancials) await loadFinancialsForAllOpenProjects();
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
        if (!confirm(`Delete "${row?.name || 'this milestone'}"?`)) return;
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

function showSectionPicker(x, y, onPick) {
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
    <div class="section-picker-title">Where should this task go?</div>
    <select class="sp-group">
      <option value="">— phase group —</option>
      ${HIERARCHY.map(g => `<option value="${g.key}">${escapeHtml(g.label)}</option>`).join('')}
    </select>
    <select class="sp-dept" disabled><option value="">— pick phase group first —</option></select>
    <select class="sp-sub" disabled><option value="">— optional —</option></select>
    <div class="section-picker-hint">Leave department blank for a cross-cutting task (e.g. FAT) that spans the whole phase.</div>
    <div class="section-picker-actions">
      <button type="button" class="btn-ghost sp-cancel">Cancel</button>
      <button type="button" class="btn-primary sp-create">Create</button>
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
  if (settings.theme) applyTheme(settings.theme);
  applySectionColors(state.settings.section_colors);
  applyHierarchyColors(state.settings.hierarchy_colors);
  applyAnchorColor(state.settings.anchor_color);
  if (Array.isArray(settings.phases) && settings.phases.length) {
    window.PHASES = settings.phases;
    window.PHASE_BY_KEY = Object.fromEntries(settings.phases.map(p => [p.key, p]));
  }
}

// ---------- Team view ----------
// Four cards (one per discipline). Each card lists active members with an editable name
// and a delete button, plus an "+ Add member" button at the bottom.
function renderTeam() {
  const grid = document.getElementById('team-grid');
  if (!grid) return;
  grid.innerHTML = DISCIPLINES.map(disc => {
    // Sort: real people first (by sort_order), placeholders to the BOTTOM. They're
    // role markers, not staff, so they read as a separate group within each card.
    const members = state.team.filter(m => m.discipline === disc.key)
      .sort((a, b) => {
        const aPh = isPlaceholder(a.name) ? 1 : 0;
        const bPh = isPlaceholder(b.name) ? 1 : 0;
        if (aPh !== bPh) return aPh - bPh;
        return (a.sort_order || 0) - (b.sort_order || 0);
      });
    const rows = members.map(m => {
      const ph = isPlaceholder(m.name);
      return `
      <li class="team-member${ph ? ' is-placeholder' : ''}" data-id="${m.id}">
        <input type="text" class="team-member-name" value="${escapeHtml(m.name)}" data-id="${m.id}" />
        <button type="button" class="remove-btn" data-action="remove-member" data-id="${m.id}" title="Remove">×</button>
      </li>`;
    }).join('');
    return `
      <section class="team-card" data-discipline="${disc.key}">
        <header class="team-card-head" style="background:${disc.color};color:${disc.text}">
          <h3>${escapeHtml(disc.label)}</h3>
          <span class="team-count">${members.length}</span>
        </header>
        <ul class="team-list">${rows}</ul>
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
  const projFilter = state.resources.project;
  return state.tasks.filter(t =>
    t.assignee === memberName &&
    t.start_date && t.end_date &&
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

function renderResources() {
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

  // Build the active member list for the selected discipline.
  const members = state.team
    .filter(m => m.discipline === state.resources.discipline && m.active !== 0)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

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
      const c = projectColorFor(task.project);
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
        <div class="res-bar${lowAllocClass}${overClass}" style="left:${x}px;top:${y}px;width:${w}px;height:${BAR_H}px;background:${c.fill};border-color:${c.stroke};color:${c.text};"
             title="${escapeHtml(tip)}"
             data-task-id="${task.id}">
          ${priPill}
          <span class="res-bar-label">${escapeHtml(labelText)}</span>
        </div>`;
    }).join('');
    const totalDuration = tasks.reduce((sum, t) => sum + Math.max(1, Math.round((new Date(t.end_date) - new Date(t.start_date)) / 86400000) + 1), 0);
    const peakLabel = peakLoad != null ? ` · <span class="res-overload-pill">peak ${peakLoad}%</span>` : '';
    html += `
      <div class="resources-row${peakLoad != null ? ' has-overload' : ''}${ph ? ' is-placeholder' : ''}" style="height:${rowH}px">
        <div class="resources-name-cell">
          <span class="resources-name">${escapeHtml(m.name)}</span>
          <span class="resources-meta">${tasks.length} task${tasks.length === 1 ? '' : 's'}${tasks.length ? ` · ${totalDuration}d` : ''}${peakLabel}</span>
        </div>
        <div class="resources-track" style="width:${tlWidth}px">${overloadHtml}${bars}${loadHtml}</div>
      </div>`;
  }
  html += `</div>`;
  body.innerHTML = html;

  // Legend = unique projects currently shown
  const projects = [...new Set(allTasks.map(t => t.project).filter(Boolean))].sort();
  const legend = document.getElementById('resources-legend');
  legend.innerHTML = projects.map(p => {
    const c = projectColorFor(p);
    return `<span class="legend-item"><span class="legend-swatch" style="background:${c.fill};border:1px solid ${c.stroke}"></span>${escapeHtml(p)}</span>`;
  }).join('');

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
// Anchor milestones — hard-coded project-spine markers. Four of them, in order:
//   - Receipt of PO     → kicks the project off (above section 10 in the grid)
//   - Machine Power-Up  → inside section 10 → Shop → Wire (END of wire work — the
//                         moment the panel turns on. Stays in the flow of work, not
//                         hoisted to a separate row, but still rendered with anchor
//                         styling: concentric diamond, name chip in grid).
//   - FAT               → end of section 40 (gates teardown)
//   - Ship Machine      → between teardown and install inside section 50
// Auto-created per project; can't be deleted. They render as concentric diamonds
// in the anchor color, separately from regular milestones. Machine Power-Up is the
// only anchor that lives WITHIN a regular hierarchy bucket — the others sit above
// or between sections as standalone rows.
const ANCHOR_DEFS = [
  { key: 'receipt_of_po',    name: 'Receipt of PO',    defaultOffsetDays: 0  },
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
  if (n === 'machine power-up' || n === 'machine powerup' || n === 'machine power up') return 'machine_power_up';
  if (n === 'fat')                                        return 'fat';
  if (n === 'ship machine')                               return 'ship_machine';
  return null;
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
  const oldest = {};
  for (const t of all) {
    const k = inferredAnchorKey(t);
    if (!k) continue;
    if (!(k in oldest) || t.id < oldest[k]) oldest[k] = t.id;
  }
  return all
    .filter(t => {
      const k = inferredAnchorKey(t);
      return !k || t.id === oldest[k];
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
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'setup') renderSetup();
  else if (view === 'team') renderTeam();
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
const DEFAULT_COL_WIDTHS = { line: 36, id: 50, name: 280, assignee: 110, start: 90, finish: 90, duration: 80, pred: 110, progress: 110, allocation: 52, priority: 44 };
// Per-column hard floors used by the resize handle. Line column is tight enough that
// you can't drag below "the number is still legible". Allocation only ever holds "100%"
// in the body and "ALLOC" in the header, so its floor is just-wider-than-the-header.
const COL_MIN_WIDTHS = { line: 30, name: 80, assignee: 60, start: 70, finish: 70, duration: 50, pred: 60, progress: 60, allocation: 44, priority: 36 };
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
];
// Columns we don't auto-show when introducing a column. The user can still toggle them
// on from the columns menu — they just don't appear by default for fresh installs and
// aren't force-shown for existing users on app load. Priority is hidden by default
// because the Resources view's pill is the primary editor.
const DEFAULT_HIDDEN_COLS = new Set(['line', 'priority']);

// Bump LAYOUT_VERSION whenever we change a default column width that existing users have
// already cached in localStorage. The migration block below resets only the affected
// column so we don't blow away anything else they've customized.
const LAYOUT_VERSION = 2;

function loadLayout() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('sdcSchedulerLayout') || '{}'); } catch {}

  // Migration: tighten the Allocation column to its new compact default. Drops the saved
  // width so the merge below picks up DEFAULT_COL_WIDTHS.allocation instead.
  if ((saved.layoutVersion || 1) < 2) {
    if (saved.colWidths && 'allocation' in saved.colWidths) delete saved.colWidths.allocation;
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
    return `<th class="${colClass(k)}" data-col="${k}" draggable="true">
              <span class="th-label">${escapeHtml(def.label)}</span><span class="col-resize-handle" draggable="false"></span>
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
    // showFinancials is persisted alongside the schedule-view flags but lives on
    // state.showFinancials (not state.scheduleView) since the overlay isn't a
    // section-rendering mode — it's an extra layer. Hydrate it as a side effect.
    state.showFinancials = !!saved.showFinancials;
    return {
      flatten:      !!saved.flatten,
      sortByStart:  !!saved.sortByStart,
      ganttOnly:    !!saved.ganttOnly,
      criticalPath: !!saved.criticalPath,
      criticalOnly: !!saved.criticalOnly,
    };
  } catch {
    return { flatten: false, sortByStart: false, ganttOnly: false, criticalPath: false, criticalOnly: false };
  }
}
function saveScheduleView() {
  try { localStorage.setItem(SCHED_VIEW_KEY, JSON.stringify({ ...state.scheduleView, showFinancials: state.showFinancials })); } catch {}
}
function applyScheduleView() {
  const setActive = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('is-active', !!on);
  };
  setActive('btn-flatten',    state.scheduleView.flatten);
  setActive('btn-sort-start', state.scheduleView.sortByStart);
  setActive('btn-critical',   state.scheduleView.criticalPath);
  setActive('btn-critical-only', state.scheduleView.criticalOnly);
  // The "Only" half of the critical segmented pair is gated on critical being on.
  // When critical is off, dim "Only" so it reads as a sub-mode of the left button.
  const onlyBtn = document.getElementById('btn-critical-only');
  if (onlyBtn) onlyBtn.classList.toggle('is-disabled', !state.scheduleView.criticalPath);
  // The pane class (.gantt-only) on schedule-split is owned by applyGanttVisibility
  // — it knows about both showGantt and ganttOnly. Just delegate.
  applyGanttVisibility();
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
}

// Bar height tracks row height: bar fills ~half the row, the rest is padding.
function getGanttBarMetrics() {
  const rh = state.layout.rowHeight;
  // frappe-gantt total per-row = bar_height + padding, so we split rh between them.
  const bar_height = Math.max(BAR_H_MIN, Math.round(rh * 0.5));
  const padding = Math.max(8, rh - bar_height);
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

function renderColumnsMenu() {
  const menu = document.getElementById('columns-menu');
  if (!menu) return;
  const visible = new Set(state.layout.visibleCols);
  menu.innerHTML = COLUMN_DEFS.map(c => `
    <label>
      <input type="checkbox" data-col="${c.key}" ${visible.has(c.key) ? 'checked' : ''} ${c.key === 'name' ? 'disabled' : ''} />
      ${escapeHtml(c.label)}
    </label>`).join('');
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

// Set the schedule pane layout. 'grid' = grid only (Gantt hidden). 'both' = split.
// 'gantt' = Gantt full-width (grid hidden). The two existing flags drive everything;
// this just keeps them in sync and re-applies styles + re-renders the Gantt.
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
  // Pane mode segmented control — Grid / Both / Gantt. Mutually exclusive.
  document.querySelectorAll('.seg-btn[data-pane]').forEach(btn => {
    btn.addEventListener('click', () => setPaneMode(btn.dataset.pane));
  });
  // View-mode toggles in the schedule toolbar — Flatten / By date / Critical / Only.
  document.getElementById('btn-flatten')      .addEventListener('click', () => toggleScheduleView('flatten'));
  document.getElementById('btn-sort-start')   .addEventListener('click', () => toggleScheduleView('sortByStart'));
  // The Critical / Only pair are linked: turning Critical off also turns Only off,
  // and clicking Only while Critical is dim auto-enables Critical first.
  document.getElementById('btn-critical').addEventListener('click', () => {
    const turningOff = state.scheduleView.criticalPath;
    state.scheduleView.criticalPath = !turningOff;
    if (turningOff) state.scheduleView.criticalOnly = false;
    saveScheduleView();
    applyScheduleView();
    render();
  });
  document.getElementById('btn-critical-only').addEventListener('click', () => {
    if (!state.scheduleView.criticalPath) state.scheduleView.criticalPath = true;
    toggleScheduleView('criticalOnly');
  });

  // $ Financial — toggles the financial milestones overlay on the Gantt. Loads
  // financial data for all open projects on first turn-on (seeds defaults for any
  // project that has none yet via api.financials.seed). State is persisted via
  // saveScheduleView so the toggle sticks across reloads.
  const finBtn = document.getElementById('btn-financial');
  if (finBtn) {
    finBtn.classList.toggle('is-active', !!state.showFinancials);
    finBtn.addEventListener('click', async () => {
      state.showFinancials = !state.showFinancials;
      finBtn.classList.toggle('is-active', state.showFinancials);
      saveScheduleView();
      if (state.showFinancials) await loadFinancialsForAllOpenProjects();
      renderGantt();
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
  document.getElementById('btn-add-project').addEventListener('click', showProjectAddPicker);

  // Zoom-to-fit button — zoomToFit reads the visible task span and snaps the Gantt zoom
  // so it all fits in the viewport. Wheel-zoom still works for finer adjustments.
  document.getElementById('btn-zoom-fit').addEventListener('click', zoomToFit);

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
