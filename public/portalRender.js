// portalRender.js — the Portal tab's CONTENT rendering: due dates, progress,
// payment milestones, risk plan, team, event status. Used by public/app.js's
// renderPortal(), for BOTH staff's own internal Portal tab AND a real
// customer session (which runs this exact same app.js, locked to the
// Portal tab and scoped server-side — see server.js's CUSTOMER_GET_PATHS).
// renderPortal() itself — the customer picker, "Manage login", the SDC
// cross-customer aggregate view — stays in app.js, not here, on purpose:
// none of that belongs anywhere a customer's browser could ever load it,
// and app.js already gates it behind _portalLockedCustomer regardless.
//
// This file is a plain classic script (no module wrapper), loaded via
// <script> in index.html before app.js, same pattern as phases.js/
// release-notes.js. Every function here is a byte-for-byte relocation out
// of app.js — not a rewrite — so the staff Portal tab's output is
// unchanged. It depends on a handful of globals it does NOT define itself
// (state, escapeHtml, fmtDate, inferredAnchorKey, isMilestoneLike,
// taskScheduleDelta, getEffectiveProgress, financialDueDate,
// financialAnchorTask, _finBaseMachine, riskPlan, riskBand, riskTaskList,
// projectLead, isPlaceholder, _ymdLocal) — app.js defines all of these
// already, for both a staff session and a real customer session alike, so
// this file never needs its own copies or stand-ins for them. Loaded after
// public/portalCalc.js.

// ── Milestones / due dates ──────────────────────────────────────────────

const PORTAL_PHASES = [
  { key: 'kickoff',         label: 'Kickoff' },
  { key: 'design_build',    label: 'Design & build' },
  { key: 'machine_testing', label: 'Testing' },
  { key: 'teardown_install',label: 'Ship & install' },
];

function portalMilestones(rows) {
  const today = _ymdLocal(new Date());
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
      return {
        key, phase: t.phase_group || null,
        label: (t.name || '').trim(),
        done, committed, current, slip,
        past: !done && current && current < today,
      };
    })
    .filter(m => m.current)
    .sort((a, b) => a.current.localeCompare(b.current));
}

function portalMilestonePhases(ms) {
  const out = PORTAL_PHASES.map(p => ({ ...p, items: ms.filter(m => m.phase === p.key) }));
  const loose = ms.filter(m => !PORTAL_PHASES.some(p => p.key === m.phase));
  if (loose.length) out.push({ key: 'other', label: 'Other', items: loose });
  return out.filter(p => p.items.length);
}

// How late a row already is, for when there is no baseline to drift from.
// Same half-week snap as every other variance in the app.
function _portalLate(due, today) {
  if (!due || !today || due >= today) return null;
  const days = Math.round((new Date(today + 'T00:00:00') - new Date(due + 'T00:00:00')) / 86400000);
  const wks = Math.round((days / 5) * 2) / 2 || 0.5;
  return { text: '−' + wks + 'w behind', cls: 'is-behind' };
}

// One working week. Half a week is inside the noise of a weekly update.
const PORTAL_BEHIND_WEEKS = 1;

function _portalLateWeeks(t, today) {
  let days = 0;
  const due = t.end_date || '';
  if (due && today && due < today) {
    days = Math.round((new Date(today + 'T00:00:00') - new Date(due + 'T00:00:00')) / 86400000);
  }
  let drift = 0;
  try { drift = taskScheduleDelta(t) || 0; } catch (_) { drift = 0; }
  if (drift < 0) days = Math.max(days, Math.abs(drift));
  if (!days) return 0;
  return Math.round((days / 5) * 2) / 2;
}

function _portalRowState(t, today) {
  const pct = getEffectiveProgress(t);
  if (pct >= 100) return 'complete';
  if (_portalLateWeeks(t, today) >= PORTAL_BEHIND_WEEKS) return 'behind';
  return pct > 0 ? 'running' : 'notStarted';
}

// How far behind a row is, in weeks (public/app.js portalDrift).
function portalDrift(t) {
  let d = 0;
  try { d = taskScheduleDelta(t) || 0; } catch (_) { d = 0; }
  if (!d) return null;
  const wks = (Math.round((Math.abs(d) / 5) * 2) / 2) || 0.5;
  return d > 0
    ? { text: '+' + wks + 'w ahead', cls: 'is-ahead' }
    : { text: '−' + wks + 'w behind', cls: 'is-behind' };
}

