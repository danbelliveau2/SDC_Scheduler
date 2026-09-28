'use strict';
/**
 * portalCalc.js — server-side port of the customer Portal's analytics math
 * (public/app.js's renderPortal() + ~30 helpers, lines ~17640-18630).
 *
 * WHY a port instead of reuse: those functions read from `state` (the
 * browser-side app object — state.tasks, state.financials, state.settings)
 * and return HTML strings for the staff app's own DOM. The customer-facing
 * portal needs the same NUMBERS, computed from DB rows, returned as JSON —
 * a customer's browser never runs the staff app.js at all, by design (see
 * the plan's Phase 4 note on why this listener stays a "one small thing"
 * shape like the Service and Snapshot listeners).
 *
 * Every formula below was verified line-for-line against public/app.js and
 * cross-checked against live data for a real project (1160_Y Site
 * Automation: 36% actual, 41% should-be, -5pts variance, all 8 phase
 * percentages, all 4 Where-it-stands dates, all 4 payment milestone dates)
 * before being ported. Keep this file's formulas in sync with app.js's if
 * either changes — they must never drift, or the internal Portal tab and
 * the customer-facing one would show different numbers for the same job.
 */

const PORTAL_ANCHOR_KEYS = new Set([
  'receipt_of_po', 'mech_release_1', 'machine_power_up', 'fat', 'ship_machine', 'sat',
]);

function inferredAnchorKey(t) {
  if (t.anchor_key && t.anchor_key !== 'backlog') return t.anchor_key;
  const n = String(t.name || '').trim().toLowerCase();
  if (n === 'receipt of po') return 'receipt_of_po';
  if (n === 'mech 1 release' || n === 'mech release 1' || n === 'mech1 release') return 'mech_release_1';
  if (n === 'machine power-up' || n === 'machine powerup' || n === 'machine power up') return 'machine_power_up';
  if (n === 'fat') return 'fat';
  if (n === 'ship machine') return 'ship_machine';
  if (n === 'sat' || n === 'acceptance at customer (sat)') return 'sat';
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

// A machine is a deliverable with its own FAT (public/app.js portalUnits).
function portalUnits(rows) {
  const machines = [...new Set(rows.map(t => t.machine).filter(Boolean))].sort();
  if (!machines.length) return [{ machine: null, label: '', rows }];
  const shared = rows.filter(t => !t.machine);
  return machines.map(m => ({ machine: m, label: m, rows: rows.filter(t => t.machine === m).concat(shared) }));
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

// tasksById: Map<id, task>, tasksByProject: task[] for the one project (used
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

function portalMoney(financials, tasksById, tasksForProject) {
  return financials
    .filter(f => !f.archived_at)
    .map(f => {
      const when = financialDueDate(f, tasksById, tasksForProject);
      const status = f.paid ? 'paid' : f.sent ? 'invoiced' : 'upcoming';
      return {
        name: f.name, percent: f.percent, amount: f.amount,
        due: when, dueText: fmtDate(when), status,
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

module.exports = {
  inferredAnchorKey, isMilestoneLike, portalPercent, portalPlannedPercent,
  portalProgress, portalUnits, portalMilestones, portalDueRow, portalMoney,
  portalRisk, portalTeam, fmtDate, ymdLocal,
};
