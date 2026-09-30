(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PortalCalc = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
/**
 * portalCalc.js — the ONE copy of the Portal tab's analytics math, shared by
 * both sides that need it:
 *   - public/app.js (the browser, staff view) — loads this via a <script>
 *     tag (see index.html) as the global `PortalCalc`, and calls it from
 *     thin wrapper functions that still read `state.tasks` etc. themselves
 *     (this file has no idea what `state` is — it only takes plain rows).
 *   - routes/portal.js (the server, customer-facing dashboard) — requires
 *     this file directly and calls it with rows read from MySQL.
 *
 * Before this file existed, these formulas were hand-ported into a second
 * file (lib/portalCalc.js) and kept "in sync by hand" — which is exactly
 * how drift happens: inferredAnchorKey() below was missing the
 * parts_panel_ready branch that public/app.js's copy already had, silently,
 * until this file unified the two. There is now only one place to change
 * this math; app.js's wrappers and the customer dashboard both call it.
 *
 * Every formula here was verified line-for-line against public/app.js and
 * cross-checked against live data for real projects (1160_Y Site Automation,
 * 1150/1164_Centrus Energy) before being trusted.
 */

const PORTAL_ANCHOR_KEYS = new Set([
  'receipt_of_po', 'mech_release_1', 'machine_power_up', 'fat', 'ship_machine', 'sat',
]);

// Anchors that describe the JOB rather than one machine, so every machine
// reports them whichever machine the row happens to be tagged to.
const PORTAL_PROJECT_WIDE_ANCHORS = new Set(['receipt_of_po']);

// De-duplicate anchor milestones (Receipt of PO, FAT, ...) PER (project,
// machine, anchor_key) — keeps the lowest id of each so a stray duplicate
// row (e.g. two "SAT" tasks on the same job) doesn't inflate every count
// that touches it. Also remaps legacy phase_group/department values left
// over from earlier restructures. Ported from public/app.js's dedupAnchors().
function normalizeTasks(all) {
  const oldest = {};
  for (const t of all) {
    const k = inferredAnchorKey(t);
    if (!k) continue;
    const scope = `${t.project || ''}::${t.machine || ''}::${k}`;
    if (!(scope in oldest) || t.id < oldest[scope]) oldest[scope] = t.id;
  }
  return all
    .filter(t => {
      const k = inferredAnchorKey(t);
      if (!k) return true;
      return t.id === oldest[`${t.project || ''}::${t.machine || ''}::${k}`];
    })
    .map(t => {
      if (t.phase_group === 'teardown') return { ...t, phase_group: 'teardown_install', department: t.department || 'teardown' };
      if (t.phase_group === 'install') return { ...t, phase_group: 'teardown_install', department: t.department || 'install' };
      if (t.phase_group === 'teardown_install' && (t.department === 'engineering' || t.department === 'shop') && !t.sub_department) {
        return { ...t, sub_department: t.department, department: 'install' };
      }
      if (t.phase_group === 'teardown_install' && !t.department) return { ...t, department: 'teardown' };
      return t;
    });
}

// Match an existing task to an anchor by either anchor_key (when the column
// has been populated) OR by name (fallback for tasks created before the
// column existed). Kept byte-for-byte identical to public/app.js's copy.
function inferredAnchorKey(t) {
  if (t.anchor_key && t.anchor_key !== 'backlog') return t.anchor_key;
  const n = String(t.name || '').trim().toLowerCase();
  if (n === 'receipt of po') return 'receipt_of_po';
  if (n === 'mech 1 release' || n === 'mech release 1' || n === 'mech1 release') return 'mech_release_1';
  if (n === 'machine power-up' || n === 'machine powerup' || n === 'machine power up') return 'machine_power_up';
  if (n === 'fat') return 'fat';
  if (n === 'ship machine') return 'ship_machine';
  if (n === 'sat' || n === 'acceptance at customer (sat)') return 'sat';
  if (/^parts\s*(\+|and|&)\s*drawings\s+for\s+panel\s+(build\s+)?ready$/.test(n)
      || /^parts\s*(\+|and|&)\s*drawings\s+ready\s+for\s+panel(\s+build)?$/.test(n)) return 'parts_panel_ready';
  return null;
}
function isMilestoneLike(t) { return PORTAL_ANCHOR_KEYS.has(inferredAnchorKey(t)); }

function ymdLocal(d) { return d.toISOString().slice(0, 10); }

// Percent complete, weighted by scheduled days (public/app.js _portalPercent).
function portalPercent(rows) {
  let planned = 0, done = 0;
  rows.forEach(t => {
    if (isMilestoneLike(t)) return;
    const d = Math.max(Number(t.duration_days) || 0, 0.5);
    planned += d;
    done += d * Math.min(Math.max(Number(t.progress) || 0, 0), 100) / 100;
  });
  if (!planned) return null;
  return Math.round((done / planned) * 100);
}

// Share of the plan due by today (public/app.js _portalPlannedPercent).
function portalPlannedPercent(rows, todayStr) {
  const now = new Date((todayStr || ymdLocal(new Date())) + 'T00:00:00').getTime();
  let planned = 0, due = 0;
  rows.forEach(t => {
    if (isMilestoneLike(t)) return;
    const d = Math.max(Number(t.duration_days) || 0, 0.5);
    planned += d;
    const a = t.start_date ? new Date(t.start_date + 'T00:00:00').getTime() : NaN;
    const b = t.end_date ? new Date(t.end_date + 'T00:00:00').getTime() : NaN;
    if (!isFinite(a) || !isFinite(b)) return;
    if (now >= b) { due += d; return; }
    if (now <= a) return;
    const span = b - a;
    due += span > 0 ? d * ((now - a) / span) : d;
  });
  if (!planned) return null;
  return Math.round((due / planned) * 100);
}

const PORTAL_PROGRESS_PHASES = [
  { label: 'Kickoff', g: 'kickoff' },
  { label: 'Mechanical engineering', g: 'design_build', d: 'engineering', sub: 'mech' },
  { label: 'Controls engineering', g: 'design_build', d: 'engineering', sub: 'controls' },
  { label: 'General engineering', g: 'design_build', d: 'engineering', sub: 'general' },
  { label: 'Procurement', g: 'design_build', d: 'procurement' },
  { label: 'Build', g: 'design_build', d: 'shop', sub: 'build' },
  { label: 'Wiring', g: 'design_build', d: 'shop', sub: 'wire' },
  { label: 'Testing', g: 'machine_testing' },
  { label: 'Teardown & install', g: 'teardown_install' },
];

function portalProgress(rows) {
  const overall = portalPercent(rows);
  if (overall == null) return null;
  const planned = portalPlannedPercent(rows);
  const gap = planned == null ? null : overall - planned;
  const phases = PORTAL_PROGRESS_PHASES.map(ph => {
    const mine = rows.filter(t => t.phase_group === ph.g
      && (!ph.d || t.department === ph.d)
      && (!ph.sub || t.sub_department === ph.sub));
    const pct = portalPercent(mine);
    if (pct == null) return null;
    return { label: ph.label, pct };
  }).filter(Boolean);
  return { overall, planned, gap, phases };
}

// ── Event status (public/app.js taskScheduleDelta / portalWork / _portalTaskMix
//    / _portalDeptChartHtml / _portalWorkHtml) ──────────────────────────────

function isWeekendDate(d) { const day = d.getUTCDay(); return day === 0 || day === 6; }

function snapToBusinessDay(dateStr, dir = 1) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  while (isWeekendDate(d)) d.setUTCDate(d.getUTCDate() + (dir > 0 ? 1 : -1));
  return d.toISOString().slice(0, 10);
}

