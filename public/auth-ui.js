/**
 * auth-ui.js — Phase 3 client-side auth.
 *
 * Loaded BEFORE app.js so it can:
 *   1. Wrap window.fetch to attach Authorization: Bearer <token>
 *   2. Detect AUTH_ENABLED on boot via /api/auth/me
 *   3. Show a small login modal when auth is required
 *   4. Stash the JWT in localStorage('sdc_auth_token') across reloads
 *
 * Public API on window:
 *   sdcAuth.user        — { id, email, name, role, avatar_color } or null
 *   sdcAuth.token       — JWT string or null
 *   sdcAuth.authEnabled — boolean (set after /me)
 *   sdcAuth.signOut()   — clear + reload
 *   sdcAuth.showLogin() — force open the modal (used by 401 handler)
 *
 * Dan rule: NO dev-tools required. All errors surface as visible toasts /
 * inline modal text, never console.log diagnostics.
 */
'use strict';

const TOKEN_KEY = 'sdc_auth_token';
const USER_KEY  = 'sdc_auth_user';

window.sdcAuth = {
  user: null,
  token: localStorage.getItem(TOKEN_KEY) || null,
  authEnabled: false,
  signOut() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    location.reload();
  },
  showLogin() { _openModal(); },
};

// Try to hydrate user from localStorage so the toolbar pill renders immediately
// on reload while /me is in flight.
try {
  const cached = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  if (cached) window.sdcAuth.user = cached;
} catch (_) {}

// ── fetch wrapper ────────────────────────────────────────────────────────
// Attaches Bearer token + intercepts 401/403 with a friendly message. Wraps
// the global window.fetch so app.js needs no changes.
const _originalFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  init = init || {};
  init.headers = new Headers(init.headers || {});
  if (window.sdcAuth.token) {
    init.headers.set('Authorization', 'Bearer ' + window.sdcAuth.token);
  }
  const res = await _originalFetch(input, init);
  // 401 from /api/auth/me on boot when auth is on → show login modal.
  // 401 elsewhere → token expired, sign out + show login.
  // 403 → user lacks the role, show toast.
  if (res.status === 401) {
    // Don't loop: skip /api/auth/login + /api/auth/register endpoints.
    const url = (typeof input === 'string') ? input : (input?.url || '');
    if (!/\/api\/auth\/(login|register)/.test(url)) {
      localStorage.removeItem(TOKEN_KEY);
      window.sdcAuth.token = null;
      _openModal();
    }
  } else if (res.status === 403) {
    try {
      const body = await res.clone().json();
      if (typeof showToast === 'function') showToast(body.error || 'Permission denied', { kind: 'error' });
    } catch (_) {}
  }
  return res;
};

// ── boot ────────────────────────────────────────────────────────────────
async function _boot() {
  try {
    const r = await _originalFetch('/api/auth/me', {
      headers: window.sdcAuth.token ? { Authorization: 'Bearer ' + window.sdcAuth.token } : {},
    });
    if (r.ok) {
      const data = await r.json();
      window.sdcAuth.authEnabled = !!data.auth_enabled;
      window.sdcAuth.user        = data.user;
      try { localStorage.setItem(USER_KEY, JSON.stringify(data.user)); } catch (_) {}
      _renderUserPill();
    } else if (r.status === 401) {
      // Auth is on, token missing/expired → show modal.
      window.sdcAuth.authEnabled = true;
      _openModal();
    }
  } catch (e) {
    // Server unreachable — fail silent; app.js will surface the failure.
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _boot);
} else {
  _boot();
}

