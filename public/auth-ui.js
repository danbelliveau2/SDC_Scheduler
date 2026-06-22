/**
 * auth-ui.js — Phase 3 client-side auth.
 *
 * Loaded BEFORE app.js so it can:
 *   1. Wrap window.fetch to attach Authorization: Bearer <token>
 *   2. Detect AUTH_ENABLED on boot via /api/auth/me
 *   3. Show a login modal when auth is required
 *   4. Stash the JWT in localStorage('sdc_auth_token') across reloads
 *
 * Public API on window:
 *   sdcAuth.user        — { id, email, name, role, avatar_color } or null
 *   sdcAuth.token       — JWT string or null
 *   sdcAuth.authEnabled — boolean (set after /me)
 *   sdcAuth.signOut()   — clear + reload
 *   sdcAuth.showLogin() — force open the modal (used by 401 handler)
 */
'use strict';

const TOKEN_KEY = 'sdc_auth_token';
const USER_KEY  = 'sdc_auth_user';

// Distinct avatar colors for self-registered users.
const _AVATAR_COLORS = ['#1574c4','#059669','#d97706','#7c3aed','#db2777','#0891b2','#65a30d','#dc2626','#9333ea','#0d9488'];
function _randomColor() { return _AVATAR_COLORS[Math.floor(Math.random() * _AVATAR_COLORS.length)]; }

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

// Hydrate user from localStorage so the toolbar pill renders immediately
// on reload while /me is in-flight.
try {
  const cached = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  if (cached) window.sdcAuth.user = cached;
} catch (_) {}

// ── fetch wrapper ────────────────────────────────────────────────────────────
const _originalFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  init = init || {};
  init.headers = new Headers(init.headers || {});
  if (window.sdcAuth.token) {
    init.headers.set('Authorization', 'Bearer ' + window.sdcAuth.token);
  }
  const res = await _originalFetch(input, init);
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
      // ACCOUNT_DISABLED means admin acted — show the message and force re-auth.
      if (body.code === 'ACCOUNT_DISABLED') {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        window.sdcAuth.token = null;
        window.sdcAuth.user  = null;
        if (typeof showToast === 'function') showToast(body.error || 'Your account has been disabled.', { kind: 'error' });
        _openModal();
      } else if (typeof showToast === 'function') {
        showToast(body.error || 'Permission denied', { kind: 'error' });
      }
    } catch (_) {}
  } else if (res.status === 429) {
    try {
      const body = await res.clone().json();
      if (typeof showToast === 'function') showToast(body.error || 'Too many attempts. Try again later.', { kind: 'error' });
    } catch (_) {}
  }
  return res;
};

// ── boot ─────────────────────────────────────────────────────────────────────
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
      window.sdcAuth.authEnabled = true;
      _openModal();
    }
  } catch (_) {
    // Server unreachable — fail silent; app.js will surface the failure.
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _boot);
} else {
  _boot();
}

// ── modal ─────────────────────────────────────────────────────────────────────
let _modalEl = null;
function _openModal() {
  if (_modalEl) { _modalEl.classList.add('is-open'); return; }
  _modalEl = document.createElement('div');
  _modalEl.className = 'sdc-auth-modal-backdrop is-open';
  _modalEl.innerHTML = `
    <div class="sdc-auth-modal" role="dialog" aria-label="Sign in">
      <h2 id="sdc-auth-title">Sign in</h2>
      <p class="sdc-auth-modal-sub">SDC Scheduler — enter your email and password.</p>
      <form id="sdc-auth-form" autocomplete="on">
        <label>Email
          <input type="email" name="email" required autocomplete="username" maxlength="254" />
        </label>
        <label id="sdc-auth-name-label" style="display:none">Name
          <input type="text" name="name" autocomplete="name" maxlength="100" />
        </label>
        <label>Password
          <div class="sdc-pw-wrap">
            <input type="password" name="password" required autocomplete="current-password" maxlength="1024" />
            <button type="button" class="sdc-pw-toggle" tabindex="-1" aria-label="Show password">👁</button>
          </div>
        </label>
        <p class="sdc-auth-hint" id="sdc-auth-hint" hidden>Pick a password you'll remember.</p>
        <p class="sdc-auth-error" id="sdc-auth-error" hidden></p>
        <button type="submit" class="btn-primary" id="sdc-auth-submit">Sign in</button>
        <button type="button" class="sdc-auth-link" id="sdc-auth-toggle-register">Need an account? Register</button>
        <button type="button" class="sdc-auth-link" id="sdc-auth-forgot">Forgot password?</button>
      </form>
    </div>
  `;
  document.body.appendChild(_modalEl);

  const form       = _modalEl.querySelector('#sdc-auth-form');
  const title      = _modalEl.querySelector('#sdc-auth-title');
  const submitBtn  = _modalEl.querySelector('#sdc-auth-submit');
  const errEl      = _modalEl.querySelector('#sdc-auth-error');
  const hint       = _modalEl.querySelector('#sdc-auth-hint');
  const forgot     = _modalEl.querySelector('#sdc-auth-forgot');
  const toggleReg  = _modalEl.querySelector('#sdc-auth-toggle-register');
  const nameLabel  = _modalEl.querySelector('#sdc-auth-name-label');
  const nameInput  = form.querySelector('input[name="name"]');
  const pwInput    = form.querySelector('input[name="password"]');
  const pwToggle   = form.querySelector('.sdc-pw-toggle');
  let isRegister   = false;

  // Auto-focus email on open.
  setTimeout(() => form.querySelector('input[name="email"]')?.focus(), 50);

  // Show/hide password toggle.
  pwToggle.addEventListener('click', () => {
    const show = pwInput.type === 'password';
    pwInput.type = show ? 'text' : 'password';
    pwToggle.textContent = show ? '🙈' : '👁';
  });

  // Toggle between sign-in and register.
  toggleReg.addEventListener('click', () => {
    isRegister = !isRegister;
    title.textContent       = isRegister ? 'Create account' : 'Sign in';
    submitBtn.textContent   = isRegister ? 'Create account' : 'Sign in';
    toggleReg.textContent   = isRegister ? 'Have an account? Sign in' : 'Need an account? Register';
    nameLabel.style.display = isRegister ? '' : 'none';
    nameInput.required      = isRegister;
    hint.hidden             = !isRegister;
    forgot.hidden           = isRegister;
    pwInput.setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
    errEl.hidden = true;
    if (isRegister) setTimeout(() => nameInput.focus(), 50);
    else setTimeout(() => form.querySelector('input[name="email"]')?.focus(), 50);
  });

  // Forgot password — point to admin reset path.
  forgot.addEventListener('click', () => {
    errEl.innerHTML = 'Ask an SDC admin to reset your password — they can do it in <b>Setup → Users</b> in under 30 seconds.';
    errEl.hidden = false;
  });

  // Esc to dismiss (only when auth is off — if auth is required user must sign in).
  document.addEventListener('keydown', function _escHandler(e) {
    if (e.key === 'Escape' && !window.sdcAuth.authEnabled) {
      _modalEl.classList.remove('is-open');
      document.removeEventListener('keydown', _escHandler);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = isRegister ? 'Creating…' : 'Signing in…';
    const data = Object.fromEntries(new FormData(form).entries());
    const url  = isRegister ? '/api/auth/register' : '/api/auth/login';
    if (isRegister) data.avatar_color = _randomColor();
    try {
      const r = await _originalFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || (isRegister ? 'Registration failed' : 'Sign-in failed'));
      window.sdcAuth.token = body.token;
      window.sdcAuth.user  = body.user;
      localStorage.setItem(TOKEN_KEY, body.token);
      try { localStorage.setItem(USER_KEY, JSON.stringify(body.user)); } catch (_) {}
      location.reload();
    } catch (e2) {
      errEl.textContent = e2.message;
      errEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = isRegister ? 'Create account' : 'Sign in';
    }
  });
}