function businessDaysBetween(start, end) {
  if (!start || !end) return null;
  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  if (isNaN(s) || isNaN(e) || e < s) return null;
  let count = 0;
  const cur = new Date(s);
  while (cur <= e) { if (!isWeekendDate(cur)) count++; cur.setUTCDate(cur.getUTCDate() + 1); }
  return count;
}

// isBacklogTask() is gutted everywhere in the app (Backlog special-casing
// was removed) — only isBacklogRow (a task literally NAMED "Backlog") still
// derives its % from the calendar. Mirrors public/app.js's getEffectiveProgress.
function isBacklogRow(t) { return String(t && t.name || '').trim().toLowerCase() === 'backlog'; }
function getEffectiveProgress(t) {
  const raw = Math.max(0, Math.min(100, Number(t && t.progress) || 0));
  if (!isBacklogRow(t) || !t.start_date || !t.end_date) return raw;
  const today = ymdLocal(new Date());
  if (today >= t.end_date) return 100;
  if (today <= t.start_date) return 0;
  const ms = (s) => new Date(s + 'T00:00:00Z').getTime();
  const span = ms(t.end_date) - ms(t.start_date);
  return span > 0 ? Math.round(((ms(today) - ms(t.start_date)) / span) * 100) : raw;
}

// projectIsSales: true when this task's project lives in the Sales
// workspace — pre-quote work has nothing to be ahead of or behind yet.
function taskScheduleDelta(task, projectIsSales) {
  if (!task || task.is_milestone || !task.start_date || !task.end_date) return 0;
  if (inferredAnchorKey(task)) return 0;
  if (projectIsSales) return 0;
  const actualPct = getEffectiveProgress(task);
  if (actualPct >= 100) return 0;
  const totalDays = businessDaysBetween(task.start_date, task.end_date);
  if (!totalDays || totalDays <= 0) return 0;
  const remainingBD = Math.max(0, Math.round((1 - actualPct / 100) * totalDays));
  const todayISO = ymdLocal(new Date());
  const snappedToday = snapToBusinessDay(todayISO, 1);
  const projectedFinish = remainingBD === 0 ? snappedToday : addBusinessDays(snappedToday, remainingBD - 1);
  if (!projectedFinish) return 0;
  let drift = 0;
  if (projectedFinish < task.end_date) {
    const span = businessDaysBetween(projectedFinish, task.end_date) || 0;
    drift = Math.max(0, span - 1);
  } else if (projectedFinish > task.end_date) {
    const span = businessDaysBetween(task.end_date, projectedFinish) || 0;
    drift = -Math.max(0, span - 1);
  }
  if (actualPct <= 0 && drift >= 0) return 0;
  return drift;
}

