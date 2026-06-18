/**
 * app-local.js — SDC Automation additions on top of Dan's scheduler base.
 *
 * Loaded last (after app.js, auth-ui.js, comments-ui.js, realtime-ui.js,
 * presence-ui.js).  Only adds what Dan's repo doesn't have yet:
 *
 *   1. Conflict detection — sends client_updated_at on every task PUT so
 *      the server returns 409 when two people edit the same task at once.
 *   2. Change-history API — api.history(project) endpoint.
 *   3. + New tab fix — openSidebarPanel('workspaces') silently fails because
 *      #app-sidebar-panel doesn't exist; patch to showProjectAddPicker().
 *   4. initCommentsUI() bootstrap — kicks off badge injection + panel wiring.
 *
 * Everything else (auth wrapper, socket.io, presence, real-time refresh)
 * is handled by Dan's own files.
 */

'use strict';

// ── 1. Conflict detection — send client_updated_at on every task PUT ─────────
// The server returns 409 if another user saved between your load and your save.
// We look up the task's current updated_at from state.tasks before each PUT.

const _origApiUpdate = (typeof api !== 'undefined') ? api.update : null;
if (_origApiUpdate) {
  api.update = async function (id, data) {
    // Stamp the version the client last saw so the server can detect conflicts
    const currentTask = (typeof state !== 'undefined' ? (state.tasks || []) : []).find(t => t.id === id);
    const client_updated_at = currentTask?.updated_at;
    const payload = client_updated_at ? { ...data, client_updated_at } : data;

    const r = await window.fetch(`/api/tasks/${id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (r.status === 409) {
      const body = await r.json().catch(() => ({}));
      const who  = body.server_updated_by || 'someone else';
      if (typeof showToast === 'function') {
        showToast(
          `⚠ Save conflict — ${body.error || 'This task was modified by another user.'} (Last saved by: ${who})`,
          { kind: 'error', duration: 9000 }
        );
      }
      if (typeof loadTasks === 'function') loadTasks();
      return null;
    }
    return r.json();
  };
}

// ── 2. Audit history endpoint ─────────────────────────────────────────────────

if (typeof api !== 'undefined') {
  api.history = (project, limit = 200) =>
    window.fetch(`/api/tasks/history?project=${encodeURIComponent(project)}&limit=${limit}`)
      .then(r => r.json());
}

// ── 3. Fix + New tab button ───────────────────────────────────────────────────
// openSidebarPanel('workspaces') silently does nothing — #app-sidebar-panel
// doesn't exist in index.html.  Patch the click to use showProjectAddPicker().

(function fixNewTabButton() {
  function patch() {
    const btn = document.getElementById('btn-add-project');
    if (!btn) return;
    const fresh = btn.cloneNode(true);       // strips existing listeners
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', e => {
      e.stopPropagation();
      if (typeof showProjectAddPicker === 'function') showProjectAddPicker();
    });
    fresh.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (typeof showProjectAddPicker === 'function') showProjectAddPicker();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(patch, 150));
  } else {
    setTimeout(patch, 150);
  }
})();

// ── 4. Bootstrap comments UI ─────────────────────────────────────────────────
// comments-ui.js is loaded by index.html but needs initCommentsUI() called
// once the app state is ready.

(function bootComments() {
  function tryInit() {
    if (typeof initCommentsUI === 'function') {
      initCommentsUI();
    } else {
      setTimeout(tryInit, 300);
    }
  }
  // Wait until after app.js init() has run
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryInit, 800));
  } else {
    setTimeout(tryInit, 800);
  }
})();

// ── 5. Auto-reload when Dan pushes a new version ─────────────────────────────
// server.js emits 'build:id' (current .update-sha SHA) on every socket connect
// and reconnect. First receive stores the SHA; any later receive with a
// different SHA means the server restarted after a Dan update → reload the page
// so every client automatically gets the new frontend without any manual step.
// Fallback: also polls /api/build-id every 30 s in case the socket never fires.
(function autoReloadOnUpdate() {
  let _loadedSha = null;

  function onBuildId(sha) {
    if (!sha || sha === 'unknown') return;
    if (!_loadedSha) { _loadedSha = sha; return; }
    if (sha !== _loadedSha) window.location.reload();
  }

  function wireSocket() {
    if (window._sdcSocket) { window._sdcSocket.on('build:id', onBuildId); return; }
    setTimeout(wireSocket, 500);
  }

  async function pollBuildId() {
    try {
      const r = await fetch('/api/build-id', { cache: 'no-store' });
      if (r.ok) onBuildId((await r.json()).sha);
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      wireSocket(); pollBuildId(); setInterval(pollBuildId, 30000);
    });
  } else {
    wireSocket(); pollBuildId(); setInterval(pollBuildId, 30000);
  }
})();