function portalWork(rows) {
  const today = _ymdLocal(new Date());
  const cut = new Date(); cut.setDate(cut.getDate() - _portalRecentDays);
  const cutISO = _ymdLocal(cut);
  const behind = [], running = [], recent = [];
  rows.forEach(t => {
    const pct = getEffectiveProgress(t);
    const name = (t.name || '').trim();
    if (!name) return;
    const assignee = (t.assignee || '').trim();
    const due = t.end_date || '';
    const drift = portalDrift(t);
    const row = { name, assignee, pct, due, drift, when: '' };
    switch (_portalRowState(t, today)) {
      case 'complete': {
        const when = t.completed_on || t.end_date || '';
        if (when && when >= cutISO) recent.push({ ...row, drift: null, when });
        break;
      }
      case 'behind':
        behind.push({ ...row, drift: drift || _portalLate(due, today) });
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

function _portalInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function portalDate(iso) {
  if (!iso) return '—';
  try { return fmtDate(iso); } catch (_) { return iso; }
}

// The gap between the date we committed to and the date the schedule shows.
function portalFatVariance(fat) {
  const a = fat && fat.committed;
  const b = fat && fat.current;
  if (!a || !b) return { text: '—', cls: '' };
  const days = Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
  if (!days) return { text: 'on date', cls: 'is-ok' };
  const wks = Math.round((Math.abs(days) / 5) * 2) / 2 || 0.5;
  return days > 0
    ? { text: '+' + wks + 'w late', cls: 'is-late' }
    : { text: '−' + wks + 'w early', cls: 'is-ok' };
}

function portalSlip(ms) {
  if (!ms || ms.missing) return { text: '—', cls: '' };
  if (ms.slip == null) return { text: 'no baseline', cls: 'is-none' };
  if (ms.slip === 0) return { text: 'on date', cls: 'is-ok' };
  const wks = Math.round((Math.abs(ms.slip) / 5) * 2) / 2 || 0.5;
  return ms.slip > 0
    ? { text: '+' + wks + 'w late', cls: 'is-late' }
    : { text: '−' + wks + 'w early', cls: 'is-ok' };
}

// M1 / M2 are how we tag a row. A customer reads the words.
function _portalMachineLabel(m) {
  const t = String(m || '').trim();
  if (!t) return '';
  const n = t.replace(/^M/i, '').trim();
  return (n && /^[0-9]+$/.test(n)) ? 'Machine ' + n : t;
}

// ── SDC Team ─────────────────────────────────────────────────────────────

function portalTeam(project, rows) {
  const byName = {};
  (state.team || []).forEach(m => { if (m && m.name) byName[m.name.trim()] = m; });

  const load = {};
  rows.forEach(t => {
    const a = (t.assignee || '').trim();
    if (!a) return;
    try { if (isPlaceholder(a)) return; } catch (_) {}
    load[a] = (load[a] || 0) + 1;
  });

  const groups = {};
  const push = (disc, person) => { (groups[disc] = groups[disc] || []).push(person); };

  // The four leads named on the schedule, each under their own department.
  // One person holding two roles (engineering and debug, usually) is one
  // card that says both.
  const NOTE = { pm: 'Project manager', eng: 'Engineering lead', shop: 'Shop lead', debug: 'Debug lead', apps: 'Applications engineer' };
  const leads = {};
  ['pm', 'eng', 'shop', 'debug', 'apps'].forEach(k => {
    const n = projectLead(project, k);
    if (!n) return;
    (leads[n] = leads[n] || []).push(NOTE[k]);
  });
  Object.keys(leads).forEach(n => {
    const m = byName[n];
    const disc = (m && PORTAL_ROLE_ORDER.includes(m.discipline)) ? m.discipline : (m && m.discipline === 'growth') ? 'sales' : 'pm';
    push(disc, { name: n, note: leads[n].join(' · '), lead: true });
  });

  Object.keys(load)
    .filter(n => !leads[n])
    .sort((a, b) => load[b] - load[a] || a.localeCompare(b))
    .forEach(n => {
      const m = byName[n];
      const disc = (m && PORTAL_ROLE_ORDER.includes(m.discipline)) ? m.discipline : 'other';
      // The title comes from the Departments roster (the employee report).
      push(disc, { name: n, note: (m && (m.title || m.specialty)) || '', lead: false });
    });

  return PORTAL_ROLE_ORDER
    .filter(d => groups[d] && groups[d].length)
    .map(d => ({ key: d, label: PORTAL_ROLES[d] || 'Project team', people: groups[d] }));
}

// The team block used to repeat under every machine of a job. It is the same
// people each time — one block per project says it once.
function _portalTeamHtml(projects) {
  const blocks = projects.map(p => {
    const team = portalTeam(p, state.tasks.filter(t => t.project === p));
    if (!team.length) return '';
    return `<div class="portal-teamblock">
      ${projects.length > 1 ? `<div class="portal-team-proj">${escapeHtml(p)}</div>` : ''}
      ${team.map(g => { const d = (typeof DISCIPLINE_BY_KEY !== 'undefined' && DISCIPLINE_BY_KEY[g.key]) || null; return `<div class="portal-team-group" data-disc="${g.key}"${d ? ` style="--dc:${d.color};--dt:${d.text}"` : ''}>
        <div class="portal-team-role">${escapeHtml(g.label)}</div>
        <div class="portal-team-people">
          ${g.people.map(x => `<div class="portal-person ${x.lead ? 'is-lead' : ''}">
            <span class="pp-avatar">${escapeHtml(_portalInitials(x.name))}</span>
            <span class="pp-text"><span class="pp-name">${escapeHtml(x.name)}</span>
            ${x.note ? `<span class="pp-role">${escapeHtml(x.note)}</span>` : ''}</span>
          </div>`).join('')}
        </div>
      </div>`; }).join('')}
    </div>`;
  }).filter(Boolean).join('');
  if (!blocks) return '';
  return `<section class="portal-block">
    <h2 class="portal-h2">SDC Team</h2>
    ${blocks}
  </section>`;
}

// ── Payment milestones ──────────────────────────────────────────────────

const PORTAL_MONEY_COLS = [
  { key: 'mach',   label: 'Machine',   w: 150 },
  { key: 'name',   label: 'Milestone', w: 320 },
  { key: 'value',  label: 'Value',     w: 130 },
  { key: 'when',   label: 'Expected',  w: 140 },
  { key: 'status', label: 'Status',    w: 130 },
];

function _portalMoneyHtml(projects, machine) {
  const blocks = projects.map(p => {
    const all = ((state.financials && state.financials[p]) || []).filter(f => !f.archived_at);
    if (!all.length) return '';
    const machinesOn = [...new Set(state.tasks.filter(t => t.project === p && t.machine).map(t => t.machine))];
    const multi = machinesOn.length > 1;
    const rows = all.map(f => {
      let when = null;
      try { when = financialDueDate(f, p); } catch (_) { when = f.due_date || null; }
      let mach = f.machine || '';
      if (!mach) { try { mach = (financialAnchorTask(f, p) || {}).machine || ''; } catch (_) {} }
      if (!mach && multi) mach = _finBaseMachine(machinesOn);
      return { f, when, mach };
    }).filter(r => !machine || !r.mach || r.mach === machine);
    if (!rows.length) return '';
    rows.sort((x, y) =>
      (x.when ? 0 : 1) - (y.when ? 0 : 1)
      || String(x.when || '').localeCompare(String(y.when || ''))
      || (x.f.sort_order || 0) - (y.f.sort_order || 0));
    const body = rows.map(r => {
      const f = r.f;
      const status = f.paid ? { t: 'Paid', c: 'is-paid' } : f.sent ? { t: 'Invoiced', c: 'is-sent' } : { t: 'Upcoming', c: '' };
      const amt = [];
      if (f.percent != null && Number(f.percent) > 0) amt.push(Number(f.percent) + '%');
      if (f.amount != null && Number(f.amount) > 0) amt.push('$' + Number(f.amount).toLocaleString('en-US'));
      const machCell = multi
        ? `<td class="pm-mach"><span class="pm-mach-pill">${escapeHtml(_portalMachineLabel(r.mach))}</span></td>`
        : '';
      return `<tr>
        ${machCell}
        <td class="pm-name" title="${escapeHtml(f.name || '')}">${escapeHtml(f.name || '')}</td>
        <td class="pm-amt">${escapeHtml(amt.join(' · ') || '—')}</td>
        <td class="pm-when">${escapeHtml(portalDate(r.when))}</td>
        <td><span class="pm-status ${status.c}">${escapeHtml(status.t)}</span></td>
      </tr>`;
    }).join('');
    const cols = multi ? PORTAL_MONEY_COLS : PORTAL_MONEY_COLS.filter(c => c.key !== 'mach');
    return `<div class="portal-money-proj">
      <div class="portal-money-title">${escapeHtml(p)}</div>
      ${_portalGridHtml('money:' + (multi ? 'm' : '1'), cols, body, 'portal-money')}
    </div>`;
  }).filter(Boolean).join('');
  if (!blocks) return '';
  return `<section class="portal-block">
    <h2 class="portal-h2">Payment milestones</h2>
    ${blocks}
  </section>`;
}

// ── Risk mitigation plan ─────────────────────────────────────────────────
// RISK_LIKELIHOOD / RISK_SEVERITY are NOT declared here — app.js already
// declares them globally (its risk-register editor also uses them too);
// this file just reads them as external globals, same as
// state/escapeHtml/riskPlan/etc.

const _portalRiskOpen = new Set(); // risks whose plan is expanded on the portal

function _portalRiskHtml(projects) {
  const items = [];
  projects.forEach(p => {
    riskPlan(p).forEach(r => {
      if (!r.show) return;
      const score = (Number(r.l) || 0) * (Number(r.s) || 0);
      items.push({ ...r, project: p, score, band: riskBand(score) });
    });
  });
  if (!items.length) return '';
  items.sort((a, b) => b.score - a.score);
  items.forEach((r, i) => { r.n = i + 1; });

  // The matrix, same orientation as the internal one so the two never disagree.
  const matrix = RISK_LIKELIHOOD.slice().reverse().map(L => {
    const cells = RISK_SEVERITY.map(S => {
      const here = items.filter(r => Number(r.l) === L.v && Number(r.s) === S.v);
      const band = riskBand(L.v * S.v);
      return `<td class="rm-cell rm-${band.key}">${here.map(r =>
        `<button type="button" class="prm-dot" data-prisk="${escapeHtml(r.id || '')}" title="${escapeHtml(r.title || '')}">${r.n}</button>`).join('')}</td>`;
    }).join('');
    return `<tr><th class="rm-yl">${escapeHtml(L.label)}</th>${cells}</tr>`;
  }).join('');

  const rows = items.map(r => {
    const acts = riskTaskList(r.project, r.id)
      .filter(t => (t.name || '').trim())
      .map(t => ({ text: t.name, due: t.end_date || '', done: (Number(t.progress) || 0) >= 100 }));
    const open = _portalRiskOpen.has(r.id);
    const dated = acts.filter(a => a.due).sort((a, b) => a.due.localeCompare(b.due));
    const today = _ymdLocal(new Date());
    const plan = !acts.length
      ? `<p class="portal-none">No separate plan — handled inside the main schedule.</p>`
      : `<table class="prk-plan">
          <thead><tr><th>What we are doing</th><th>By</th><th>Status</th></tr></thead>
          <tbody>${acts.map(a => {
            const late = !a.done && a.due && a.due < today;
            return `<tr>
              <td>${escapeHtml(a.text)}</td>
              <td class="prk-when">${escapeHtml(portalDate(a.due))}</td>
              <td>${a.done ? `<span class="pm-status is-paid">Done</span>`
                : late ? `<span class="pm-status is-late">Overdue</span>`
                : `<span class="pm-status">Planned</span>`}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        ${dated.length > 1 ? `<div class="prk-window">Testing and checks run ${escapeHtml(portalDate(dated[0].due))} to ${escapeHtml(portalDate(dated[dated.length - 1].due))}</div>` : ''}`;

    return `<div class="prk-item ${open ? 'is-open' : ''}">
      <button type="button" class="prk-row" data-prisk="${escapeHtml(r.id || '')}">
        <span class="prk-n">${r.n}</span>
        <span class="prk-name">${escapeHtml(r.title || '')}</span>
        <span class="rk-band rk-band-${r.band.key}">${escapeHtml(r.band.label)}</span>
        <span class="prk-caret">${open ? '▾' : '▸'}</span>
      </button>
      ${open ? `<div class="prk-detail">
        ${r.mitigation ? `<p class="prk-mit-text">${escapeHtml(r.mitigation)}</p>` : ''}
        ${plan}
      </div>` : ''}
    </div>`;
  }).join('');

  return `<section class="portal-block">
    <h2 class="portal-h2">Risk Mitigation Plan</h2>
    <div class="portal-risk-grid">
      <div class="portal-risk-matrix">
        <table class="risk-matrix">
          <tbody>
            ${matrix}
            <tr><th class="rm-corner">Chance it costs<br>us time ↑<br>How much time →</th>${RISK_SEVERITY.map(S => `<th class="rm-xl">${escapeHtml(S.label)}</th>`).join('')}</tr>
          </tbody>
        </table>
      </div>
      <div class="portal-risk-list">${rows}</div>
    </div>
  </section>`;
}

// ── Where it stands (due dates) ─────────────────────────────────────────

const PORTAL_KEY_DATES = [
  { key: 'receipt_of_po', label: 'Receipt of PO' },
  { key: 'machine_power_up', label: 'Machine Power-Up' },
];

// Percent complete across the work in view, weighted by scheduled days.
function _portalPlannedPercent(rows, today) {
  const now = new Date((today || _ymdLocal(new Date())) + 'T00:00:00').getTime();
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

function _portalPercent(rows) {
  let planned = 0, done = 0;
  rows.forEach(t => {
    if (isMilestoneLike(t)) return;
    const d = Math.max(Number(t.duration_days) || 0, 0.5);
    planned += d;
    done += d * getEffectiveProgress(t) / 100;
  });
  if (!planned) return null;
  return Math.round((done / planned) * 100);
}

const PORTAL_DUE_COLS = [
  { key: 'name',     label: 'Machine',          w: 300 },
  { key: 'pct',      label: 'Complete',         w: 170 },
  { key: 'po',       label: 'Receipt of PO',    w: 140 },
  { key: 'power',    label: 'Machine Power-Up', w: 165 },
  { key: 'fatQuote', label: 'FAT per purchase agreement', w: 185 },
  { key: 'fatProj',  label: 'FAT currently scheduled',    w: 175 },
  { key: 'slip',     label: 'Variance',                   w: 120 },
];
function _portalDueTableHtml(units) {
  // Nothing picked, nothing to report on.
  if (!units.length) return '';
  const body = units.map(u => {
    const fat = u.ms.find(m => m.key === 'fat') || null;
    const sl = portalFatVariance(fat);
    // Inside one job the machine is enough; across a group it is not.
    const many = new Set(units.map(x => x.project)).size > 1;
    const name = u.machine
      ? (many ? u.project + ' · ' + _portalMachineLabel(u.machine) : _portalMachineLabel(u.machine))
      : u.project;
    const pct = _portalPercent(u.rows);
    const cells = PORTAL_KEY_DATES.map(k => {
      const m = u.ms.find(x => x.key === k.key) || null;
      const cls = m && m.done ? 'is-done' : (m && m.past ? 'is-past' : '');
      return `<td class="portal-key-date ${cls}">${escapeHtml(portalDate(m && m.current))}</td>`;
    }).join('');
    const quoted = fat && fat.committed;
    return `<tr>
      <td class="portal-due-name" title="${escapeHtml(name)}">${escapeHtml(name)}</td>
      <td class="portal-pct">${pct == null ? '—' : `<span class="portal-pct-bar"><i style="width:${pct}%"></i></span><span class="portal-pct-n">${pct}%</span>`}</td>
      ${cells}
      <td class="portal-key-date">${escapeHtml(portalDate(quoted))}</td>
      <td class="portal-key-date ${fat && fat.done ? 'is-done' : (fat && fat.past ? 'is-past' : '')}">${escapeHtml(portalDate(fat && fat.current))}</td>
      <td><span class="portal-slip ${sl.cls}">${escapeHtml(sl.text)}</span></td>
    </tr>`;
  }).join('');
  return `<section class="portal-block">
    <h2 class="portal-h2">Where it stands</h2>
    ${_portalGridHtml('due', PORTAL_DUE_COLS, body, 'portal-due')}
  </section>`;
}

// ── Communication plan ──────────────────────────────────────────────────
// Read-only on the portal: who to call on both sides, the escalation ladder
// and the meeting cadence. The SDC side is the company standard with this
// job's leads from the schedule footer; the customer side and the cadence
// are the project's own plan.
const _portalCpCache = {};
function _portalEnsureCommPlans(projects) {
  const need = projects.filter(p => !(p in _portalCpCache));
  if (!need.length) return;
  need.forEach(p => { _portalCpCache[p] = null; });   // in flight
  Promise.all(need.map(p => fetch(`/api/project/${encodeURIComponent(p)}/quote`)
    .then(r => (r.ok ? r.json() : {})).catch(() => ({}))
    .then(q => { _portalCpCache[p] = (q && q.comm_plan) || {}; })))
    .then(() => { if (state.view === 'portal') { try { renderPortal(); } catch (_) {} } });
}
function _portalCommPlanHtml(projects) {
  if (!projects.length) return '';
  _portalEnsureCommPlans(projects);
  const std = (state.settings && state.settings.comm_plan_standard) || null;
  const roster = (state.team || []).filter(m => m && m.name);
  const byName = (n) => roster.find(m => m.name.trim().toLowerCase() === String(n || '').trim().toLowerCase()) || null;
  const LEVEL_HINT = 'Escalation level — work through 1 before 2, 2 before 3.';
  const cols = (last) => [
    { key: 'role',  label: 'Role',  w: 170 },
    { key: 'name',  label: 'Name',  w: 170, min: 140 },
    { key: 'email', label: 'Email', w: 220, min: 200 },
    { key: 'phone', label: 'Phone', w: 120, min: 125 },
    { key: 'level', label: 'Level', w: 64,  min: 56, title: LEVEL_HINT },
    { key: 'when',  label: last,    w: 330 },
  ];
  const CAD = [
    { key: 'name',      label: 'Communication',  w: 210 },
    { key: 'date',      label: 'Date',           w: 110, min: 100 },
    { key: 'frequency', label: 'Frequency',      w: 110, min: 100 },
    { key: 'when',      label: 'When',           w: 150, min: 120 },
    { key: 'format',    label: 'Format',         w: 170 },
    { key: 'owner',     label: 'Led by',         w: 140 },
    { key: 'audience',  label: "Who's involved", w: 280 },
  ];
  const txt = (v, cls) => `<span class="pcp-t${cls ? ' ' + cls : ''}">${escapeHtml(v || '—')}</span>`;
  const peopleRows = (rows) => rows.map(r => {
    const m = byName(r.name);
    const email = (m && m.email) || r.email || '';
    return `<tr>
      <td>${txt(r.role)}</td>
      <td>${r.name ? txt(r.name) : '<span class="pcp-t pcp-empty">Not assigned yet</span>'}</td>
      <td>${email ? `<a class="pcp-mail" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : txt('')}</td>
      <td>${txt(r.phone)}</td>
      <td>${txt(r.level, 'pcp-level')}</td>
      <td>${txt(r.when)}</td>
    </tr>`;
  }).join('');
  // No toolbar on the portal — the grids come up compressed on their own.
  const grid = (id, c, body, prose) => _portalGridHtml(id, c, body, 'pcp', prose).replace(/<div class="pg-tools">[\s\S]*?<\/div>\s*/, '');
  const blocks = projects.map(p => {
    const plan = _portalCpCache[p];
    const key = String(p).replace(/[^a-z0-9]/gi, '').slice(0, 40);
    if (!plan) return `<div class="portal-teamblock"><p class="portal-note">Loading the communication plan…</p></div>`;
    const d = _commPlanDefaults(p);
    const leadership = (std && std.leadership) || d.leadership;
    const sdc = ((std && std.sdc) || d.sdc).map(r => {
      const k = COMM_LEAD_ROW[r.role];
      const name = k ? (projectLead(p, k) || '') : (r.name || '');
      const m = byName(name);
      return Object.assign({}, r, { name, email: m ? m.email : (k ? '' : r.email), phone: (k && !name) ? '' : r.phone });
    });
    const custStd = (std && std.customer) || d.customer.map(r => ({ role: r.role, when: r.when }));
    const mine = plan.customer || [];
    const used = new Set();
    const customer = custStd.map(sr => {
      const i = mine.findIndex((r, idx) => !used.has(idx) && (r.role || '') === sr.role);
      const r = i >= 0 ? mine[i] : {};
      if (i >= 0) used.add(i);
      return { role: sr.role, when: sr.when, name: r.name || '', email: r.email || '', phone: r.phone || '', level: r.level || '' };
    });
    mine.forEach((r, idx) => { if (!used.has(idx)) customer.push(r); });
    const cadence = (plan.cadence && plan.cadence.length) ? plan.cadence : d.cadence;
    const cadRows = cadence.map(r => `<tr>
      <td>${txt(r.name)}</td><td>${txt(portalDate(r.date) || r.date)}</td><td>${txt(r.frequency)}</td>
      <td>${txt(r.when)}</td><td>${txt(r.format)}</td><td>${txt(r.owner)}</td><td>${txt(r.audience)}</td>
    </tr>`).join('');
    return `<div class="portal-teamblock">
      ${projects.length > 1 ? `<div class="portal-team-proj">${escapeHtml(p)}</div>` : ''}
      <div class="pcp-title">SDC leadership <span>where an issue goes once the project team has not settled it — level 1 first</span></div>
      ${grid('pcp-lead-' + key, cols('Escalate to them for…'), peopleRows(leadership), 'when')}
      <div class="pcp-title">SDC project team <span>your first call — by what it is about</span></div>
      ${grid('pcp-sdc-' + key, cols('Contact for…'), peopleRows(sdc), 'when')}
      <div class="pcp-title">Your team</div>
      ${grid('pcp-cust-' + key, cols('Contact for…'), peopleRows(customer), 'when')}
      <div class="pcp-title">Communication cadence</div>
      ${grid('pcp-cad-' + key, CAD, cadRows, 'audience')}
    </div>`;
  }).join('');
  return `<section class="portal-block">
    <h2 class="portal-h2">Communication plan</h2>
    ${blocks}
  </section>`;
}

// ── Grid shell (resizable columns, shared by due/money/work tables) ──────

const PORTAL_WORK_COLS = [
  { key: 'name',  label: 'Event',                 w: 340 },
  { key: 'who',   label: 'Assigned to',           w: 165 },
  { key: 'pct',   label: '% Complete',            w: 120 },
  { key: 'due',   label: 'Scheduled completion',  w: 165 },
  { key: 'when',  label: 'Completed',             w: 125 },
  { key: 'drift', label: 'Against plan',          w: 130 },
];

function _portalColWidths(gridId, cols) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('sdcPortalCols:' + gridId) || 'null'); } catch (_) {}
  const out = {};
  cols.forEach(c => {
    const v = saved && Number(saved[c.key]);
    out[c.key] = (v && v >= 60) ? v : c.w;
  });
  return out;
}

// prose: the column that takes whatever width is left after Compress. The
// first column when not named.
function _portalGridHtml(gridId, cols, bodyHtml, extraClass, prose) {
  const w = _portalColWidths(gridId, cols);
  const total = cols.reduce((n, c) => n + w[c.key], 0);
  const colTags = cols.map(c => `<col data-pcol="${c.key}" data-pw="${c.w}"${c.min ? ` data-pmin="${c.min}"` : ''} style="width:${w[c.key]}px">`).join('');
  const head = cols.map(c =>
    `<th data-pcol="${c.key}"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>${escapeHtml(c.label)}<span class="pw-grip" data-pgrip="${c.key}"></span></th>`).join('');
  return `<div class="pg-tools">
    <button type="button" class="risk-tool" data-pcompress title="Size every column to its widest value; the long-text column takes what is left so nothing scrolls">⇤ Compress</button>
  </div>
  <div class="portal-grid-wrap">
    <table class="portal-grid ${extraClass || ''}" data-grid="${escapeHtml(gridId)}"${prose ? ` data-prose="${escapeHtml(prose)}"` : ''} style="width:${total}px">
      <colgroup>${colTags}</colgroup>
      <thead><tr>${head}</tr></thead>
      <tbody>${bodyHtml}</tbody>
    </table>
  </div>`;
}

// Only fits grids whose widths are still the defaults — a width someone
// dragged is a decision, and decisions are not rescaled behind their back.
function _fitPortalGrid(table) {
  if (!table || table.dataset.userSized === '1') return;
  const wrap = table.parentElement;
  if (!wrap) return;
  const cols = Array.from(table.querySelectorAll('col[data-pcol]'));
  if (!cols.length) return;
  const widths = cols.map(c => parseFloat(c.style.width) || 0);
  const total = widths.reduce((n, w) => n + w, 0);
  const avail = wrap.clientWidth;
  if (!total || !avail) return;
  const k = Math.max(0.2, (avail - 2) / total);
  cols.forEach((c, i) => { c.style.width = Math.max(60, Math.floor(widths[i] * k) - (i === 0 ? 1 : 0)) + 'px'; });
  const sum = () => Array.from(table.querySelectorAll('col[data-pcol]'))
    .reduce((n, c) => n + (parseFloat(c.style.width) || 0), 0);
  table.style.width = sum() + 'px';
  const extra = table.parentElement.scrollWidth - table.parentElement.clientWidth;
  if (extra > 0) {
    const all = Array.from(table.querySelectorAll('col[data-pcol]'));
    const widest = all.reduce((m, c) => (parseFloat(c.style.width) || 0) > (parseFloat(m.style.width) || 0) ? c : m, all[0]);
    widest.style.width = Math.max(60, (parseFloat(widest.style.width) || 0) - extra - 2) + 'px';
    table.style.width = sum() + 'px';
  }
}

// ⇤ Compress for a portal grid — the same idea as the risk register. Every
// column that holds a value is sized to the widest value in it (ink, plus the
// cell's own padding); the first column holds the sentences and takes
// whatever the wrap has left, so the grid fills the panel with no sideways
// scroll. Below 140px it stops shrinking and the text wraps instead.
function _portalCompressGrid(table) {
  if (!table) return;
  const wrap = table.parentElement;
  const cols = Array.from(table.querySelectorAll('col[data-pcol]'));
  const ths = Array.from(table.querySelectorAll('thead th[data-pcol]'));
  if (!wrap || !cols.length || cols.length !== ths.length) return;
  const PROSE = table.dataset.prose || cols[0].dataset.pcol;
  const prev = { layout: table.style.tableLayout, width: table.style.width, cols: cols.map(c => c.style.width) };
  // Rows that carry values. Work grids mark theirs; any other grid's body rows count.
  const dataRows = () => { const r = table.querySelectorAll('tbody tr.pw-row'); return r.length ? r : table.querySelectorAll('tbody tr'); };
  // Text inside a control has no text node to measure — measure the string
  // in the control's own font instead.
  let probe = _portalCompressGrid._probe;
  if (!probe || !probe.isConnected) {
    probe = _portalCompressGrid._probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;white-space:pre;pointer-events:none;';
    document.body.appendChild(probe);
  }
  const Z = (table.offsetWidth > 0) ? (table.getBoundingClientRect().width / table.offsetWidth) || 1 : 1;
  const textW = (el, text) => {
    const cs = getComputedStyle(el);
    ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textTransform'].forEach(k => { probe.style[k] = cs[k]; });
    probe.textContent = String(text || '');
    return probe.getBoundingClientRect().width / Z + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  };
  let measured = null, pad = 24;
  try {
    table.classList.add('pg-measuring');
    table.style.tableLayout = 'auto';
    table.style.width = 'max-content';
    cols.forEach(c => { c.style.width = ''; });
    void table.offsetWidth;
    const padOf = (el) => { if (!el) return 0; const cs = getComputedStyle(el); return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0); };
    // The cell padding that applies — a header's or a body cell's, whichever
    // is wider — plus a hair so nothing sits flush against the edge.
    pad = Math.max(padOf((dataRows()[0] || {}).firstElementChild), padOf(ths[0])) + 4;
    const inkRight = (cell) => {
      const base = cell.getBoundingClientRect().left;
      let right = base;
      const walk = (node, padR) => {
        if (node.nodeType === 3) {
          if (!node.textContent.trim()) return;
          const r = document.createRange(); r.selectNodeContents(node);
          for (const b of r.getClientRects()) if (b.right + padR > right) right = b.right + padR;
        } else if (node.nodeType === 1) {
          if (node.classList && node.classList.contains('pw-grip')) return;
          if (node.hidden || getComputedStyle(node).display === 'none') return;
          // Text inside a padded block needs that block's right padding too.
          if (node !== cell) padR = parseFloat(getComputedStyle(node).paddingRight) || 0;
          const tag = node.tagName;
          if (tag === 'TEXTAREA' || tag === 'INPUT') {
            const r = node.getBoundingClientRect().left + textW(node, node.value || node.placeholder) * Z;
            if (r > right) right = r; return;
          }
          if (tag === 'SELECT') {
            const t = node.selectedOptions && node.selectedOptions[0] ? node.selectedOptions[0].textContent : '';
            const r = node.getBoundingClientRect().left + (textW(node, t) + 22) * Z;   // + the arrow
            if (r > right) right = r; return;
          }
          // A bar or other wordless element counts by its box.
          if (!node.textContent.trim()) { const b = node.getBoundingClientRect(); if (b.right > right) right = b.right; return; }
          node.childNodes.forEach(ch => walk(ch, padR));
        }
      };
      walk(cell, 0);
      return (right - base) / Z;
    };
    measured = ths.map((th, i) => {
      // The prose column's heading still has to fit on one line.
      if (th.dataset.pcol === PROSE) { table.dataset.proseMin = Math.ceil(inkRight(th) + pad); return 0; }
      let w = inkRight(th);
      dataRows().forEach(tr => {
        const td = tr.children[i];
        if (td) w = Math.max(w, inkRight(td));
      });
      return Math.ceil(w);
    });
  } catch (_) { measured = null; }
  finally {
    table.classList.remove('pg-measuring');
    table.style.tableLayout = prev.layout || '';
    table.style.width = prev.width || '';
    cols.forEach((c, i) => { c.style.width = prev.cols[i]; });
  }
  if (!measured) return;
  cols.forEach((c, i) => {
    if (c.dataset.pcol === PROSE) return;
    c.style.width = Math.max(Number(c.dataset.pmin) || 40, measured[i] + pad + 2) + 'px';
  });
  _portalFitProse(table);
}

// The prose column takes whatever the wrap has left; the table never runs
// past the wrap. Called after Compress and after the first columns of a set
// of grids are lined up.
function _portalFitProse(table) {
  const wrap = table.parentElement;
  const cols = Array.from(table.querySelectorAll('col[data-pcol]'));
  if (!wrap || !cols.length) return;
  const PROSE = table.dataset.prose || cols[0].dataset.pcol;
  const prose = cols.find(c => c.dataset.pcol === PROSE) || cols[0];
  const sum = () => cols.reduce((n, c) => n + (parseFloat(c.style.width) || 0), 0);
  const fixed = cols.reduce((n, c) => n + (c === prose ? 0 : (parseFloat(c.style.width) || 0)), 0);
  const floor = Math.max(140, Number(table.dataset.proseMin) || 0);
  prose.style.width = Math.max(floor, (wrap.clientWidth - 2) - fixed) + 'px';
  table.style.width = sum() + 'px';
  // Correct against the rendered table, not the plan.
  for (let pass = 0; pass < 3; pass++) {
    const over = table.offsetWidth - wrap.clientWidth;
    if (over <= 0) break;
    const next = Math.max(floor, (parseFloat(prose.style.width) || 0) - over - 1);
    if (next === parseFloat(prose.style.width)) break;
    prose.style.width = next + 'px';
    table.style.width = sum() + 'px';
  }
  table.dataset.userSized = '1';
  const out = {};
  cols.forEach(c => { out[c.dataset.pcol] = parseFloat(c.style.width) || 120; });
  try { localStorage.setItem('sdcPortalCols:' + table.dataset.grid, JSON.stringify(out)); } catch (_) {}
}

// Grids stacked on a page read as one when their first columns line up.
// Every grid's first column takes the widest first column among them.
function _portalAlignFirstCol(tables) {
  const first = (t) => t.querySelector('col[data-pcol]');
  const list = Array.from(tables).filter(t => first(t));
  if (list.length < 2) return;
  const w = Math.max(...list.map(t => parseFloat(first(t).style.width) || 0));
  list.forEach(t => { first(t).style.width = w + 'px'; _portalFitProse(t); });
}

function _wirePortalGrids(root) {
  root.querySelectorAll('.pg-tools').forEach(bar => {
    const wrap = bar.nextElementSibling;
    const table = wrap && wrap.querySelector('table[data-grid]');
    if (!table) return;
    const c = bar.querySelector('[data-pcompress]');
    if (c) c.onclick = () => _portalCompressGrid(table);
  });
  root.querySelectorAll('table[data-grid]').forEach(table => {
    let saved = null;
    try { saved = localStorage.getItem('sdcPortalCols:' + table.dataset.grid); } catch (_) {}
    if (saved) table.dataset.userSized = '1';
    _fitPortalGrid(table);
    const gridId = table.dataset.grid;
    const sumWidths = () => Array.from(table.querySelectorAll('col[data-pcol]'))
      .reduce((n, c) => n + (parseFloat(c.style.width) || 0), 0);
    table.querySelectorAll('[data-pgrip]').forEach(grip => {
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const col = table.querySelector('col[data-pcol="' + grip.dataset.pgrip + '"]');
        if (!col) return;
        const startX = e.clientX;
        const startW = parseFloat(col.style.width) || 120;
        document.body.classList.add('pcol-resizing');
        grip.classList.add('is-dragging');
        table.dataset.userSized = '1';
        const move = (ev) => {
          col.style.width = Math.max(60, startW + (ev.clientX - startX)) + 'px';
          table.style.width = sumWidths() + 'px';
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.classList.remove('pcol-resizing');
          grip.classList.remove('is-dragging');
          const out = {};
          table.querySelectorAll('col[data-pcol]').forEach(c => { out[c.dataset.pcol] = parseFloat(c.style.width) || 120; });
          try { localStorage.setItem('sdcPortalCols:' + gridId, JSON.stringify(out)); } catch (_) {}
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
  });
}

function _portalWorkSection(label, kind, rows, colCount, extra, note) {
  const head = `<tr class="pw-sec pw-sec-${kind}"><td colspan="${colCount}">
    <span class="pw-sec-name">${escapeHtml(label)}</span>
    ${note ? `<span class="pw-sec-note">${escapeHtml(note)}</span>` : ''}
    ${extra || ''}
  </td></tr>`;
  if (!rows.length) {
    const none = kind === 'behind' ? 'Nothing is a week or more behind.'
      : kind === 'running' ? 'Nothing open on this machine right now.'
      : 'Nothing closed out in this window.';
    return head + `<tr class="pw-empty"><td colspan="${colCount}">${escapeHtml(none)}</td></tr>`;
  }
  return head + rows.map(r => {
    const n = Math.max(0, Math.min(100, Number(r.pct) || 0));
    const lateCls = (kind === 'behind') ? ' is-late' : '';
    let driftTxt = r.drift ? r.drift.text : (kind === 'recent' ? '—' : 'on plan');
    let driftCls = r.drift ? r.drift.cls : '';
    if (kind !== 'behind' && r.drift && r.drift.cls === 'is-behind') {
      driftTxt = r.drift.text.replace(' behind', '');
      driftCls = 'is-within';
    }
    return `<tr class="pw-row">
      <td class="pw-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
      <td class="pw-who">${escapeHtml(r.assignee || '—')}</td>
      <td class="pw-pct"><span class="pw-bar"><span style="width:${n}%"></span></span><span class="pw-num">${n}%</span></td>
      <td class="pw-due${lateCls}">${escapeHtml(portalDate(r.due))}</td>
      <td class="pw-done">${escapeHtml(portalDate(r.when))}</td>
      <td class="pw-drift ${driftCls}">${escapeHtml(driftTxt)}</td>
    </tr>`;
  }).join('');
}

function _portalWorkGrid(work) {
  const n = PORTAL_WORK_COLS.length;
  const win = PORTAL_RECENT_WINDOWS.find(w => w.days === _portalRecentDays) || PORTAL_RECENT_WINDOWS[1];
  const picker = `<select class="pw-sec-win" data-recent-win>${PORTAL_RECENT_WINDOWS.map(w =>
    `<option value="${w.days}" ${w.days === _portalRecentDays ? 'selected' : ''}>${escapeHtml(w.label)}</option>`).join('')}</select>`;
  const body = [
    _portalWorkSection('Behind schedule', 'behind', work.behind, n),
    _portalWorkSection('On or ahead of schedule', 'running', work.running, n, '',
      '(within our one-week tolerance)'),
    _portalWorkSection('Completed recently', 'recent', work.recent, n, picker),
  ].join('');
  return _portalGridHtml('work', PORTAL_WORK_COLS, body, 'portal-work');
}

// ── Progress / event status (donut + ring charts) ───────────────────────

// What a customer means by "your team" is the people actually touching their
// machine — every task carries an assignee, and the team table carries each
// person's discipline.
const PORTAL_ROLES = {
  pm:      'Project management',
  mech:    'Mechanical engineering',
  controls:'Controls engineering',
  build:   'Build',
  wire:    'Wiring',
  service: 'Service',
  mfgops:  'Manufacturing',
  ops:     'Operations',
  sales:   'Sales / Applications',
};
const PORTAL_ROLE_ORDER = ['pm', 'mech', 'controls', 'build', 'wire', 'sales', 'service', 'mfgops', 'ops', 'other'];

// How far back "completed recently" looks. A month by default.
const PORTAL_RECENT_WINDOWS = [
  { days: 14, label: 'last two weeks' },
  { days: 30, label: 'last month' },
  { days: 60, label: 'last two months' },
];
let _portalRecentDays = 30;
let _portalMachine = null;

const PORTAL_PROGRESS_PHASES = [
  { label: 'Kickoff',                g: 'kickoff' },
  { label: 'Mechanical engineering', g: 'design_build', d: 'engineering', sub: 'mech' },
  { label: 'Controls engineering',   g: 'design_build', d: 'engineering', sub: 'controls' },
  { label: 'General engineering',    g: 'design_build', d: 'engineering', sub: 'general' },
  { label: 'Procurement',            g: 'design_build', d: 'procurement' },
  { label: 'Build',                  g: 'design_build', d: 'shop', sub: 'build' },
  { label: 'Wiring',                 g: 'design_build', d: 'shop', sub: 'wire' },
  { label: 'Testing',                g: 'machine_testing' },
  { label: 'Teardown & install',     g: 'teardown_install' },
];

// A ring rather than a bar: nine of these read as a row of gauges you can
// scan, where nine bars read as a chart you have to study.
function _portalDonut(pct, size) {
  const r = (size / 2) - 5;
  const c = 2 * Math.PI * r;
  const on = c * Math.min(Math.max(pct, 0), 100) / 100;
  const mid = size / 2;
  return `<svg class="pdonut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${pct}% complete">
    <circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--surface-alt, #f1f5f9)" stroke-width="8"></circle>
    <circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--anchor-fill, #befa4f)" stroke-width="8"
      stroke-linecap="round" stroke-dasharray="${on.toFixed(2)} ${(c - on).toFixed(2)}"
      transform="rotate(-90 ${mid} ${mid})"></circle>
    <text x="${mid}" y="${mid}" text-anchor="middle" dominant-baseline="central"
      style="font-family:sans-serif;font-size:${Math.round(size / 3.6)}px;font-weight:800;fill:var(--text);">${pct}%</text>
  </svg>`;
}

// Segments of one whole, drawn as a ring. Counts, not percentages, because
// "three tasks behind" is the sentence people say.
function _portalRing(segments, size) {
  const total = segments.reduce((n, x) => n + x.n, 0);
  const r = (size / 2) - 6;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  let at = 0;
  const arcs = segments.filter(x => x.n > 0).map(x => {
    const on = c * (x.n / total);
    const dash = `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="${x.color}" stroke-width="10"
      stroke-dasharray="${on.toFixed(2)} ${(c - on).toFixed(2)}" stroke-dashoffset="${(-at).toFixed(2)}"
      transform="rotate(-90 ${mid} ${mid})"><title>${escapeHtml(x.label)}: ${x.n}</title></circle>`;
    at += on;
    return dash;
  }).join('');
  return `<svg class="pdonut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
      aria-label="${escapeHtml(segments.map(x => x.label + ' ' + x.n).join(', '))}">
    <circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--surface-alt, #f1f5f9)" stroke-width="10"></circle>
    ${arcs}
    <text x="${mid}" y="${mid - 7}" text-anchor="middle" dominant-baseline="central"
      style="font-family:sans-serif;font-size:${Math.round(size / 3.4)}px;font-weight:800;fill:var(--text);">${total}</text>
    <text x="${mid}" y="${mid + 15}" text-anchor="middle" dominant-baseline="central"
      style="font-family:sans-serif;font-size:11px;font-weight:700;fill:var(--text-muted);">tasks</text>
  </svg>`;
}

// Columns on a shared baseline. Drawn in HTML rather than SVG so the labels
// wrap and the whole thing reflows on a narrow screen.
function _portalBars(items, variant) {
  return `<div class="pbars ${variant || ''}">${items.map(x => `<div class="pbar">
    <span class="pbar-n">${escapeHtml(x.text != null ? String(x.text) : x.pct + '%')}</span>
    <span class="pbar-track"><i style="height:${Math.max(x.pct, 2)}%"></i></span>
    <span class="pphase-label">${escapeHtml(x.label)}</span>
  </div>`).join('')}</div>`;
}

// How the task list splits four ways. Behind wins over in-progress: a row
// that is late is late whatever percentage it is sitting at.
function _portalTaskMix(rows) {
  const today = _ymdLocal(new Date());
  const mix = { complete: 0, running: 0, behind: 0, notStarted: 0 };
  rows.forEach(t => {
    if (!(t.name || '').trim()) return;
    mix[_portalRowState(t, today)]++;
  });
  return mix;
}

function _portalProgressHtml(projects, machine) {
  const rows = state.tasks.filter(t => projects.includes(t.project))
    .filter(t => !machine || !t.machine || t.machine === machine);
  const overall = _portalPercent(rows);
  if (overall == null) return '';
  const planned = _portalPlannedPercent(rows);
  const gap = planned == null ? null : overall - planned;
  const gapCls = gap == null ? '' : (gap >= 0 ? 'is-ok' : (gap <= -10 ? 'is-late' : 'is-warn'));
  const gapTxt = gap == null ? '—' : (gap > 0 ? '+' : '') + gap + ' pts';
  const cells = PORTAL_PROGRESS_PHASES.map(ph => {
    const mine = rows.filter(t => t.phase_group === ph.g
      && (!ph.d || t.department === ph.d)
      && (!ph.sub || t.sub_department === ph.sub));
    const pct = _portalPercent(mine);
    if (pct == null) return null;
    return { label: ph.label, pct };
  }).filter(Boolean);
  return `<section class="portal-block">
    <h2 class="portal-h2">Progress</h2>
    <p class="portal-note">Should be is the share of the plan due by today — every task counted by its
    scheduled days, not as one of a list, so it ramps with the work the way the crew does.</p>
    <div class="portal-prog">
      <div class="pprog-overall">
        ${_portalDonut(overall, 128)}
        <span class="pphase-label">Whole machine</span>
      </div>
      ${planned == null ? '' : `<dl class="pprog-vs">
        <div><dt>Should be</dt><dd>${planned}%</dd></div>
        <div><dt>Actually</dt><dd>${overall}%</dd></div>
        <div class="pprog-gap ${gapCls}"><dt>Variance</dt><dd>${escapeHtml(gapTxt)}</dd></div>
      </dl>`}
      <div class="pprog-phases">${_portalBars(cells)}</div>
    </div>
  </section>`;
}

function _portalDeptChartHtml(rows) {
  const today = _ymdLocal(new Date());
  const items = PORTAL_PROGRESS_PHASES.map(ph => {
    const mine = rows.filter(t => t.phase_group === ph.g
      && (!ph.d || t.department === ph.d)
      && (!ph.sub || t.sub_department === ph.sub)
      && (t.name || '').trim());
    if (!mine.length) return null;
    const done = mine.filter(t => _portalRowState(t, today) === 'complete').length;
    return { label: ph.label, pct: Math.round((done / mine.length) * 100),
             text: done + '/' + mine.length };
  }).filter(Boolean);
  if (!items.length) return '';
  return `<div class="pdept-wrap">
    <div class="pdept-head">Events complete by department</div>
    ${_portalBars(items, 'pbars-blue')}
  </div>`;
}

function _portalWorkHtml(projects, machine) {
  const rows = state.tasks.filter(t => projects.includes(t.project))
    .filter(t => !machine || !t.machine || t.machine === machine);
  if (!rows.length) return '';
  const work = portalWork(rows);
  const mix = _portalTaskMix(rows);
  const segs = [
    { label: 'Complete',          n: mix.complete,   color: '#74c415' },
    { label: 'On or ahead ',      n: mix.running,    color: '#1574c4' },
    { label: 'Behind schedule',   n: mix.behind,     color: '#d92d20' },
    { label: 'Not started yet',   n: mix.notStarted, color: '#c8d5e3' },
  ];
  const legend = segs.map(x => `<li><span class="pmix-dot" style="background:${x.color}"></span>
    <span class="pmix-label">${escapeHtml(x.label)}</span><span class="pmix-n">${x.n}</span></li>`).join('');
  return `<section class="portal-block">
    <h2 class="portal-h2">Event status</h2>
    <p class="portal-note">Every task, action and milestone on the schedule. Schedules are reviewed weekly,
    so a week is the tolerance: behind means a full week or more past plan.</p>
    <div class="portal-mix">
      <div class="pmix-ring">
        ${_portalRing(segs, 128)}
        <ul class="pmix-legend">${legend}</ul>
      </div>
      ${_portalDeptChartHtml(rows)}
    </div>
    ${_portalWorkGrid(work)}
  </section>`;
}