function portalDrift(t, projectIsSales) {
  let d = 0;
  try { d = taskScheduleDelta(t, projectIsSales) || 0; } catch (_) { d = 0; }
  if (!d) return null;
  const wks = (Math.round((Math.abs(d) / 5) * 2) / 2) || 0.5;
  return d > 0 ? { text: '+' + wks + 'w ahead', cls: 'is-ahead' } : { text: '−' + wks + 'w behind', cls: 'is-behind' };
}

function portalLate(due, today) {
  if (!due || !today || due >= today) return null;
  const days = Math.round((new Date(today + 'T00:00:00') - new Date(due + 'T00:00:00')) / 86400000);
  const wks = Math.round((days / 5) * 2) / 2 || 0.5;
  return { text: '−' + wks + 'w behind', cls: 'is-behind' };
}

const PORTAL_BEHIND_WEEKS = 1;
function portalLateWeeks(t, today, projectIsSales) {
  let days = 0;
  const due = t.end_date || '';
  if (due && today && due < today) {
    days = Math.round((new Date(today + 'T00:00:00') - new Date(due + 'T00:00:00')) / 86400000);
  }
  let drift = 0;
  try { drift = taskScheduleDelta(t, projectIsSales) || 0; } catch (_) { drift = 0; }
  if (drift < 0) days = Math.max(days, Math.abs(drift));
  if (!days) return 0;
  return Math.round((days / 5) * 2) / 2;
}