// ── user avatar pill ──────────────────────────────────────────────────────────
function _renderUserPill() {
  if (!window.sdcAuth.authEnabled || !window.sdcAuth.user) return;
  if (document.getElementById('sdc-auth-pill')) return;
  const u = window.sdcAuth.user;
  const initials = (u.name || '?').split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
  const pill = document.createElement('div');
  pill.id = 'sdc-auth-pill';
  pill.className = 'sdc-auth-pill';
  pill.innerHTML = `
    <button type="button" class="sdc-auth-avatar" style="background:${u.avatar_color || '#1574c4'};" title="${u.name} · ${u.role}">${initials}</button>
    <div class="sdc-auth-menu" hidden>
      <div class="sdc-auth-menu-name">${u.name}</div>
      <div class="sdc-auth-menu-role">${u.role}</div>
      <button type="button" class="sdc-auth-changepw">🔑 Change password</button>
      <button type="button" class="sdc-auth-signout">Sign out</button>
    </div>
  `;
  const menu = pill.querySelector('.sdc-auth-menu');
  pill.querySelector('.sdc-auth-avatar').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  pill.querySelector('.sdc-auth-signout').addEventListener('click', () => window.sdcAuth.signOut());
  pill.querySelector('.sdc-auth-changepw').addEventListener('click', () => { menu.hidden = true; _showChangePasswordModal(); });
  document.addEventListener('click', (e) => { if (!pill.contains(e.target)) menu.hidden = true; });
  document.body.appendChild(pill);
}

// ── Change password modal ─────────────────────────────────────────────────────
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
          <div class="sdc-pw-wrap">
            <input type="password" name="current_password" required autocomplete="current-password" maxlength="1024" />
            <button type="button" class="sdc-pw-toggle" tabindex="-1" aria-label="Show">👁</button>
          </div>
        </label>
        <label>New password
          <div class="sdc-pw-wrap">
            <input type="password" name="new_password" required autocomplete="new-password" maxlength="1024" />
            <button type="button" class="sdc-pw-toggle" tabindex="-1" aria-label="Show">👁</button>
          </div>
        </label>
        <p class="sdc-auth-error" id="sdc-change-pw-error" hidden></p>
        <div style="display:flex;gap:8px;margin-top:4px;">
          <button type="submit" class="btn-primary" id="sdc-change-pw-submit" style="flex:1;">Update</button>
          <button type="button" id="sdc-change-pw-cancel" style="flex:1;">Cancel</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  // Show/hide toggles on both password fields.
  modal.querySelectorAll('.sdc-pw-toggle').forEach(btn => {
    const inp = btn.previousElementSibling;
    btn.addEventListener('click', () => {
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
    });
  });

  modal.querySelector('#sdc-change-pw-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.addEventListener('keydown', function _esc(e) {
    if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', _esc); }
  });

  modal.querySelector('#sdc-change-pw-form').addEventListener('submit', async e => {
    e.preventDefault();
    const data   = Object.fromEntries(new FormData(e.target).entries());
    const errEl  = modal.querySelector('#sdc-change-pw-error');
    const btn    = modal.querySelector('#sdc-change-pw-submit');
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Updating…';
    try {
      const r = await fetch('/api/auth/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      let body;
      try { body = await r.json(); } catch (_) { throw new Error('Server error — please refresh and try again'); }
      if (!r.ok) throw new Error(body.error || 'Update failed');
      if (typeof showToast === 'function') showToast('Password updated successfully.', { kind: 'success' });
      modal.remove();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Update';
    }
  });

  modal.querySelector('input[name="current_password"]').focus();
}
