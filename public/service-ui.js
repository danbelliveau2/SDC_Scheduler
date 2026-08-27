'use strict';
/**
 * service-ui.js — the Service module (Monica R2 §13, §14, §15, §20).
 *
 * Kept OUT of app.js deliberately. app.js is already the everything-file at
 * 28k lines; the Service module is a self-contained page with its own data,
 * its own state and no interaction with the Gantt render chain, so it lives
 * beside comments-ui.js / presence-ui.js as its own script instead.
 *
 * app.js touches this in exactly one place: setView('service') calls
 * window.renderServicePage().
 *
 * ONE dataset, six views (§13) — Service Log / Open / Work Orders / My Service
 * Work / Scheduled / Completed are query-string variants of two endpoints, not
 * six tables.
 *
 * Public API (window globals):
 *   renderServicePage()            — draw the page (called by app.js setView)
 *   openServiceRequest(id)         — open the lifecycle detail drawer (§14)
 *   openServiceWorkOrder(woId)     — open a WO's parent, scrolled to that WO
 *                                    (this is what the emailed link hits)
 */

// WRAPPED IN AN IIFE — do not unwrap.
//
// index.html loads this as a classic script, so every top-level const/function
// here would otherwise land in the SAME global scope as app.js. A name used by
// both is not a shadowing warning, it is a SyntaxError ("Identifier X has
// already been declared") that kills this ENTIRE file at parse time — so
// window.renderServicePage never gets defined, setView('service') silently
// catches the ReferenceError, and the Service page renders as a blank white
// panel with no obvious cause.
//
// That is exactly what happened with fmtDate, which app.js also declares
// (app.js:1215). app.js is 28k lines and growing, so the collision surface only
// gets worse. The IIFE removes the whole class of failure: nothing escapes
// except the handful of deliberate window.* exports at the bottom.
(function () {

// ── State ────────────────────────────────────────────────────────────────────
const _svc = {
  view: 'log',           // log | open | work-orders | mine | scheduled | completed
  requests: [],
  workOrders: [],
  summary: {},
  employees: [],
  detail: null,          // { request, workOrders, attachments, history }
  filters: { search: '', urgency: '', status: '', department: '', location: '', warranty: '', employee: '', machine_type: '' },
  loading: false,
};

// Views backed by the work-orders endpoint rather than the requests endpoint.
const _WO_VIEWS = new Set(['work-orders', 'mine', 'scheduled']);

const VIEWS = [
  { key: 'log',         label: 'Service Log',     hint: 'Every Service request.' },
  { key: 'open',        label: 'Open Service',    hint: 'Requests that are not complete.' },
  { key: 'work-orders', label: 'Work Orders',     hint: 'All internal Work Orders.' },
  { key: 'mine',        label: 'My Service Work', hint: 'Work Orders assigned to you.' },
  { key: 'scheduled',   label: 'Scheduled',       hint: 'Future Work Orders.' },
  { key: 'completed',   label: 'Completed',       hint: 'Completed requests, for reference.' },
];

const URGENCY = {
  machine_down:   { label: 'Machine down',  cls: 'svc-u-down' },
  urgent_running: { label: 'Urgent',        cls: 'svc-u-urgent' },
  schedule:       { label: 'Schedule',      cls: 'svc-u-sched' },
  quote_mod:      { label: 'Quote mod',     cls: 'svc-u-quote' },
};
const DEPARTMENTS = { mechanical: 'Mechanical Eng', controls: 'Controls Eng', shop: 'Shop', all: 'All' };
const WARRANTY    = { warranty: 'Warranty', non_warranty: 'Not warranty', unknown: 'Unknown' };
const MACHINE_TYPES = { sdc: 'SDC machine', non_sdc: 'Non-SDC machine' };

// Free-text operational status (§17) — a starting vocabulary the coordinator
// can override by typing. Deliberately NOT enforced server-side: §17 says not
// to invent a large arbitrary status workflow.
const STATUS_SUGGESTIONS = ['new', 'reviewing', 'quoted', 'awaiting PO', 'scheduled', 'in progress', 'awaiting parts', 'awaiting customer', 'complete'];

// ── Helpers ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => (d ? String(d).slice(0, 10) : '—');
const fmtWhen = (d) => (d ? String(d).replace('T', ' ').slice(0, 16) : '—');

// app.js's showToast takes (message, { kind }); showConfirmDialog takes an
// options object and resolves to a boolean. Both are wrapped here so this file
// calls them the simple way and never falls back to a native alert/confirm —
// the house rule is in-app dialogs.
function toast(msg, kind) {
  if (typeof window.showToast === 'function') return window.showToast(msg, { kind: kind || 'info' });
  console.log(`[service] ${msg}`);
}

async function confirmDialog(message, opts) {
  if (typeof window.showConfirmDialog === 'function') {
    return window.showConfirmDialog({ message, ...(opts || {}) });
  }
  return true; // dialog helper unavailable — don't dead-end the user
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function urgencyPill(u) {
  const m = URGENCY[u];
  if (!m) return '<span class="svc-pill">—</span>';
  return `<span class="svc-pill ${m.cls}">${esc(m.label)}</span>`;
}

function statusPill(r) {
  if (r.service_complete) return '<span class="svc-pill svc-done">Complete</span>';
  return `<span class="svc-pill">${esc(r.current_status || 'new')}</span>`;
}

// The three checkboxes as a compact glyph strip — a coordinator scanning the
// log wants "where is this one up to" at a glance, not three columns (§20).
function progressStrip(r) {
  const step = (on, label) =>
    `<span class="svc-step ${on ? 'on' : ''}" title="${esc(label)}">${on ? '✓' : '·'}</span>`;
  return `<span class="svc-steps">${step(r.quote_sent, 'Quote sent')}${step(r.po_received, 'PO received')}${step(r.service_complete, 'Service complete')}</span>`;
}

// ── Data loading ─────────────────────────────────────────────────────────────
function buildQuery() {
  const f = _svc.filters;
  const q = new URLSearchParams();
  if (_WO_VIEWS.has(_svc.view)) {
    q.set('view', _svc.view === 'work-orders' ? 'all' : _svc.view);
    if (f.employee) q.set('employee', f.employee);
    if (f.location) q.set('location', f.location);
  } else {
    if (_svc.view === 'open' || _svc.view === 'completed') q.set('view', _svc.view);
    for (const k of ['search', 'urgency', 'status', 'department', 'location', 'warranty', 'employee', 'machine_type']) {
      if (f[k]) q.set(k === 'search' ? 'search' : k, f[k]);
    }
  }
  return q.toString();
}

async function loadService() {
  _svc.loading = true;
  try {
    const qs = buildQuery();
    const [rows, summary] = await Promise.all([
      api(`/api/service/${_WO_VIEWS.has(_svc.view) ? 'work-orders' : 'requests'}?${qs}`),
      api('/api/service/summary').catch(() => ({})),
    ]);
    if (_WO_VIEWS.has(_svc.view)) _svc.workOrders = rows || [];
    else _svc.requests = rows || [];
    _svc.summary = summary || {};
  } catch (e) {
    toast(`Could not load Service data: ${e.message}`, 'error');
  } finally {
    _svc.loading = false;
  }
}

async function loadEmployees() {
  if (_svc.employees.length) return _svc.employees;
  try { _svc.employees = await api('/api/service/employees'); } catch (_) { _svc.employees = []; }
  return _svc.employees;
}

// ── Page render ──────────────────────────────────────────────────────────────
async function renderServicePage() {
  const root = document.getElementById('view-service');
  if (!root) return;
  if (!root.dataset.booted) {
    root.dataset.booted = '1';
    root.innerHTML = `
      <div class="svc-wrap">
        <div class="svc-head">
          <div class="svc-tabs" id="svcTabs"></div>
          <div class="svc-head-right">
            <input type="search" id="svcSearch" class="svc-search" placeholder="Search request #, company, requestor, job, details…">
            <button class="svc-btn svc-btn-primary" id="svcNewBtn" type="button">+ Log a request</button>
          </div>
        </div>
        <div class="svc-filters" id="svcFilters"></div>
        <div class="svc-body" id="svcBody"></div>
      </div>
      <div class="svc-drawer-scrim" id="svcScrim" hidden></div>
      <aside class="svc-drawer" id="svcDrawer" hidden></aside>`;

    document.getElementById('svcNewBtn').addEventListener('click', openNewRequestForm);

    // Debounced so typing doesn't fire a query per keystroke.
    let t = null;
    document.getElementById('svcSearch').addEventListener('input', (e) => {
      clearTimeout(t);
      const v = e.target.value;
      t = setTimeout(async () => { _svc.filters.search = v; await loadService(); drawBody(); }, 250);
    });

    document.getElementById('svcScrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('svcDrawer').hidden) closeDrawer();
    });

    // Live updates — the server emits service:updated on every mutation, so a
    // coordinator watching the log sees a website submission arrive without
    // refreshing. realtime-ui.js owns the socket (it's private to that file's
    // IIFE), so it calls this hook rather than us reaching for the socket.
    window.onServiceUpdated = async () => {
      if (document.body.dataset.view !== 'service') return;
      await loadService();
      drawTabs();
      drawBody();
      if (_svc.detail) await refreshDrawer(_svc.detail.request.id);
    };
  }

  drawTabs();
  drawFilters();
  document.getElementById('svcBody').innerHTML = '<div class="svc-empty">Loading…</div>';
  await Promise.all([loadService(), loadEmployees()]);
  drawTabs();
  // Filters are redrawn AFTER the roster resolves — the Employee/Assigned
  // dropdown is built from it, so the first paint (which happens before the
  // fetch lands) would otherwise leave that filter stuck showing only "All".
  drawFilters();
  drawBody();
}

function drawTabs() {
  const s = _svc.summary;
  const counts = {
    log: s.total, open: s.open, 'work-orders': s.work_orders,
    mine: s.mine, scheduled: s.scheduled, completed: s.completed,
  };
  document.getElementById('svcTabs').innerHTML = VIEWS.map(v => `
    <button type="button" class="svc-tab ${_svc.view === v.key ? 'is-active' : ''}"
            data-view="${v.key}" title="${esc(v.hint)}">
      ${esc(v.label)}${counts[v.key] != null ? ` <span class="svc-count">${counts[v.key]}</span>` : ''}
    </button>`).join('') +
    (s.machine_down ? `<span class="svc-alarm" title="Open requests with a machine down">${s.machine_down} machine down</span>` : '');

  document.getElementById('svcTabs').querySelectorAll('.svc-tab').forEach(b => {
    b.addEventListener('click', async () => {
      _svc.view = b.dataset.view;
      try { localStorage.setItem('sdcServiceView', _svc.view); } catch (_) {}
      drawTabs(); drawFilters();
      document.getElementById('svcBody').innerHTML = '<div class="svc-empty">Loading…</div>';
      await loadService();
      drawTabs(); drawBody();
    });
  });
}

// §15's filter set. Work-order views get the filters that make sense there —
// showing an urgency filter over a list that has no urgency column is noise.
function drawFilters() {
  const f = _svc.filters;
  // The no-filter option is "Any", not "All": "All" is itself one of Monica's
  // real SDC Department values (§2), so labelling the empty option "All" put
  // two identical-looking entries in the Department dropdown meaning opposite
  // things — "don't filter" and "filter to the All department".
  const sel = (id, label, value, options) => `
    <label class="svc-filter">
      <span>${esc(label)}</span>
      <select data-filter="${id}">
        <option value="">Any</option>
        ${options.map(o => `<option value="${esc(o.v)}" ${value === o.v ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}
      </select>
    </label>`;

  const employeeOpts = _svc.employees.map(e => ({ v: e.name, l: e.name }));
  let html;
  if (_WO_VIEWS.has(_svc.view)) {
    html = sel('employee', 'Employee', f.employee, employeeOpts) +
           sel('location', 'Remote/On-site', f.location, [{ v: 'remote', l: 'Remote' }, { v: 'onsite', l: 'On-site' }]);
  } else {
    html =
      sel('urgency', 'Urgency', f.urgency, Object.entries(URGENCY).map(([v, m]) => ({ v, l: m.label }))) +
      sel('department', 'Department', f.department, Object.entries(DEPARTMENTS).map(([v, l]) => ({ v, l }))) +
      sel('location', 'Remote/On-site', f.location, [{ v: 'remote', l: 'Remote' }, { v: 'onsite', l: 'On-site' }]) +
      sel('warranty', 'Warranty', f.warranty, Object.entries(WARRANTY).map(([v, l]) => ({ v, l }))) +
      sel('machine_type', 'Machine', f.machine_type, Object.entries(MACHINE_TYPES).map(([v, l]) => ({ v, l }))) +
      sel('employee', 'Assigned', f.employee, employeeOpts);
  }
  const anyOn = Object.values(f).some(v => v);
  if (anyOn) html += `<button type="button" class="svc-btn svc-btn-ghost" id="svcClearFilters">Clear filters</button>`;

  const el = document.getElementById('svcFilters');
  el.innerHTML = html;
  el.querySelectorAll('select[data-filter]').forEach(s => {
    s.addEventListener('change', async () => {
      _svc.filters[s.dataset.filter] = s.value;
      await loadService(); drawFilters(); drawBody();
    });
  });
  const clear = document.getElementById('svcClearFilters');
  if (clear) clear.addEventListener('click', async () => {
    _svc.filters = { search: '', urgency: '', status: '', department: '', location: '', warranty: '', employee: '', machine_type: '' };
    document.getElementById('svcSearch').value = '';
    await loadService(); drawFilters(); drawBody();
  });
}

function drawBody() {
  const body = document.getElementById('svcBody');
  if (_WO_VIEWS.has(_svc.view)) return drawWorkOrderTable(body);
  return drawRequestTable(body);
}

// Column widths follow the house rule: description-ish columns take the
// remainder, dates are sized for an ISO date, glyph columns stay tiny.
function drawRequestTable(body) {
  const rows = _svc.requests;
  if (!rows.length) {
    body.innerHTML = `<div class="svc-empty">
      ${_svc.view === 'completed' ? 'No completed Service requests yet.' : 'No Service requests match.'}
    </div>`;
    return;
  }
  body.innerHTML = `
    <table class="svc-table">
      <colgroup>
        <col style="width:118px"><col style="width:60px"><col style="width:190px">
        <col style="width:auto"><col style="width:110px"><col style="width:96px">
        <col style="width:130px"><col style="width:88px"><col style="width:70px"><col style="width:96px">
      </colgroup>
      <thead>
        <tr>
          <th>Request #</th><th title="Quote sent · PO received · Service complete">Steps</th>
          <th>Company</th><th>Details</th><th>Job / Serial</th><th>Urgency</th>
          <th>Assigned</th><th>Status</th><th title="Work orders (open / total)">WOs</th><th>Received</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr data-id="${r.id}" class="${r.urgency === 'machine_down' && !r.service_complete ? 'svc-row-down' : ''}">
            <td class="svc-mono">${esc(r.request_no)}${r.attachment_count ? ` <span class="svc-clip" title="${r.attachment_count} attachment(s)">📎</span>` : ''}</td>
            <td>${progressStrip(r)}</td>
            <td>${esc(r.company_name) || '—'}<div class="svc-sub">${esc(r.requestor_name) || ''}</div></td>
            <td class="svc-detail-cell">${esc(String(r.service_details || '').slice(0, 220))}</td>
            <td>${esc(r.machine_serial || r.job_number) || '—'}${
              r.machine_type === 'non_sdc' ? ' <span class="svc-pill svc-nonsdc" title="Not an SDC-built machine — no build history or SDC warranty">non-SDC</span>' : ''}</td>
            <td>${urgencyPill(r.urgency)}</td>
            <td>${esc(r.assigned_employees || r.resource_assigned) || '<span class="svc-sub">unassigned</span>'}</td>
            <td>${statusPill(r)}</td>
            <td class="svc-num">${r.wo_count ? `${r.wo_open}/${r.wo_count}` : '—'}</td>
            <td class="svc-sub">${fmtDate(r.created_at)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  body.querySelectorAll('tbody tr').forEach(tr =>
    tr.addEventListener('click', () => openServiceRequest(Number(tr.dataset.id))));
}

function drawWorkOrderTable(body) {
  const rows = _svc.workOrders;
  if (!rows.length) {
    body.innerHTML = `<div class="svc-empty">${
      _svc.view === 'mine' ? 'You have no Service Work Orders assigned.' :
      _svc.view === 'scheduled' ? 'No upcoming Work Orders scheduled.' : 'No Work Orders yet.'
    }</div>`;
    return;
  }
  body.innerHTML = `
    <table class="svc-table">
      <colgroup>
        <col style="width:150px"><col style="width:106px"><col style="width:150px">
        <col style="width:170px"><col style="width:auto"><col style="width:78px">
        <col style="width:62px"><col style="width:100px"><col style="width:120px">
      </colgroup>
      <thead>
        <tr>
          <th>Work Order</th><th class="svc-col-date">Date</th><th>Employee</th><th>Customer</th>
          <th>Task</th><th>Site</th><th title="Budgeted hours">Hrs</th><th>Status</th><th>Report</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(w => {
          const overdue = woOverdue(w);
          return `
          <tr data-request="${w.service_request_id}" data-wo="${w.id}"
              class="${w.urgency === 'machine_down' && w.status === 'open' ? 'svc-row-down' : ''}">
            <td class="svc-mono">${esc(w.wo_no)}</td>
            <td class="svc-col-date ${overdue ? 'svc-overdue' : ''}">${fmtDate(w.task_date)}${overdue ? ' <span title="The last day has passed and this Work Order is still open">!</span>' : ''}${
              w.end_date && w.task_date && w.end_date > w.task_date
                ? `<div class="svc-sub">through ${fmtDate(w.end_date)}</div>` : ''}</td>
            <td>${esc(w.employee_name) || '—'}</td>
            <td>${esc(w.company_name) || '—'}<div class="svc-sub">${esc(w.request_no)}</div></td>
            <td class="svc-detail-cell">${esc(String(w.task_description || '').slice(0, 200))}</td>
            <td>${w.location_type === 'onsite' ? 'On-site' : w.location_type === 'remote' ? 'Remote' : '—'}</td>
            <td class="svc-num">${w.budgeted_hours != null ? w.budgeted_hours : '—'}</td>
            <td>${w.status === 'complete'
                  ? '<span class="svc-pill svc-done">Complete</span>'
                  : '<span class="svc-pill">Open</span>'}</td>
            <td>${w.report_id
                  ? `<span class="svc-pill ${w.report_status === 'submitted' ? 'svc-done' : ''}">${w.report_status === 'submitted' ? 'Submitted' : 'Draft'}</span>`
                  : '<span class="svc-sub">—</span>'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  body.querySelectorAll('tbody tr').forEach(tr =>
    tr.addEventListener('click', () => openServiceRequest(Number(tr.dataset.request), Number(tr.dataset.wo))));
}

// ── Detail drawer (§14) ──────────────────────────────────────────────────────
// The whole lifecycle in one place: customer request → log status → work
// orders → completion → report.
async function openServiceRequest(id, focusWoId) {
  const drawer = document.getElementById('svcDrawer');
  const scrim  = document.getElementById('svcScrim');
  drawer.hidden = false; scrim.hidden = false;
  drawer.innerHTML = '<div class="svc-empty">Loading…</div>';
  try {
    _svc.detail = await api(`/api/service/requests/${id}`);
    await loadEmployees();
    drawDrawer(focusWoId);
  } catch (e) {
    drawer.innerHTML = `<div class="svc-empty">Could not open this request: ${esc(e.message)}</div>`;
  }
}

async function refreshDrawer(id, focusWoId) {
  try { _svc.detail = await api(`/api/service/requests/${id}`); drawDrawer(focusWoId); } catch (_) {}
}

function closeDrawer() {
  document.getElementById('svcDrawer').hidden = true;
  document.getElementById('svcScrim').hidden = true;
  _svc.detail = null;
}

function drawDrawer(focusWoId) {
  const d = _svc.detail;
  if (!d) return;
  const r = d.request;
  const drawer = document.getElementById('svcDrawer');

  const field = (label, value) =>
    `<div class="svc-f"><span>${esc(label)}</span><strong>${esc(value == null || value === '' ? '—' : value)}</strong></div>`;

  drawer.innerHTML = `
    <div class="svc-drawer-head">
      <div>
        <div class="svc-drawer-no">${esc(r.request_no)} ${urgencyPill(r.urgency)}</div>
        <div class="svc-drawer-sub">${esc(r.company_name) || '—'} · received ${fmtDate(r.created_at)} · ${esc(r.source === 'website' ? 'from website' : 'logged internally')}</div>
      </div>
      <button type="button" class="svc-x" id="svcClose" title="Close">×</button>
    </div>

    <div class="svc-drawer-body">

      <section class="svc-sec">
        <h3>Customer request</h3>
        <div class="svc-fields">
          ${field('Requestor', r.requestor_name)}
          ${field('Email', r.requestor_email)}
          ${field('Phone', r.requestor_phone)}
          ${field('Machine', MACHINE_TYPES[r.machine_type] || 'Not stated')}
          ${field(r.machine_type === 'non_sdc' ? 'Make / model' : 'Machine serial / Job #', r.machine_serial || r.job_number)}
          ${field('Department needed', DEPARTMENTS[r.department_needed] || r.department_needed)}
          ${field('Remote / on-site', r.location_type === 'onsite' ? 'On-site' : r.location_type === 'remote' ? 'Remote' : null)}
          ${field('Warranty', WARRANTY[r.warranty] || r.warranty)}
          ${field('PPE', r.ppe_requirements)}
          ${r.onsite_address ? field('On-site address', r.onsite_address) : ''}
        </div>
        <div class="svc-longtext"><span>Service details</span><p>${esc(r.service_details) || '—'}</p></div>
        ${r.additional_comments ? `<div class="svc-longtext"><span>Additional comments</span><p>${esc(r.additional_comments)}</p></div>` : ''}
        ${drawAttachments(d.attachments)}
      </section>

      <section class="svc-sec">
        <h3>Service Log status</h3>
        <div class="svc-checks">
          <label><input type="checkbox" data-log="quote_sent" ${r.quote_sent ? 'checked' : ''}>
                 Service Quote Sent ${r.quote_sent_at ? `<em>${fmtDate(r.quote_sent_at)}</em>` : ''}</label>
          <label><input type="checkbox" data-log="po_received" ${r.po_received ? 'checked' : ''}>
                 PO Received ${r.po_received_at ? `<em>${fmtDate(r.po_received_at)}</em>` : ''}
                 ${r.po_amount != null ? `<em>${esc(money(r.po_amount))}</em>` : ''}</label>
          <label><input type="checkbox" data-log="service_complete" ${r.service_complete ? 'checked' : ''}>
                 Service Complete ${r.service_complete_date ? `<em>${fmtDate(r.service_complete_date)}</em>` : ''}</label>
        </div>
        <div class="svc-log-grid">
          <label>Current Status
            <input type="text" data-log="current_status" list="svcStatusList" value="${esc(r.current_status || '')}">
            <datalist id="svcStatusList">${STATUS_SUGGESTIONS.map(s => `<option value="${s}">`).join('')}</datalist>
          </label>
          <label>Resource Assigned
            <input type="text" data-log="resource_assigned" list="svcEmpList" value="${esc(r.resource_assigned || '')}">
            <datalist id="svcEmpList">${_svc.employees.map(e => `<option value="${esc(e.name)}">`).join('')}</datalist>
          </label>
          <label>Service Complete Date
            <input type="date" data-log="service_complete_date" value="${esc(fmtDate(r.service_complete_date) === '—' ? '' : fmtDate(r.service_complete_date))}">
          </label>
          <label>Customer PO #
            <input type="text" data-log="po_number" value="${esc(r.po_number || '')}" placeholder="e.g. 4500123456">
          </label>
          <label>PO Value
            <input type="text" inputmode="decimal" data-log="po_amount" value="${esc(r.po_amount != null ? r.po_amount : '')}" placeholder="172000.00">
          </label>
          <label class="svc-span">Information Needed
            <textarea data-log="information_needed" rows="2">${esc(r.information_needed || '')}</textarea>
          </label>
        </div>
      </section>

      <section class="svc-sec">
        <h3>Work Orders <button type="button" class="svc-btn svc-btn-primary svc-btn-sm" id="svcAddWo">+ Create Work Order</button></h3>
        <div id="svcWoList">${drawWorkOrders(d.workOrders)}</div>
      </section>

      <section class="svc-sec">
        <h3>History</h3>
        <ul class="svc-history">
          ${d.history.length ? d.history.map(h => `
            <li><span class="svc-sub">${fmtWhen(h.changed_at)}</span>
                <strong>${esc(h.changed_by || 'system')}</strong>
                ${esc(h.detail || h.action)}</li>`).join('')
            : '<li class="svc-sub">Nothing recorded yet.</li>'}
        </ul>
      </section>
    </div>`;

  document.getElementById('svcClose').addEventListener('click', closeDrawer);
  document.getElementById('svcAddWo').addEventListener('click', () => openWorkOrderForm(r));
  wireLogFields(r.id);
  wireWorkOrderButtons(r);

  if (focusWoId) {
    const el = drawer.querySelector(`.svc-wo[data-wo="${focusWoId}"]`);
    if (el) { el.classList.add('svc-wo-focus'); el.scrollIntoView({ block: 'center' }); }
  }
}

function drawAttachments(list) {
  if (!list || !list.length) return '';
  return `<div class="svc-attachments"><span>Attachments</span><div>${list.map(a => `
    <a class="svc-att" href="/api/service/attachments/${a.id}" target="_blank" rel="noopener"
       title="${esc(a.filename)} — ${(a.size_bytes / 1024).toFixed(0)} KB, uploaded by ${esc(a.uploaded_by || 'customer')}">
      ${/^image\//.test(a.mime_type || '') ? '🖼' : '📄'} ${esc(a.filename)}
    </a>`).join('')}</div></div>`;
}

// A Work Order's date as one string: a single day, or an inclusive range for a
// multi-day reservation (a machine move books someone for weeks, not a day).
// Whole dollars. Service PO values are quoted and discussed in whole dollars,
// and cents on a $172,000 figure are noise in a status list.
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function woSpan(w) {
  if (!w.task_date) return '—';
  if (w.end_date && w.end_date > w.task_date) return `${fmtDate(w.task_date)} – ${fmtDate(w.end_date)}`;
  return fmtDate(w.task_date);
}

// "Overdue" for a multi-day WO means the LAST day has passed, not the first —
// an engineer three days into a two-week move is not late.
function woOverdue(w) {
  const last = w.end_date && w.task_date && w.end_date > w.task_date ? w.end_date : w.task_date;
  return w.status === 'open' && !!last && last < today();
}

function drawWorkOrders(list) {
  if (!list.length) return '<div class="svc-sub">No Work Orders yet. Create one to assign an employee and a date.</div>';
  return list.map(w => {
    const overdue = woOverdue(w);
    const multi = w.end_date && w.task_date && w.end_date > w.task_date;
    return `
    <div class="svc-wo ${w.status === 'complete' ? 'is-complete' : ''}" data-wo="${w.id}">
      <div class="svc-wo-head">
        <span class="svc-mono">${esc(w.wo_no)}</span>
        <span class="${overdue ? 'svc-overdue' : ''}">${woSpan(w)}</span>
        ${multi ? '<span class="svc-pill svc-pill-span">reserved</span>' : ''}
        <strong>${esc(w.employee_name) || '—'}</strong>
        <span class="svc-sub">${w.location_type === 'onsite' ? 'On-site' : w.location_type === 'remote' ? 'Remote' : ''}</span>
        <span class="svc-sub">${w.budgeted_hours != null ? `${w.budgeted_hours} h budgeted` : ''}</span>
        <span class="svc-wo-spacer"></span>
        ${w.status === 'complete'
          ? `<span class="svc-pill svc-done">Complete ${fmtDate(w.completed_at)}</span>`
          : '<span class="svc-pill">Open</span>'}
      </div>
      <div class="svc-wo-desc">${esc(w.task_description) || '—'}</div>
      <div class="svc-wo-meta">
        ${w.notified_at ? `<span title="Work Order delivered to the employee">✉ notified ${fmtWhen(w.notified_at)}</span>` : '<span class="svc-warn">✉ not yet delivered</span>'}
        ${w.reminder_sent_at ? `<span title="Day-before reminder sent">⏰ reminded</span>` : ''}
        ${w.ppe_requirements ? `<span title="PPE required">🦺 ${esc(w.ppe_requirements)}</span>` : ''}
      </div>
      <div class="svc-wo-actions">
        ${w.status === 'complete'
          ? `<button type="button" class="svc-btn svc-btn-ghost svc-btn-sm" data-act="reopen" data-wo="${w.id}">Reopen</button>`
          : `<button type="button" class="svc-btn svc-btn-primary svc-btn-sm" data-act="complete" data-wo="${w.id}">Mark complete</button>`}
        ${w.report_id ? `<button type="button" class="svc-btn svc-btn-sm" data-act="report" data-report="${w.report_id}">
              ${w.report_status === 'submitted' ? 'View' : 'Complete'} Service Report</button>` : ''}
        <button type="button" class="svc-btn svc-btn-ghost svc-btn-sm" data-act="edit" data-wo="${w.id}">Edit</button>
        <button type="button" class="svc-btn svc-btn-ghost svc-btn-sm" data-act="resend" data-wo="${w.id}">Resend</button>
        <button type="button" class="svc-btn svc-btn-ghost svc-btn-sm svc-danger" data-act="delete" data-wo="${w.id}">Delete</button>
      </div>
    </div>`;
  }).join('');
}

// Log fields save on blur/change — no Save button, matching how the rest of
// the app's grids commit an edit.
function wireLogFields(requestId) {
  const drawer = document.getElementById('svcDrawer');
  drawer.querySelectorAll('[data-log]').forEach(el => {
    const evt = el.type === 'checkbox' ? 'change' : 'change';
    el.addEventListener(evt, async () => {
      const field = el.dataset.log;
      const value = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value;
      try {
        await api(`/api/service/requests/${requestId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        await refreshDrawer(requestId);
        await loadService(); drawTabs(); drawBody();
      } catch (e) {
        toast(`Could not save: ${e.message}`, 'error');
        if (el.type === 'checkbox') el.checked = !el.checked;
      }
    });
  });
}

function wireWorkOrderButtons(request) {
  const drawer = document.getElementById('svcDrawer');
  drawer.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const woId = Number(btn.dataset.wo);
      const act  = btn.dataset.act;
      try {
        if (act === 'complete') {
          btn.disabled = true;
          const res = await api(`/api/service/work-orders/${woId}/complete`, { method: 'POST' });
          await refreshDrawer(request.id, woId);
          await loadService(); drawTabs(); drawBody();
          if (res.report) {
            toast(`Work Order complete. Service Report ${res.report.report_no} generated.`, 'success');
            openReportForm(res.report.id);
          }
          if (res.allWorkOrdersComplete && !request.service_complete) {
            toast('Every Work Order on this request is now complete — tick "Service Complete" when the customer is signed off.', 'info');
          }
        } else if (act === 'reopen') {
          await api(`/api/service/work-orders/${woId}/reopen`, { method: 'POST' });
          await refreshDrawer(request.id, woId);
        } else if (act === 'resend') {
          const r = await api(`/api/service/work-orders/${woId}/notify`, { method: 'POST' });
          toast(r.email && r.email.sent ? 'Work Order re-sent.' : 'Sent (check SMTP configuration if nothing arrives).', 'info');
          await refreshDrawer(request.id, woId);
        } else if (act === 'edit') {
          const wo = _svc.detail.workOrders.find(w => w.id === woId);
          openWorkOrderForm(request, wo);
        } else if (act === 'report') {
          openReportForm(Number(btn.dataset.report));
        } else if (act === 'delete') {
          const ok = await confirmDialog('Delete this Work Order? Its scheduler assignment is removed too.');
          if (!ok) return;
          await api(`/api/service/work-orders/${woId}`, { method: 'DELETE' });
          await refreshDrawer(request.id);
          await loadService(); drawTabs(); drawBody();
        }
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// ── Modals ───────────────────────────────────────────────────────────────────
function modal(title, innerHtml, onSubmit, submitLabel) {
  const wrap = document.createElement('div');
  wrap.className = 'svc-modal-scrim';
  wrap.innerHTML = `
    <div class="svc-modal" role="dialog" aria-modal="true">
      <div class="svc-modal-head"><h3>${esc(title)}</h3><button type="button" class="svc-x" data-close>×</button></div>
      <form class="svc-modal-body">${innerHtml}</form>
      <div class="svc-modal-foot">
        <button type="button" class="svc-btn svc-btn-ghost" data-close>Cancel</button>
        <button type="button" class="svc-btn svc-btn-primary" data-ok>${esc(submitLabel || 'Save')}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  const okBtn = wrap.querySelector('[data-ok]');
  okBtn.addEventListener('click', async () => {
    const form = wrap.querySelector('form');
    const data = {};
    form.querySelectorAll('[name]').forEach(el => {
      data[el.name] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value;
    });
    okBtn.disabled = true;
    try { await onSubmit(data, wrap); close(); }
    catch (e) { toast(e.message, 'error'); okBtn.disabled = false; }
  });
  const first = wrap.querySelector('input, select, textarea');
  if (first) first.focus();
  return wrap;
}

// Internally-logged request — the phone-call path. Same fields as the website
// form so the Service Log has one shape regardless of how a request arrived.
function openNewRequestForm() {
  modal('Log a Service request', `
    <div class="svc-form-grid">
      <label class="svc-span">Company Name<input name="company_name" required></label>
      <label>Requestor Name<input name="requestor_name"></label>
      <label>Requestor Email<input name="requestor_email" type="email"></label>
      <label>Requestor Phone<input name="requestor_phone"></label>
      <label>Machine
        <select name="machine_type">
          ${Object.entries(MACHINE_TYPES).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </label>
      <label>Machine Serial / Job # <span style="text-transform:none;font-weight:400">(or make/model)</span>
        <input name="machine_serial"></label>
      <label>Urgency
        <select name="urgency">${Object.entries(URGENCY).map(([v, m]) => `<option value="${v}">${m.label}</option>`).join('')}</select>
      </label>
      <label>Department Needed
        <select name="department_needed"><option value="">—</option>
          ${Object.entries(DEPARTMENTS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      </label>
      <label>Remote / On-site
        <select name="location_type"><option value="">—</option><option value="remote">Remote</option><option value="onsite">On-site</option></select>
      </label>
      <label>Warranty
        <select name="warranty"><option value="">—</option>
          ${Object.entries(WARRANTY).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      </label>
      <label class="svc-span">Service Details<textarea name="service_details" rows="4"></textarea></label>
      <label class="svc-span">PPE Requirements<input name="ppe_requirements"></label>
      <label class="svc-span">On-site Address<input name="onsite_address"></label>
    </div>`,
    async (data) => {
      if (!String(data.company_name || '').trim()) throw new Error('Company Name is required.');
      // Only mirror into job_number for an SDC machine — on third-party kit
      // this field holds a make/model, which has no business in a column
      // people filter and search as a job number.
      if (data.machine_type !== 'non_sdc') data.job_number = data.machine_serial;
      data.source = 'internal';
      const created = await api('/api/service/requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      toast(`Service Request ${created.request_no} created.`, 'success');
      await loadService(); drawTabs(); drawBody();
      openServiceRequest(created.id);
    }, 'Create request');
}

// Work Order form (§6). The requestor block is shown READ-ONLY from the parent
// — §6 says it should populate from the parent rather than be re-entered, and
// showing it (rather than hiding it) is what stops someone "helpfully" typing
// it again somewhere else.
function openWorkOrderForm(request, existing) {
  const w = existing || {};
  const isEdit = !!existing;
  modal(isEdit ? `Edit ${w.wo_no}` : `Create Work Order — ${request.request_no}`, `
    <div class="svc-parent-block">
      <strong>${esc(request.company_name) || '—'}</strong> · ${esc(request.request_no)}
      <div class="svc-sub">Requestor: ${esc(request.requestor_name) || '—'}
        ${request.requestor_phone ? ` · ${esc(request.requestor_phone)}` : ''}
        ${request.requestor_email ? ` · ${esc(request.requestor_email)}` : ''}</div>
      <div class="svc-sub">Job / Machine: ${esc(request.machine_serial || request.job_number) || '—'}
        · carried onto this Work Order automatically.</div>
    </div>
    <div class="svc-form-grid">
      <label>Task Date<input name="task_date" type="date" id="svcWoStart" value="${esc(w.task_date || '')}"></label>
      <label>Through <span class="svc-sub">(leave blank for a one-day visit)</span>
        <input name="end_date" type="date" id="svcWoEnd" value="${esc(w.end_date || '')}">
      </label>
      <label class="svc-span">Required Employee
        <select name="employee_name" id="svcWoEmp">
          <option value="">—</option>
          ${_svc.employees.map(e => `<option value="${esc(e.name)}" data-email="${esc(e.email || '')}"
              ${w.employee_name === e.name ? 'selected' : ''}>${esc(e.name)}${e.discipline === 'service' ? ' (Service)' : ''}</option>`).join('')}
        </select>
      </label>
      <div class="svc-span" id="svcAvail"></div>
      <label>Employee Email<input name="employee_email" id="svcWoEmail" value="${esc(w.employee_email || '')}"
             placeholder="auto-filled from their account"></label>
      <label>On-site / Remote
        <select name="location_type">
          <option value="">—</option>
          <option value="remote" ${w.location_type === 'remote' ? 'selected' : ''}>Remote</option>
          <option value="onsite" ${w.location_type === 'onsite' ? 'selected' : ''}>On-site</option>
        </select>
      </label>
      <label>Budgeted Hours<input name="budgeted_hours" type="number" step="0.5" min="0" value="${esc(w.budgeted_hours ?? '')}"></label>
      <label>PPE Requirements<input name="ppe_requirements" value="${esc(w.ppe_requirements || request.ppe_requirements || '')}"></label>
      <label class="svc-span">On-site Location Address<input name="onsite_address" value="${esc(w.onsite_address || request.onsite_address || '')}"></label>
      <label class="svc-span">Task Description
        <textarea name="task_description" rows="4">${esc(w.task_description || request.service_details || '')}</textarea>
      </label>
      <label>SDC Remote Support — Name<input name="sdc_contact_name" value="${esc(w.sdc_contact_name || '')}"></label>
      <label>SDC Remote Support — Email<input name="sdc_contact_email" type="email" value="${esc(w.sdc_contact_email || '')}"></label>
      <label>SDC Remote Support — Phone<input name="sdc_contact_phone" value="${esc(w.sdc_contact_phone || '')}"></label>
    </div>
    ${isEdit ? '' : `<label class="svc-inline-check">
      <input type="checkbox" name="notify" checked> Email the Work Order to the employee now
    </label>`}`,
    async (data) => {
      if (!String(data.employee_name || '').trim()) throw new Error('Choose the required employee.');
      if (data.end_date && !data.task_date) throw new Error('A Work Order with an end date needs a task date.');
      if (data.task_date && data.end_date && data.end_date < data.task_date) {
        throw new Error('The end date cannot be before the task date.');
      }
      if (isEdit) {
        await api(`/api/service/work-orders/${w.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        });
        toast(`${w.wo_no} updated.`, 'success');
      } else {
        data.notify = data.notify ? true : false;
        const created = await api(`/api/service/requests/${request.id}/work-orders`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        });
        toast(`${created.wo_no} created${data.notify ? ' and sent to ' + (created.employee_name || 'the employee') : ''}.`, 'success');
      }
      await refreshDrawer(request.id);
      await loadService(); drawTabs(); drawBody();
    }, isEdit ? 'Save Work Order' : 'Create & send');

  // Auto-fill the email from the chosen employee's account — §7's "don't
  // maintain a separate Service roster" only holds if the email comes along
  // for free.
  const sel = document.getElementById('svcWoEmp');
  if (sel) sel.addEventListener('change', () => {
    const opt = sel.options[sel.selectedIndex];
    const email = opt && opt.dataset.email;
    const box = document.getElementById('svcWoEmail');
    if (box && email) box.value = email;
    else if (box && !email) box.placeholder = 'No account email on file — add one under Users';
    renderAvailability();
  });

  // ── Live availability for the chosen window (Monica: "reserve the service
  // engineering or technician resources"). Reserving someone is only a real
  // decision if you can see who is free before you commit them, so this reads
  // the same `tasks` rows the Gantt does and shows the answer in the form.
  const startEl = document.getElementById('svcWoStart');
  const endEl   = document.getElementById('svcWoEnd');
  let availSeq = 0;   // guards against a slow response overwriting a newer one

  async function renderAvailability() {
    const panel = document.getElementById('svcAvail');
    if (!panel) return;
    const start = startEl && startEl.value;
    const end   = (endEl && endEl.value) || start;
    if (!start) { panel.innerHTML = ''; return; }
    if (end < start) {
      panel.innerHTML = `<div class="svc-avail svc-avail-msg">End date is before the task date.</div>`;
      return;
    }
    const seq = ++availSeq;
    panel.innerHTML = `<div class="svc-avail svc-avail-msg">Checking who is free…</div>`;
    let data;
    try {
      const qs = new URLSearchParams({ start, end });
      if (isEdit && w.id) qs.set('exclude_wo', String(w.id));
      data = await api(`/api/service/availability?${qs}`);
    } catch (e) {
      // Availability is an aid, never a gate — a coordinator with a machine
      // down must still be able to raise the Work Order.
      if (seq === availSeq) {
        panel.innerHTML = `<div class="svc-avail svc-avail-msg">Could not check availability (${esc(e.message)}). You can still save.</div>`;
      }
      return;
    }
    if (seq !== availSeq) return;

    const chosen = (document.getElementById('svcWoEmp') || {}).value || '';
    const days = data.business_days;
    const span = end > start ? `${fmtDate(start)} – ${fmtDate(end)}` : fmtDate(start);
    const tone = { free: 'ok', partial: 'warn', over: 'bad' };
    const label = (p) => p.status === 'free' ? 'free'
      : p.status === 'over' ? `over-booked (${p.peak_pct}% peak)`
      : `${p.busy_days}/${days} d booked`;

    // Service people first and most-available first (the server already sorts
    // by availability); cap the list so the form stays a form.
    const svc = data.people.filter(p => p.discipline === 'service');
    const rest = data.people.filter(p => p.discipline !== 'service');
    const show = [...svc, ...rest.filter(p => p.status === 'free').slice(0, 6)];

    const pill = (p) => `<button type="button" class="svc-avail-pill svc-avail-${tone[p.status]}${p.name === chosen ? ' is-chosen' : ''}"
        data-pick="${esc(p.name)}"
        title="${esc(p.name)} — ${esc(label(p))}${p.conflicts.length ? '\n' + p.conflicts.slice(0, 6).map(c => `${c.start_date}–${c.end_date}  ${c.project || ''}: ${c.name}`).join('\n') : ''}">
        ${esc(p.name)} <em>${esc(label(p))}</em></button>`;

    panel.innerHTML = `
      <div class="svc-avail">
        <div class="svc-avail-head">Availability · ${esc(span)} <span class="svc-sub">${days} business day${days === 1 ? '' : 's'}</span></div>
        <div class="svc-avail-pills">${show.map(pill).join('') || '<span class="svc-sub">No active roster members found.</span>'}</div>
        ${chosen && data.people.find(p => p.name === chosen && p.status === 'over')
          ? `<div class="svc-avail-note">${esc(chosen)} is already over-booked in this window — you can still assign them, but check the conflicts first.</div>`
          : ''}
      </div>`;

    // Clicking a name assigns it: the point of the panel is to pick from it.
    panel.querySelectorAll('[data-pick]').forEach(btn => btn.addEventListener('click', () => {
      const s2 = document.getElementById('svcWoEmp');
      if (!s2) return;
      s2.value = btn.dataset.pick;
      s2.dispatchEvent(new Event('change'));
    }));
  }

  if (startEl) startEl.addEventListener('change', renderAvailability);
  if (endEl)   endEl.addEventListener('change', renderAvailability);
  renderAvailability();
}

// Service Report (§11) — opens prepopulated. Everything above the editable
// fields is what the system already knew, shown so the technician can confirm
// it rather than retype it.
async function openReportForm(reportId) {
  let rep;
  try { rep = await api(`/api/service/reports/${reportId}`); }
  catch (e) { return toast(e.message, 'error'); }
  const p = rep.prefill || {};
  const submitted = rep.status === 'submitted';

  const row = (k, v) => (v == null || v === '' ? '' : `<div class="svc-f"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`);

  modal(`Service Report ${rep.report_no}${submitted ? ' (submitted)' : ''}`, `
    <div class="svc-prefill">
      <div class="svc-prefill-title">Prepopulated from the Service Request, Log and Work Order</div>
      <div class="svc-fields">
        ${row('Customer', p.company_name)}
        ${row('Request #', p.request_no)}
        ${row('Work Order', p.wo_no)}
        ${row('Machine / Job', [p.machine_serial, p.job_number].filter(Boolean).join(' / '))}
        ${row('Machine type', MACHINE_TYPES[p.machine_type])}
        ${row('Service date', p.task_date)}
        ${row('Technician', p.employee_name)}
        ${row('On-site / Remote', p.location_type === 'onsite' ? 'On-site' : p.location_type === 'remote' ? 'Remote' : '')}
        ${row('Warranty', WARRANTY[p.warranty] || p.warranty)}
        ${row('Budgeted hours', p.budgeted_hours)}
        ${row('Requestor', [p.requestor_name, p.requestor_phone].filter(Boolean).join(' · '))}
      </div>
      ${p.reported_issue ? `<div class="svc-longtext"><span>Issue as reported</span><p>${esc(p.reported_issue)}</p></div>` : ''}
    </div>
    <div class="svc-form-grid">
      <label class="svc-span">Work performed${submitted ? '' : ' *'}
        <textarea name="work_performed" rows="5" ${submitted ? 'readonly' : ''}>${esc(rep.work_performed || '')}</textarea></label>
      <label class="svc-span">Findings / root cause
        <textarea name="findings" rows="3" ${submitted ? 'readonly' : ''}>${esc(rep.findings || '')}</textarea></label>
      <label class="svc-span">Parts used
        <textarea name="parts_used" rows="2" ${submitted ? 'readonly' : ''}>${esc(rep.parts_used || '')}</textarea></label>
      <label>Actual hours
        <input name="hours_actual" type="number" step="0.25" min="0" value="${esc(rep.hours_actual ?? '')}" ${submitted ? 'readonly' : ''}></label>
      <label>Customer contact on site
        <input name="customer_contact" value="${esc(rep.customer_contact || '')}" ${submitted ? 'readonly' : ''}></label>
      <label class="svc-inline-check svc-span">
        <input type="checkbox" name="follow_up_needed" ${rep.follow_up_needed ? 'checked' : ''} ${submitted ? 'disabled' : ''}>
        Follow-up work needed
      </label>
      <label class="svc-span">Follow-up notes
        <textarea name="follow_up_notes" rows="2" ${submitted ? 'readonly' : ''}>${esc(rep.follow_up_notes || '')}</textarea></label>
    </div>
    ${submitted ? `<div class="svc-sub" style="margin-top:10px">Submitted by ${esc(rep.submitted_by)} on ${fmtWhen(rep.submitted_at)}. Reports are locked once submitted.</div>` : ''}`,
    async (data) => {
      if (submitted) return;
      await api(`/api/service/reports/${reportId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      // Saving a draft and submitting are different acts: a technician can save
      // half a report from a customer's parking lot and finish it later.
      const finish = await confirmDialog('Submit this Service Report now? It will be locked from further edits.');
      if (finish) {
        await api(`/api/service/reports/${reportId}/submit`, { method: 'POST' });
        toast('Service Report submitted.', 'success');
      } else {
        toast('Service Report saved as a draft.', 'success');
      }
      if (_svc.detail) await refreshDrawer(_svc.detail.request.id);
      await loadService(); drawTabs(); drawBody();
    }, submitted ? 'Close' : 'Save report');
}

// Deep link target for the emailed "Open Work Order" button:
//   /?view=service&wo=<id>
async function openServiceWorkOrder(woId) {
  try {
    const wo = await api(`/api/service/work-orders/${Number(woId)}`);
    if (wo) return openServiceRequest(wo.service_request_id, wo.id);
  } catch (_) {}
  toast('Could not find that Work Order.', 'error');
}

window.renderServicePage    = renderServicePage;
window.openServiceRequest   = openServiceRequest;
window.openServiceWorkOrder = openServiceWorkOrder;

// Honour the deep link once the page has booted.
window.addEventListener('DOMContentLoaded', () => {
  try {
    const p = new URLSearchParams(location.search);
    if (p.get('view') === 'service') {
      const wo = p.get('wo');
      setTimeout(() => {
        if (typeof window.setView === 'function') window.setView('service');
        if (wo) setTimeout(() => openServiceWorkOrder(wo), 400);
      }, 300);
    }
  } catch (_) {}
});

})();