function portalRowState(t, today, projectIsSales) {
  const pct = Number(t.progress) || 0;
  if (pct >= 100) return 'complete';
  if (portalLateWeeks(t, today, projectIsSales) >= PORTAL_BEHIND_WEEKS) return 'behind';
  return pct > 0 ? 'running' : 'notStarted';
}

function portalTaskMix(rows, projectIsSales) {
  const today = ymdLocal(new Date());
  const mix = { complete: 0, running: 0, behind: 0, notStarted: 0 };
  rows.forEach(t => {
    if (!(t.name || '').trim()) return;
    mix[portalRowState(t, today, projectIsSales)]++;
  });
  return mix;
}

function portalDeptChart(rows, projectIsSales) {
  const today = ymdLocal(new Date());
  return PORTAL_PROGRESS_PHASES.map(ph => {
    const mine = rows.filter(t => t.phase_group === ph.g
      && (!ph.d || t.department === ph.d)
      && (!ph.sub || t.sub_department === ph.sub)
      && (t.name || '').trim());
    if (!mine.length) return null;
    const done = mine.filter(t => portalRowState(t, today, projectIsSales) === 'complete').length;
    return { label: ph.label, pct: Math.round((done / mine.length) * 100), text: done + '/' + mine.length };
  }).filter(Boolean);
}

// recentDays: how far back "completed recently" looks (default 30, matches
// the internal Portal tab's default window).
function portalWork(rows, projectIsSales, recentDays) {
  const today = ymdLocal(new Date());
  const cut = new Date(); cut.setDate(cut.getDate() - (recentDays || 30));
  const cutISO = ymdLocal(cut);
  const behind = [], running = [], recent = [];
  rows.forEach(t => {
    const pct = Number(t.progress) || 0;
    const name = (t.name || '').trim();
    if (!name) return;
    const assignee = (t.assignee || '').trim();
    const due = t.end_date || '';
    const drift = portalDrift(t, projectIsSales);
    const row = { name, assignee, pct, due: due || null, dueText: fmtDate(due), drift, when: null, whenText: null };
    switch (portalRowState(t, today, projectIsSales)) {
      case 'complete': {
        const when = t.completed_on || t.end_date || '';
        if (when && when >= cutISO) recent.push({ ...row, drift: null, when, whenText: fmtDate(when) });
        break;
      }
      case 'behind':
        behind.push({ ...row, drift: drift || portalLate(due, today) });
        break;
      case 'running':
        running.push(row);
        break;
      default:
        break;
    }
  });
  behind.sort((a, b) => a.due.localeCompare(b.due));
  recent.sort((a, b) => b.when.localeCompare(a.when));
  running.sort((a, b) => b.pct - a.pct);
  return { behind, running, recent };
}

// A machine is a deliverable with its own FAT (public/app.js portalUnits).
function portalUnits(rows) {
  const machines = [...new Set(rows.map(t => t.machine).filter(Boolean))].sort();
  if (!machines.length) return [{ machine: null, label: '', rows }];
  // Untagged rows are shared, and so are the job-wide anchors however they
  // are tagged — see PORTAL_PROJECT_WIDE_ANCHORS.
  const jobWide = (t) => PORTAL_PROJECT_WIDE_ANCHORS.has(inferredAnchorKey(t) || t.anchor_key || '');
  const shared = rows.filter(t => !t.machine || jobWide(t));
  const sharedIds = new Set(shared.map(t => t.id));
  return machines.map(m => ({
    machine: m,
    label: m,
    // Filter by id, not by identity: a job-wide anchor tagged to THIS
    // machine is already in `shared`, and adding it twice would double it
    // in every count that walks these rows.
    rows: rows.filter(t => t.machine === m && !sharedIds.has(t.id)).concat(shared),
  }));
}