// ── modal ───────────────────────────────────────────────────────────────
let _modalEl = null;
function _openModal() {
  if (_modalEl) { _modalEl.classList.add('is-open'); return; }
  _modalEl = document.createElement('div');
  _modalEl.className = 'sdc-auth-modal-backdrop is-open';
  _modalEl.innerHTML = `
    <div class="sdc-auth-modal" role="dialog" aria-label="Sign in">
      <h2>Sign in</h2>
      <p class="sdc-auth-modal-sub">SDC Scheduler — enter your email + password.</p>
      <form id="sdc-auth-form">
        <label>Email
          <input type="email" name="email" required autocomplete="username" />
        </label>
        <label>Password
          <input type="password" name="password" required autocomplete="current-password" minlength="1" />
        </label>
        <p class="sdc-auth-error" id="sdc-auth-error" hidden></p>
        <button type="submit" class="btn-primary">Sign in</button>
        <button type="button" class="sdc-auth-link" id="sdc-auth-toggle-register">Need an account? Register</button>
      </form>
    </div>
  `;
  document.body.appendChild(_modalEl);
  const form = _modalEl.querySelector('#sdc-auth-form');
  let isRegister = false;
  const toggle = _modalEl.querySelector('#sdc-auth-toggle-register');
  toggle.addEventListener('click', () => {
    isRegister = !isRegister;
    const h2 = _modalEl.querySelector('h2');
    h2.textContent = isRegister ? 'Create account' : 'Sign in';
    toggle.textContent = isRegister ? 'Have an account? Sign in' : 'Need an account? Register';
    if (isRegister && !form.querySelector('input[name="name"]')) {
      const nameLbl = document.createElement('label');
      nameLbl.innerHTML = 'Name <input type="text" name="name" required autocomplete="name" />';
      form.insertBefore(nameLbl, form.firstElementChild);
    } else {
      form.querySelector('label:has(input[name="name"])')?.remove();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const url  = isRegister ? '/api/auth/register' : '/api/auth/login';
    const err  = _modalEl.querySelector('#sdc-auth-error');
    err.hidden = true;
    try {
      const r = await _originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Sign-in failed');
      window.sdcAuth.token = body.token;
      window.sdcAuth.user  = body.user;
      localStorage.setItem(TOKEN_KEY, body.token);
      try { localStorage.setItem(USER_KEY, JSON.stringify(body.user)); } catch (_) {}
      location.reload();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });
}

// ── user pill in the bottom footer ───────────────────────────────────────
// Lives in #schedule-footer next to the Quote vs Schedule button. Falls
// back to body-fixed bottom-left if the footer isn't on the page (e.g.
// the user opens a non-schedule view first).
function _renderUserPill() {
  if (!window.sdcAuth.authEnabled || !window.sdcAuth.user) return;
  if (document.getElementById('sdc-auth-pill')) return;
  const u = window.sdcAuth.user;
  const initials = (u.name || '?').split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
  const pill = document.createElement('div');
  pill.id = 'sdc-auth-pill';
  pill.className = 'sdc-auth-pill';
  pill.innerHTML = `
    <span class="sdc-auth-avatar" style="background:${u.avatar_color || '#1574c4'};">${initials}</span>
    <span class="sdc-auth-name">${u.name}</span>
    <span class="sdc-auth-role">${u.role}</span>
    <button type="button" class="sdc-auth-changepw" title="Change password">🔑</button>
    <button type="button" class="sdc-auth-signout" title="Sign out">×</button>
  `;
  pill.querySelector('.sdc-auth-signout').addEventListener('click', () => window.sdcAuth.signOut());
  pill.querySelector('.sdc-auth-changepw').addEventListener('click', () => _showChangePasswordModal());

  document.body.appendChild(pill);
}

// ── Change password modal ─────────────────────────────────────────────────
function _showChangePasswordModal() {
  document.getElementById('sdc-change-pw-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'sdc-change-pw-modal';
  modal.className = 'sdc-auth-modal-backdrop is-open';
  modal.innerHTML = `
    <div class="sdc-auth-modal" role="dialog" aria-label="Change password">
      <h2>Change password</h2>
      <p class="sdc-auth-modal-sub">Signed in as ${window.sdcAuth.user?.name || ''}</p>
      <form id="sdc-change-pw-form">
        <label>Current password
          <input type="password" name="current_password" required autocomplete="current-password" />
        </label>
        <label>New password
          <input type="password" name="new_password" required autocomplete="new-password" minlength="1" />
        </label>
        <p class="sdc-auth-error" id="sdc-change-pw-error" hidden></p>
        <p id="sdc-change-pw-ok" hidden style="color:#059669;font-size:13px;margin:8px 0;">Password updated!</p>
        <div style="display:flex;gap:8px;margin-top:4px;">
          <button type="submit" class="btn-primary" style="flex:1;">Update</button>
          <button type="button" id="sdc-change-pw-cancel" style="flex:1;">Cancel</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#sdc-change-pw-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  modal.querySelector('#sdc-change-pw-form').addEventListener('submit', async e => {
    e.preventDefault();
    const data   = Object.fromEntries(new FormData(e.target).entries());
    const errEl  = modal.querySelector('#sdc-change-pw-error');
    const okEl   = modal.querySelector('#sdc-change-pw-ok');
    const btn    = modal.querySelector('button[type="submit"]');
    errEl.hidden = true;
    okEl.hidden  = true;
    btn.disabled = true;
    try {
      const r = await fetch('/api/auth/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Update failed');
      okEl.hidden = false;
      e.target.reset();
      setTimeout(() => modal.remove(), 1500);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  modal.querySelector('input[name="current_password"]').focus();
}
