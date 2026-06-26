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
  // 401 → only treat as "session expired" when we ACTUALLY HELD a token that the
  // server rejected. Without this guard, any stray 401 wiped the token and
  // trapped the user behind the login modal mid-work ("surprise logout"). When
  // auth is on but we never had a token, _boot() handles showing the modal.
  // 403 → user lacks the role, show toast (NOT a logout).
  if (res.status === 401) {
    const url = (typeof input === 'string') ? input : (input?.url || '');
    const isAuthEndpoint = /\/api\/auth\/(login|register)/.test(url);
    if (!isAuthEndpoint && window.sdcAuth.token) {
      localStorage.removeItem(TOKEN_KEY);
      window.sdcAuth.token = null;
      if (typeof showToast === 'function') showToast('Your session expired — please sign in again.', { kind: 'error' });
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
        <p class="sdc-auth-hint" id="sdc-auth-hint" hidden>Pick a password you'll remember.</p>
        <p class="sdc-auth-error" id="sdc-auth-error" hidden></p>
        <button type="submit" class="btn-primary">Sign in</button>
        <button type="button" class="sdc-auth-link" id="sdc-auth-toggle-register">Need an account? Register</button>
        <button type="button" class="sdc-auth-link" id="sdc-auth-forgot">Forgot password?</button>
      </form>
    </div>
  `;
  document.body.appendChild(_modalEl);
  const form = _modalEl.querySelector('#sdc-auth-form');
  let isRegister = false;
  const toggle = _modalEl.querySelector('#sdc-auth-toggle-register');
  const hint   = _modalEl.querySelector('#sdc-auth-hint');
  const forgot = _modalEl.querySelector('#sdc-auth-forgot');
  toggle.addEventListener('click', () => {
    isRegister = !isRegister;
    const h2 = _modalEl.querySelector('h2');
    h2.textContent = isRegister ? 'Create account' : 'Sign in';
    toggle.textContent = isRegister ? 'Have an account? Sign in' : 'Need an account? Register';
    hint.hidden = !isRegister;            // password rule only matters when creating
    forgot.hidden = isRegister;           // no "forgot" while registering
    const pwInput = form.querySelector('input[name="password"]');
    if (pwInput) pwInput.setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
    if (isRegister && !form.querySelector('input[name="name"]')) {
      const nameLbl = document.createElement('label');
      nameLbl.innerHTML = 'Name <input type="text" name="name" required autocomplete="name" />';
      form.insertBefore(nameLbl, form.firstElementChild);
    } else {
      form.querySelector('label:has(input[name="name"])')?.remove();
    }
  });
  // No self-service reset (internal tool, no guaranteed email) — point the user
  // at the fast path: any admin can reset it instantly in Setup → Users.
  forgot.addEventListener('click', () => {
    const err = _modalEl.querySelector('#sdc-auth-error');
    err.innerHTML = 'Ask an SDC admin to reset your password — they can do it in <b>Setup → Users</b> and give you a temporary one to sign in with.';
    err.hidden = false;
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

// ── user avatar in the sidebar (above the Rev pill) ──────────────────────
// Just a small circle with the signed-in person's initials so it never sits
// over any controls. Click it for a small popup: name, role, change password,
// sign out.
function _renderUserPill() {
  if (!window.sdcAuth.authEnabled || !window.sdcAuth.user) return;
  if (document.getElementById('sdc-auth-pill')) return;
  const u = window.sdcAuth.user;
  const initials = (u.name || '?').split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
  const pill = document.createElement('div');
  pill.id = 'sdc-auth-pill';
  pill.className = 'sdc-auth-pill';
  pill.innerHTML = `
    <button type="button" class="sdc-auth-refresh" id="btn-sidebar-hard-refresh" title="Hard refresh — clears cache and fully reloads the page (Ctrl+Shift+R).">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10"></polyline>
        <polyline points="1 20 1 14 7 14"></polyline>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
      </svg>
    </button>
    <button type="button" class="sdc-auth-avatar" style="background:${u.avatar_color || '#1574c4'};" title="${u.name} · ${u.role}">${initials}</button>
    <div class="sdc-auth-menu" hidden>
      <div class="sdc-auth-menu-name">${u.name}</div>
      <div class="sdc-auth-menu-role">${u.role}</div>
      <button type="button" class="sdc-auth-changepw">🔑 Change password</button>
      <button type="button" class="sdc-auth-signout">Sign out</button>
    </div>
  `;
  const menu = pill.querySelector('.sdc-auth-menu');
  const closeMenu = () => { menu.hidden = true; };
  pill.querySelector('.sdc-auth-refresh').addEventListener('click', () => window.location.reload(true));
  pill.querySelector('.sdc-auth-avatar').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  pill.querySelector('.sdc-auth-signout').addEventListener('click', () => window.sdcAuth.signOut());
  pill.querySelector('.sdc-auth-changepw').addEventListener('click', () => { closeMenu(); _showChangePasswordModal(); });
  document.addEventListener('click', (e) => { if (!pill.contains(e.target)) closeMenu(); });

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
      let body;
      try { body = await r.json(); }
      catch (_) { throw new Error('Server error — please refresh the page and try again'); }
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
