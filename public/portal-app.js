// portal-app.js — the customer-facing portal's own small client, separate
// from the staff app.js by design (see routes/portal.js's header comment).
// Talks only to /portal/api/* on this same listener.
(function () {
  'use strict';
  const root = document.getElementById('root');

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

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

  function gapClass(gap) {
    if (gap == null) return '';
    if (gap >= 0) return 'cp-gap-ok';
    return gap <= -10 ? 'cp-gap-late' : 'cp-gap-warn';
  }

  function bandFor(score) {
    if (score >= 12) return 'critical';
    if (score >= 8) return 'high';
    if (score >= 4) return 'medium';
    return 'low';
  }

  const RISK_LIKELIHOOD = [
    { v: 5, label: 'Almost certain' }, { v: 4, label: 'Likely' }, { v: 3, label: 'Possible' },
    { v: 2, label: 'Unlikely' }, { v: 1, label: 'Rare' },
  ];
  const RISK_SEVERITY = [{ v: 1, label: 'Days' }, { v: 2, label: 'Weeks' }, { v: 3, label: 'Months' }];

  function renderRiskBlock(p) {
    const matrixRows = RISK_LIKELIHOOD.map(L => {
      const cells = RISK_SEVERITY.map(S => {
        const here = p.risk.filter(r => r.likelihood === L.v && r.severity === S.v);
        return `<td class="cp-rm-${bandFor(L.v * S.v)}">${here.map(r =>
          `<span class="cp-rm-dot" title="${esc(r.title)}">${r.n}</span>`).join('')}</td>`;
      }).join('');
      return `<tr><th class="cp-rm-yl">${esc(L.label)}</th>${cells}</tr>`;
    }).join('');
    const foot = `<tr><th class="cp-rm-yl"></th>${RISK_SEVERITY.map(S => `<th class="cp-rm-xl">${esc(S.label)}</th>`).join('')}</tr>`;
    const list = p.risk.map(r => `<div class="cp-risk-item">
      <b>${r.n}.</b> ${esc(r.title)}
      <span class="cp-risk-band cp-rm-${r.band.key}">${esc(r.band.label)}</span>
      ${r.mitigation ? `<div style="margin-top:4px;color:var(--cp-muted)">${esc(r.mitigation)}</div>` : ''}
    </div>`).join('');
    return `<div class="cp-block">
      <h2 class="cp-h2">Risk mitigation plan — ${esc(p.name)}</h2>
      <div class="cp-risk-grid">
        <table class="cp-risk-matrix">${matrixRows}${foot}</table>
        <div class="cp-risk-list">${list}</div>
      </div>
    </div>`;
  }

  function renderDashboard(data) {
    const projectRows = data.projects.map(p => `
      <div class="cp-proj-row">
        <span class="cp-proj-name">${esc(p.name)}</span>
        <a class="cp-open-btn" href="/?cust=${encodeURIComponent(p.shareToken)}" target="_blank" rel="noopener">Open</a>
      </div>`).join('');

    const unitBlocks = data.units.map(u => {
      const title = u.machine ? `${u.project} · ${u.machine}` : u.project;
      const due = u.due;
      const dueHtml = !due ? '' : `
        <div class="cp-table-wrap"><table class="cp-table">
          <colgroup><col style="width:22%"><col style="width:60px"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:13%"></colgroup>
          <thead><tr><th>Machine</th><th>Complete</th><th>Receipt of PO</th><th>Power-Up</th><th>FAT quoted</th><th>FAT projected</th><th>Variance</th></tr></thead>
          <tbody><tr>
            <td>${esc(u.machine || u.project)}</td>
            <td>${due.pct == null ? '—' : due.pct + '%'}</td>
            <td>${esc((due.keyDates.find(k => k.key === 'receipt_of_po') || {}).dateText || '—')}</td>
            <td>${esc((due.keyDates.find(k => k.key === 'machine_power_up') || {}).dateText || '—')}</td>
            <td>${esc(due.fatQuotedText || '—')}</td>
            <td>${esc(due.fatProjectedText || '—')}</td>
            <td><span class="cp-variance ${due.variance.cls}">${esc(due.variance.text)}</span></td>
          </tr></tbody>
        </table></div>`;
      const progress = u.progress;
      const progHtml = !progress ? '<p class="cp-empty">No scheduled tasks yet.</p>' : `
        <div class="cp-prog">
          <dl class="cp-prog-vs ${gapClass(progress.gap)}">
            <div><dt>Should be</dt><dd>${progress.planned == null ? '—' : progress.planned + '%'}</dd></div>
            <div><dt>Actually</dt><dd>${progress.overall}%</dd></div>
            <div><dt>Variance</dt><dd>${progress.gap == null ? '—' : (progress.gap > 0 ? '+' : '') + progress.gap + ' pts'}</dd></div>
          </dl>
          <div class="cp-phase-bars">${progress.phases.map(ph => `
            <div class="cp-phase-bar">
              <div class="cp-phase-track"><div class="cp-phase-fill" style="height:${Math.max(ph.pct, 2)}%"></div></div>
              <div class="cp-phase-pct">${ph.pct}%</div>
              <div class="cp-phase-label">${esc(ph.label)}</div>
            </div>`).join('')}</div>
        </div>`;
      return `<div class="cp-block"><h2 class="cp-unit-title">${esc(title)}</h2>${dueHtml}<div style="height:16px"></div>${progHtml}</div>`;
    }).join('');

    const moneyBlocks = data.projects.filter(p => p.money.length).map(p => `
      <div class="cp-block">
        <h2 class="cp-h2">Payment milestones — ${esc(p.name)}</h2>
        <div class="cp-table-wrap"><table class="cp-table">
          <colgroup><col><col style="width:60px"><col style="width:100px"><col style="width:100px"></colgroup>
          <thead><tr><th>Milestone</th><th>%</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>${p.money.map(m => `<tr>
            <td>${esc(m.name)}</td>
            <td>${m.percent != null ? m.percent + '%' : '—'}</td>
            <td>${esc(m.dueText || '—')}</td>
            <td><span class="cp-status is-${esc(m.status)}">${esc(m.status)}</span></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`).join('');

    const riskBlocks = data.projects.filter(p => p.risk.length).map(renderRiskBlock).join('');

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
        <div class="cp-block">
          <h2 class="cp-h2">Your projects</h2>
          ${projectRows || '<p class="cp-empty">No projects are linked to your account yet.</p>'}
        </div>
        ${unitBlocks}
        ${moneyBlocks}
        ${riskBlocks}
      </div>`;

    document.getElementById('cp-logout-btn').addEventListener('click', async () => {
      try { await api('/portal/api/logout', { method: 'POST' }); } catch (_) {}
      renderLogin();
    });
  }

  async function loadDashboard() {
    root.innerHTML = '<div class="cp-loading">Loading…</div>';
    try {
      const data = await api('/portal/api/dashboard');
      renderDashboard(data);
    } catch (_) {
      renderLogin();
    }
  }

  loadDashboard();
})();