// Every milestone on a unit, in date order (public/app.js portalMilestones).
function portalMilestones(rows) {
  const today = ymdLocal(new Date());
  return rows
    .filter(t => t.is_milestone || t.anchor_key || inferredAnchorKey(t))
    .map(t => {
      const key = inferredAnchorKey(t) || t.anchor_key || null;
      const done = (Number(t.progress) || 0) >= 100;
      const committed = t.baseline_end_date || t.baseline_start_date || null;
      const current = t.start_date || t.end_date || null;
      let slip = null;
      if (committed && current) {
        slip = Math.round((new Date(current + 'T00:00:00') - new Date(committed + 'T00:00:00')) / 86400000);
      }
      return { key, label: (t.name || '').trim(), done, committed, current, slip, past: !done && current && current < today };
    })
    .filter(m => m.current)
    .sort((a, b) => a.current.localeCompare(b.current));
}

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
}

// public/app.js portalSlip — "on date" / "+Nw late" / "-Nw early" / "no baseline".
function portalSlip(ms) {
  if (!ms) return { text: '—', cls: '' };
  if (ms.slip == null) return { text: 'no baseline', cls: 'is-none' };
  if (ms.slip === 0) return { text: 'on date', cls: 'is-ok' };
  const wks = Math.round((Math.abs(ms.slip) / 5) * 2) / 2 || 0.5;
  return ms.slip > 0 ? { text: '+' + wks + 'w late', cls: 'is-late' } : { text: '−' + wks + 'w early', cls: 'is-ok' };
}

const PORTAL_KEY_DATES = [
  { key: 'receipt_of_po', label: 'Receipt of PO' },
  { key: 'machine_power_up', label: 'Machine Power-Up' },
];

function portalDueRow(unit) {
  const ms = portalMilestones(unit.rows);
  const fat = ms.find(m => m.key === 'fat') || null;
  const slip = portalSlip(fat);
  const keyDates = PORTAL_KEY_DATES.map(k => {
    const m = ms.find(x => x.key === k.key) || null;
    return { key: k.key, label: k.label, date: m ? m.current : null, dateText: fmtDate(m && m.current), done: !!(m && m.done), past: !!(m && m.past) };
  });
  return {
    machine: unit.machine,
    label: unit.label,
    pct: portalPercent(unit.rows),
    keyDates,
    fatQuoted: fat ? fat.committed : null,
    fatQuotedText: fmtDate(fat && fat.committed),
    fatProjected: fat ? fat.current : null,
    fatProjectedText: fmtDate(fat && fat.current),
    fatDone: !!(fat && fat.done),
    fatPast: !!(fat && fat.past),
    variance: slip,
  };
}

// ── Payment milestone due-date resolution (public/app.js resolveFinancialTrigger
//    / computeFinancialTriggerDate / financialAnchorTask / financialDueDate /
//    addBusinessDaysClient) ───────────────────────────────────────────────────

