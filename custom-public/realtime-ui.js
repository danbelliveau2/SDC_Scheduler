/**
 * realtime-ui.js — Phase 4 client-side Socket.io listener.
 *
 * Connects to the server's Socket.io and listens for invalidate events:
 *   tasks:updated    → debounce + reload tasks
 *   team:updated     → debounce + reload team
 *   settings:updated → debounce + reload settings
 *   users:updated    → no-op for now (Phase 3.5 may surface user list)
 *
 * Debounced (250 ms) so a burst of saves from another tab triggers one
 * reload, not ten. Reload is best-effort — uses the existing loadTasks /
 * loadTeam / loadSettings functions from app.js if they're present.
 *
 * No-op if window.io isn't available (CDN failed to load) — silent fallback,
 * the app still works in single-tab mode.
 */
'use strict';

(function () {
  if (typeof io !== 'function') return;       // socket.io CDN didn't load
  const socket = io('/', { transports: ['websocket', 'polling'] });

  const _debouncers = {};
  function _debounce(key, fn, ms = 250) {
    clearTimeout(_debouncers[key]);
    _debouncers[key] = setTimeout(fn, ms);
  }

  // Track whether the current tab made the most recent local edit so we
  // don't echo our own write back as a "remote" change. App.js can stamp
  // window._lastLocalEdit when it kicks off a save; we ignore events that
  // arrive within 800 ms of that stamp.
  function _isLocalEcho() {
    return window._lastLocalEdit && (Date.now() - window._lastLocalEdit) < 800;
  }

  socket.on('tasks:updated', (_payload) => {
    if (_isLocalEcho()) return;
    _debounce('tasks', () => {
      if (typeof loadTasks === 'function') loadTasks();
    });
  });

  socket.on('team:updated', () => {
    // Skip echoes from our own writes — otherwise the 250 ms-debounced reload
    // tears down team-input rows while the user is still typing in them.
    if (_isLocalEcho()) return;
    _debounce('team', () => {
      if (typeof loadTeam === 'function') loadTeam();
    });
  });

  socket.on('settings:updated', () => {
    _debounce('settings', () => {
      if (typeof loadSettings === 'function') loadSettings();
    });
  });

  socket.on('connect', () => {
    // Phase 4.1: announce ourselves as present on the active project so the
    // server can broadcast a "currently editing" pill list. Best-effort —
    // app.js doesn't have a state.filters.project until after init.
    setTimeout(() => {
      try {
        const project = (typeof state !== 'undefined') ? state?.filters?.project : null;
        const user    = window.sdcAuth?.user || { id: 0, name: 'anonymous' };
        if (project) socket.emit('presence:join', { project, user });
      } catch (_) {}
    }, 600);
  });

  window._sdcSocket = socket;
})();
