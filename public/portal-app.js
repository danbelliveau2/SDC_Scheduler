// portal-app.js — the login form for portal.sdcautomation.com. That's the
// whole job now: a successful POST /portal/api/login sets the customer's
// session cookie and this redirects to '/', where server.js's snap.get('/')
// sees that cookie and falls through to the REAL app.js/index.html instead
// of re-serving this page — the customer's actual dashboard (Portal tab,
// locked to their own projects) is rendered there, by the same code staff's
// own Portal tab uses. This file used to ALSO render that whole dashboard
// itself (a second implementation, alongside portalCalc.js/portalRender.js/
// portalCustomerShim.js), before that got retired in favor of customer
// sessions running the real app — see server.js's CUSTOMER_GET_PATHS.
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
        // Full reload, not a client-side render: the cookie this just set
        // makes server.js's snap.get('/') fall through to the real app
        // (locked to the Portal tab, scoped to this customer) instead of
        // serving this login page again.
        window.location.href = '/';
      } catch (err) {
        btn.disabled = false;
        renderLogin(err.status === 429 ? ((err.body && err.body.error) || 'Too many attempts. Try again later.') : 'Incorrect username or password.');
      }
    });
  }

  renderLogin();
})();