function addBusinessDays(dateStr, n) {
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

const FIN_TRIGGER_ALIASES = {
  po: 'receipt_of_po', 'receipt of po': 'receipt_of_po', receipt: 'receipt_of_po',
  'power-up': 'machine_power_up', 'power up': 'machine_power_up', powerup: 'machine_power_up',
  pu: 'machine_power_up', 'machine power-up': 'machine_power_up',
  fat: 'fat', ship: 'ship_machine', 'ship machine': 'ship_machine', sat: 'sat',
};

// tasksById: Map<id, task>, tasksForProject: task[] for the one project (used
// for the legacy bare-line-number fallback, which this port skips — every
// financial trigger created going forward stores "#<id>", per app.js's own
// comment; bare-line-number support is a client-only migration shim for
// pre-existing rows edited in the staff grid, not something a read-only
// customer view needs to reproduce).
function resolveFinancialTrigger(ref, tasksById, tasksForProject) {
  if (!ref) return null;
  const trimmed = String(ref).trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(.+?)(?:\s*(FS|SS|FF|SF))?(?:\s*([+-]\s*\d+)\s*([wd])?)?$/i);
  if (!m) return null;
  const prefix = m[1].trim();
  const type = (m[2] || 'FS').toUpperCase();
  let lagDays = 0;
  if (m[3]) {
    const n = Number(m[3].replace(/\s+/g, ''));
    lagDays = (m[4] || 'd').toLowerCase() === 'w' ? n * 5 : n;
  }
  let target = null;
  const aliasKey = FIN_TRIGGER_ALIASES[prefix.toLowerCase()];
  if (aliasKey) target = tasksForProject.find(t => inferredAnchorKey(t) === aliasKey);
  if (!target && prefix.startsWith('#')) {
    const id = Number(prefix.slice(1));
    if (Number.isInteger(id)) target = tasksById.get(id) || null;
  }
  if (!target) return null;
  const baseDate = (type === 'FS' || type === 'FF') ? target.end_date : target.start_date;
  if (!baseDate) return null;
  const shift = lagDays + (type === 'FS' ? 1 : 0);
  return shift === 0 ? baseDate : addBusinessDays(baseDate, shift);
}

function financialDueDate(f, tasksById, tasksForProject) {
  const viaPredecessor = resolveFinancialTrigger(f.predecessors, tasksById, tasksForProject);
  if (viaPredecessor) return viaPredecessor;
  if (f.sync_to_anchor) {
    const t = tasksForProject.find(x => inferredAnchorKey(x) === f.sync_to_anchor);
    if (t) return t.end_date || t.start_date || null;
  }
  return f.due_date || null;
}

// ── SDC Team (public/app.js portalTeam) ─────────────────────────────────────

const PORTAL_ROLES = {
  pm: 'Project management', mech: 'Mechanical engineering', controls: 'Controls engineering',
  build: 'Build', wire: 'Wiring', service: 'Service', mfgops: 'Manufacturing', ops: 'Operations',
};
const PORTAL_ROLE_ORDER = ['pm', 'mech', 'controls', 'build', 'wire', 'service', 'mfgops', 'ops', 'other'];

function isPlaceholder(name) { return /\bplaceholder\b/i.test(String(name || '')); }

// teamMembers: all rows from team_members. leadsForProject: settings.project_leads[project] (e.g. {pm, debug}).
function portalTeam(rows, teamMembers, leadsForProject) {
  const byName = {};
  (teamMembers || []).forEach(m => { if (m && m.name) byName[m.name.trim()] = m; });

  const load = {};
  rows.forEach(t => {
    const a = (t.assignee || '').trim();
    if (!a || isPlaceholder(a)) return;
    load[a] = (load[a] || 0) + 1;
  });

  const pm = (leadsForProject && leadsForProject.pm) || '';
  const dbg = (leadsForProject && leadsForProject.debug) || '';
  const groups = {};
  const push = (disc, person) => { (groups[disc] = groups[disc] || []).push(person); };

  if (pm) push('pm', { name: pm, note: 'Project manager', lead: true });
  if (dbg) push('pm', { name: dbg, note: 'Lead engineer', lead: true });

  Object.keys(load)
    .filter(n => n !== pm && n !== dbg)
    .sort((a, b) => load[b] - load[a] || a.localeCompare(b))
    .forEach(n => {
      const m = byName[n];
      const disc = (m && PORTAL_ROLE_ORDER.includes(m.discipline)) ? m.discipline : 'other';
      push(disc, { name: n, note: (m && m.specialty) || '', lead: false });
    });

  return PORTAL_ROLE_ORDER
    .filter(d => groups[d] && groups[d].length)
    .map(d => ({ key: d, label: PORTAL_ROLES[d] || 'Project team', people: groups[d] }));
}

