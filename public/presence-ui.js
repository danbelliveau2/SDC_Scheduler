/**
 * presence-ui.js — Phase 4.1 "who's editing this project" pills.
 *
 * Listens for the server's `presence:update` Socket.io events and renders
 * a small floating strip of avatar circles in the top-right (under the
 * auth user pill) showing every active collaborator on the current project.
 *
 * No-op if the Socket.io client isn't loaded or if no user is signed in
 * (presence requires a user identity).
 */
'use strict';

(function () {
  if (typeof io !== 'function') return;

  let container = null;
  let currentProject = null;

  function _ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.className = 'sdc-presence-strip';
    container.title = 'Currently editing this project';
    document.body.appendChild(container);
    return container;
  }

  function _renderPills(users) {
    const el = _ensureContainer();
    // Exclude self so the user doesn't see their own avatar duplicated.
    const selfId = window.sdcAuth?.user?.id ?? null;
    const others = (users || []).filter(u => u.id !== selfId);
    if (others.length === 0) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = others.map(u => {
      const initials = (u.name || '?').split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
      return `<span class="sdc-presence-avatar" title="${(u.name || '').replace(/[<>]/g, '')} is here"
                    style="background:${u.avatar_color || '#1574c4'};">${initials}</span>`;
    }).join('');
  }

  // Hook into the global socket created by realtime-ui.js. If it doesn't
  // exist yet (race on script load), retry once after a short delay.
  function _wire() {
    const s = window._sdcSocket;
    if (!s) { setTimeout(_wire, 400); return; }
    s.on('presence:update', ({ project, users }) => {
      if (!currentProject || project !== currentProject) return;
      _renderPills(users);
    });
  }
  _wire();

  // Watch for project switches via the existing app state. Poll the active
  // project once per second — coarser than mutation observing but a lot
  // simpler given app.js doesn't expose a hook for project changes.
  setInterval(() => {
    try {
      const p = (typeof state !== 'undefined') ? state?.filters?.project : null;
      if (p !== currentProject) {
        // Tell server we left the old one + joined the new one.
        const s = window._sdcSocket;
        const u = window.sdcAuth?.user;
        if (s && u) {
          if (currentProject) s.emit('presence:leave', { project: currentProject });
          if (p)              s.emit('presence:join',  { project: p, user: u });
        }
        currentProject = p;
        if (!p) _renderPills([]); // clear when no project is active
      }
    } catch (_) {}
  }, 1000);
})();
