// portal-app.js — the customer-facing portal's own small client. Login,
// header, project-list/picker and polling are its own (separate from the
// staff app.js by design — see routes/portal.js's header comment). The
// ANALYTICS CONTENT (due dates, progress, payment milestones, risk plan,
// team, event status) is rendered by the SAME functions public/app.js's
// Portal tab uses — public/portalRender.js, loaded before this file, fed by
// public/portalCustomerShim.js's environment (state, escapeHtml, riskPlan,
// etc.) instead of app.js's own globals. See portalCustomerShim.js's header
// for why that's needed and what it provides.
(function () {
  'use strict';
  const root = document.getElementById('root');

  function esc(s) { return escapeHtml(s); }

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts));
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (!r.ok) throw Object.assign(new Error((body && body.error) || ('HTTP ' + r.status)), { status: r.status, body });
    return body;
  }

  function renderLogin(errorMsg) {
    root.innerHTML = `
      <div class="cp-login-wrap">
        <div class="cp-login-card">
          <img src="/img/sdc-logo-white.svg" class="cp-login-logo" alt="SDC">
          <h1>Project Portal</h1>
          <form id="cp-login-form">
            <div class="cp-field"><label>Username</label><input type="text" name="username" autocomplete="username" required autofocus></div>
            <div class="cp-field"><label>Password</label><input type="password" name="password" autocomplete="current-password" required></div>
            <button class="cp-btn" type="submit">Sign in</button>
            ${errorMsg ? `<p class="cp-error">${esc(errorMsg)}</p>` : ''}
          </form>
        </div>
      </div>`;
    const form = document.getElementById('cp-login-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true;
      const username = form.username.value.trim();
      const password = form.password.value;
      try {
        await api('/portal/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        await loadDashboard();
      } catch (err) {
        renderLogin(err.status === 429 ? ((err.body && err.body.error) || 'Too many attempts. Try again later.') : 'Incorrect username or password.');
      }
    });
  }

  // A machine is a deliverable with its own FAT — exact copy of
  // public/app.js's own portalUnits(project) (app.js's version, staff-only,
  // stays there unchanged; this one just reads the customer's own already-
  // scoped state.tasks the same way).
  function portalUnits(project) {
    const rows = state.tasks.filter(t => t.project === project);
    const machines = [...new Set(rows.map(t => t.machine).filter(Boolean))].sort();
    if (!machines.length) return [{ machine: null, label: '', rows }];
    const shared = rows.filter(t => !t.machine);
    return machines.map(m => ({ machine: m, label: m, rows: rows.filter(t => t.machine === m).concat(shared) }));
  }

  // 'all' = every project shown at once (today's default). An array = only
  // those project names — click a row to drill into just it, tick the box
  // to build a custom multi-project group instead, same two gestures as the
  // internal Portal tab's project list. Module-scope so it survives the
  // 60s poll's re-render.
  let _scope = 'all';

  // Which machine to show for the one drilled-into project — keyed by
  // project name so each project remembers its own pick independently.
  // Absent/'' = "All machines". Only meaningful while a single project is
  // picked (see `pickedName` below) — mirrors the internal Portal tab's
  // "All machines | Machine 1 | Machine 2 | ..." pills, which likewise only
  // appear once you have drilled into one job.
  const _machineScope = {};

  function renderDashboard(data) {
    // Point the shared render functions (public/portalRender.js) at this
    // customer's data, exactly like public/app.js's renderPortal() reading
    // its own live `state` — see portalCustomerShim.js.
    _setPortalCustomerData(data);
    _portalRecentDays = _recentDays;

    const inScope = (name) => _scope === 'all' || _scope.includes(name);
    const pickedName = (_scope !== 'all' && _scope.length === 1) ? _scope[0] : null;
    const pickedProject = pickedName ? data.projects.find(p => p.name === pickedName) : null;
    const pickedMachine = pickedName ? (_machineScope[pickedName] || '') : '';
    const scopeProjects = data.projects.filter(p => inScope(p.name));
    const scopeNames = scopeProjects.map(p => p.name);
    const multiPick = data.projects.length > 1;
    const noneScoped = Array.isArray(_scope) && !_scope.length;

    const projectRows = data.projects.map(p => {
      const picked = _scope !== 'all' && _scope.length === 1 && _scope[0] === p.name;
      const checked = Array.isArray(_scope) && _scope.includes(p.name);
      return `
      <div class="cp-proj-row${picked ? ' is-picked' : ''}" data-pick-proj="${esc(p.name)}">
        ${multiPick ? `<button type="button" class="cp-proj-tick${checked ? ' is-on' : ''}" data-toggle-proj="${esc(p.name)}" aria-pressed="${checked}"></button>` : ''}
        <span class="cp-proj-name">${esc(p.name)}</span>
        <a class="cp-open-btn" href="/?cust=${encodeURIComponent(p.shareToken)}" target="_blank" rel="noopener" data-stop-pick>Open</a>
      </div>`;
    }).join('');
    // portal-pickbtns/portal-allbtn and portal-mach-pills/portal-mach are the
    // SAME classes public/app.js's _portalProjectsHtml/_portalPickedBarHtml
    // use for these exact two controls — reused here (not a lookalike copy)
    // so the pill buttons are pixel-identical, not just similar.
    const pickButtons = multiPick
      ? `<span class="portal-pickbtns">
          <button type="button" class="portal-allbtn${_scope === 'all' ? ' is-on' : ''}" data-scope-all>All projects</button>
          <button type="button" class="portal-allbtn" data-scope-clear${Array.isArray(_scope) && !_scope.length ? ' disabled' : ''}>Clear</button>
        </span>`
      : '';

    // Same gesture as the internal Portal tab: the pills only appear once
    // you've drilled into one job with more than one machine on it.
    const machineTabsHtml = (pickedProject && pickedProject.machines.length > 1) ? `
      <section class="portal-block">
        <h2 class="portal-h2">${esc(pickedName)}</h2>
        <div class="portal-mach-pills">
          <button type="button" class="portal-mach${!pickedMachine ? ' is-on' : ''}" data-mach-all>All machines</button>
          ${pickedProject.machines.map(m => `<button type="button" class="portal-mach${pickedMachine === m ? ' is-on' : ''}" data-mach-pick="${esc(m)}">${esc(_portalMachineLabel(m))}</button>`).join('')}
        </div>
      </section>` : '';

    // Everything below this line is the SAME functions public/app.js's
    // renderPortal() calls (public/portalRender.js) — one combined
    // Progress/Event-status view across the current scope, filtered by
    // whichever single machine is picked, exactly like the internal tab.
    let dueHtml = '', progressHtml = '', moneyHtml = '', riskHtml = '', teamHtml = '', workHtml = '';
    if (!noneScoped) {
      const units = [];
      scopeNames.forEach(p => {
        portalUnits(p).forEach(u => units.push({ project: p, ...u, ms: portalMilestones(u.rows) }));
      });
      const scopeUnits = units.filter(u => !pickedMachine || u.project !== pickedName || u.machine === pickedMachine);
      dueHtml = _portalDueTableHtml(scopeUnits);
      progressHtml = _portalProgressHtml(scopeNames, pickedMachine);
      moneyHtml = _portalMoneyHtml(scopeNames, pickedMachine);
      riskHtml = _portalRiskHtml(scopeNames);
      teamHtml = _portalTeamHtml(scopeNames);
      workHtml = _portalWorkHtml(scopeNames, pickedMachine);
    }

    const pickedEmptyMsg = noneScoped ? '<p class="cp-empty">Pick a project above to see its details.</p>' : '';

    root.innerHTML = `
      <header class="cp-header">
        <div class="cp-header-left">
          <img src="/img/sdc-logo-white.svg" class="cp-header-logo" alt="SDC">
          <div>
            <div class="cp-header-title">${esc(data.customerName)}</div>
            <div class="cp-header-meta">${data.unitCount} machine${data.unitCount === 1 ? '' : 's'} · ${data.projectCount} project${data.projectCount === 1 ? '' : 's'}</div>
          </div>
        </div>
        <button class="cp-logout" id="cp-logout-btn" type="button">Sign out</button>
      </header>
      <div class="cp-wrap">
        <section class="portal-block portal-projects">
          <h2 class="portal-h2">Your projects${pickButtons}</h2>
          ${projectRows || '<p class="cp-empty">No projects are linked to your account yet.</p>'}
        </section>
        ${pickedEmptyMsg}
        ${machineTabsHtml}
        ${dueHtml}
        ${progressHtml}
        ${moneyHtml}
        ${riskHtml}
        ${teamHtml}
        ${workHtml}
      </div>`;

    // Recent-completed window: filtering is now done client-side (portalWork
    // reads _portalRecentDays), so switching it just re-renders — no round
    // trip to the server needed.
    root.querySelector('[data-recent-win]')?.addEventListener('change', (e) => {
      _recentDays = Number(e.target.value) || 30;
      renderDashboard(data);
    });

    // Column drag-to-resize on the shared grids (due/money/work tables) —
    // same function, same localStorage keys, as the internal Portal tab
    // (isolated to this customer's own browser, naturally).
    try { _wirePortalGrids(root); } catch (_) {}

    // Risk item expand/collapse — _portalRiskOpen is the same Set
    // public/portalRender.js's _portalRiskHtml reads.
    root.querySelectorAll('[data-prisk]').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.dataset.prisk;
        if (_portalRiskOpen.has(id)) _portalRiskOpen.delete(id); else _portalRiskOpen.add(id);
        renderDashboard(data);
      });
    });

    root.querySelectorAll('[data-pick-proj]').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-toggle-proj], [data-stop-pick]')) return;
        const name = row.dataset.pickProj;
        _scope = (_scope !== 'all' && _scope.length === 1 && _scope[0] === name) ? 'all' : [name];
        renderDashboard(data);
      });
    });
    root.querySelectorAll('[data-toggle-proj]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.toggleProj;
        const current = new Set(_scope === 'all' ? [] : _scope);
        if (current.has(name)) current.delete(name); else current.add(name);
        _scope = [...current];
        renderDashboard(data);
      });
    });
    root.querySelector('[data-scope-all]')?.addEventListener('click', () => { _scope = 'all'; renderDashboard(data); });
    root.querySelector('[data-scope-clear]')?.addEventListener('click', () => { _scope = []; renderDashboard(data); });

    root.querySelector('[data-mach-all]')?.addEventListener('click', () => {
      if (pickedName) delete _machineScope[pickedName];
      renderDashboard(data);
    });
    root.querySelectorAll('[data-mach-pick]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (pickedName) _machineScope[pickedName] = btn.dataset.machPick;
        renderDashboard(data);
      });
    });

    document.getElementById('cp-logout-btn').addEventListener('click', async () => {
      stopPolling();
      try { await api('/portal/api/logout', { method: 'POST' }); } catch (_) {}
      renderLogin();
    });
  }

  // "Completed recently" window for Event Status — matches public/app.js's
  // PORTAL_RECENT_WINDOWS (now the shared PORTAL_RECENT_WINDOWS constant in
  // public/portalRender.js, read directly by _portalWorkGrid).
  let _recentDays = 30;
  function dashboardUrl() { return '/portal/api/dashboard'; }

  // Auto-refresh: the dashboard is a live query every time it's fetched (see
  // routes/portal.js), so nothing here goes stale — it just isn't PUSHED to
  // an already-open tab without this. Silent re-render on each tick, no
  // loading spinner, so a customer sitting on the page doesn't see a flicker
  // every minute. A 401 mid-poll (session expired) drops back to login.
  const POLL_MS = 60000;
  let _pollTimer = null;
  function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }
  function startPolling() {
    stopPolling();
    _pollTimer = setInterval(async () => {
      try {
        const data = await api(dashboardUrl());
        renderDashboard(data);
      } catch (err) {
        if (err.status === 401) { stopPolling(); renderLogin(); }
        // Any other error (a dropped connection, a transient 5xx) is left
        // alone — the next tick tries again rather than kicking the
        // customer back to login over a blip.
      }
    }, POLL_MS);
  }

  async function loadDashboard() {
    root.innerHTML = '<div class="cp-loading">Loading…</div>';
    try {
      const data = await api(dashboardUrl());
      renderDashboard(data);
      startPolling();
    } catch (_) {
      stopPolling();
      renderLogin();
    }
  }

  loadDashboard();
})();