// Prefer a machine literally named M1 (the base on every normal project),
// otherwise the first machine — same rule public/app.js's grid uses
// (_finBaseMachine), so a machine-less milestone lands under the same
// machine the internal grid displays it under.
function finBaseMachine(machines) {
  const list = (machines || []).filter(Boolean).map(String);
  if (!list.length) return 'M1';
  return list.includes('M1') ? 'M1' : list[0];
}

function finProjectMachines(tasksForProject) {
  return Array.from(new Set(tasksForProject.filter(t => t.machine).map(t => String(t.machine))))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Ported from public/app.js's financialAnchorTask(): the anchor a synced
// financial row points at. Machine-less rows belong to the base machine, so
// an anchor on a multi-machine project resolves to the machine the row
// displays under, not just any task with a matching anchor key.
function financialAnchorTaskForMoney(f, tasksForProject, finBase) {
  if (!f || !f.sync_to_anchor) return null;
  return tasksForProject.find(x => inferredAnchorKey(x) === f.sync_to_anchor
    && (!x.machine || (x.machine || finBase) === (f.machine || finBase))) || null;
}

function portalMoney(financials, tasksById, tasksForProject) {
  const machines = finProjectMachines(tasksForProject);
  const multi = machines.length > 1;
  const finBase = finBaseMachine(machines);
  return financials
    .filter(f => !f.archived_at)
    .map(f => {
      const when = financialDueDate(f, tasksById, tasksForProject);
      const status = f.paid ? 'paid' : f.sent ? 'invoiced' : 'upcoming';
      let machine = f.machine || '';
      if (!machine) {
        const at = financialAnchorTaskForMoney(f, tasksForProject, finBase);
        machine = (at && at.machine) || '';
      }
      if (!machine && multi) machine = finBase;
      return {
        name: f.name, percent: f.percent, amount: f.amount,
        due: when, dueText: fmtDate(when), status, machine: machine || null,
      };
    })
    .sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || String(a.due || '').localeCompare(String(b.due || '')));
}

// ── Risk plan (public/app.js riskPlan / riskBand / riskTaskList) ────────────

function riskBand(score) {
  if (score >= 12) return { key: 'critical', label: 'Very high' };
  if (score >= 8) return { key: 'high', label: 'High' };
  if (score >= 4) return { key: 'medium', label: 'Medium' };
  return { key: 'low', label: 'Low' };
}

function portalRisk(riskPlanForProject, tasksForProject) {
  const risks = Array.isArray(riskPlanForProject && riskPlanForProject.risks) ? riskPlanForProject.risks : [];
  const today = ymdLocal(new Date());
  return risks
    .filter(r => r.show)
    .map(r => {
      const score = (Number(r.l) || 0) * (Number(r.s) || 0);
      const sub = 'risk:' + r.id;
      const actions = tasksForProject
        .filter(t => t.phase_group === 'RISK' && t.sub_department === sub && (t.name || '').trim())
        .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
        .map(t => {
          const done = (Number(t.progress) || 0) >= 100;
          const due = t.end_date || '';
          return { text: t.name, due, dueText: fmtDate(due) || null, done, overdue: !done && due && due < today };
        });
      return {
        id: r.id, title: r.title || '', mitigation: r.mitigation || '',
        likelihood: Number(r.l) || 0, severity: Number(r.s) || 0,
        score, band: riskBand(score), actions,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, n: i + 1 }));
}

return {
  normalizeTasks, inferredAnchorKey, isMilestoneLike, portalPercent, portalPlannedPercent,
  portalProgress, portalUnits, portalMilestones, portalDueRow, portalSlip, portalMoney,
  portalRisk, riskBand, portalTeam, portalTaskMix, portalDeptChart, portalWork,
  finBaseMachine, finProjectMachines, financialAnchorTaskForMoney,
  resolveFinancialTrigger, financialDueDate, addBusinessDays,
  isBacklogRow, getEffectiveProgress, taskScheduleDelta, portalDrift, portalLate, portalLateWeeks, portalRowState,
  fmtDate, ymdLocal,
};

}));
