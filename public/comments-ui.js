/**
 * comments-ui.js — Task comment panel with @mention autocomplete.
 *
 * Ported from feature/smartsheet-architecture (Abhi). Stripped of the
 * auth/Socket.io/email dependencies that haven't landed yet (Phases 3, 4,
 * 6) — talks to plain fetch endpoints, uses the existing #task_comments
 * routes, and falls back to anonymous comments until auth is wired.
 *
 * Public API (window globals):
 *   initCommentsUI()    — boot once on app start
 *   loadCommentCounts() — refresh the badge counts for the current project
 *   openCommentPanel({ id, name, project }) — open the slide-in panel
 *   closeCommentPanel()
 */
'use strict';

let _panel        = null;
let _currentTask  = null; // { id, name, project }
let _teamNames    = [];   // cached for @mention autocomplete
let _commentCounts = {};  // taskId → count map per project

// ── Comment count badges ─────────────────────────────────────────────────

async function loadCommentCounts(project) {
  if (!project) return;
  try {
    const r = await fetch(`/api/tasks/comment-counts?project=${encodeURIComponent(project)}`);
    if (!r.ok) return;
    _commentCounts = await r.json();
    injectCommentBadges();
  } catch {}
}

function injectCommentBadges() {
  // Task rows in app.js carry data-id on the <tr>.
  const rows = document.querySelectorAll('#tasks-tbody tr[data-id]');
  rows.forEach(tr => {
    const id = Number(tr.getAttribute('data-id'));
    if (!id) return;
    tr.querySelector('.sdc-comment-badge')?.remove();
    const count = _commentCounts[id] || 0;
    const badge = document.createElement('span');
    badge.className = 'sdc-comment-badge' + (count > 0 ? ' has-comments' : '');
    badge.title = count > 0 ? `${count} comment${count > 1 ? 's' : ''}` : 'Add comment';
    badge.textContent = count > 0 ? `💬 ${count}` : '💬';
    badge.addEventListener('click', e => {
      e.stopPropagation();
      const nameEl = tr.querySelector('td[data-col="name"]');
      const taskName = nameEl?.textContent?.trim() || `Task #${id}`;
      const project  = (typeof state !== 'undefined' && state.filters?.project) || '';
      openCommentPanel({ id, name: taskName, project });
    });
    // Append badge into the name cell so it sits next to the task name.
    const nameCell = tr.querySelector('td[data-col="name"] .name-cell-main')
                  || tr.querySelector('td[data-col="name"]');
    if (nameCell) nameCell.appendChild(badge);
  });
}

// Watch the tasks tbody for re-renders triggered by loadTasks(); re-inject
// badges after a short debounce so the comment column doesn't blank on
// every save.
function watchForTableRender() {
  const tbody = document.getElementById('tasks-tbody');
  if (!tbody) { setTimeout(watchForTableRender, 800); return; }
  const obs = new MutationObserver(() => {
    clearTimeout(watchForTableRender._timer);
    watchForTableRender._timer = setTimeout(injectCommentBadges, 120);
  });
  obs.observe(tbody, { childList: true, subtree: true });
}

// ── Comment panel ────────────────────────────────────────────────────────

function openCommentPanel(task) {
  _currentTask = task;
  _ensurePanel();
  _panel.querySelector('.sdc-comment-panel-title').textContent = task.name;
  _panel.classList.add('is-open');
  loadComments(task.id);
  loadTeamNames();
  if (task.project) loadCommentCounts(task.project);
}

function closeCommentPanel() {
  _panel?.classList.remove('is-open');
  _currentTask = null;
}

function _ensurePanel() {
  if (_panel) return;
  _panel = document.createElement('div');
  _panel.className = 'sdc-comment-panel';
  _panel.innerHTML = `
    <div class="sdc-comment-panel-header">
      <span style="font-size:16px;">💬</span>
      <span class="sdc-comment-panel-title">Comments</span>
      <button class="sdc-comment-panel-close" title="Close">×</button>
    </div>
    <div class="sdc-comment-list" id="sdc-comment-list">
      <div class="sdc-comment-empty">Loading…</div>
    </div>
    <div class="sdc-comment-footer">
      <div style="position:relative;">
        <textarea class="sdc-comment-textarea" id="sdc-comment-input"
          placeholder="Write a comment… Use @Name to mention someone" rows="3"></textarea>
        <div id="sdc-mention-dropdown" class="sdc-mention-dropdown" style="display:none;"></div>
      </div>
      <div class="sdc-comment-actions">
        <span class="sdc-comment-hint">Enter to post · Shift+Enter for new line</span>
        <button class="sdc-comment-submit" id="sdc-comment-submit">Post</button>
      </div>
    </div>
  `;
  document.body.appendChild(_panel);
  _panel.querySelector('.sdc-comment-panel-close').addEventListener('click', closeCommentPanel);
  _panel.querySelector('#sdc-comment-submit').addEventListener('click', submitComment);
  const textarea = _panel.querySelector('#sdc-comment-input');
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(); }
  });
  textarea.addEventListener('input', handleMentionAutocomplete);
  textarea.addEventListener('keydown', handleMentionNavigation);
}

// ── Comments data ────────────────────────────────────────────────────────

async function loadComments(taskId) {
  const list = document.getElementById('sdc-comment-list');
  if (!list) return;
  try {
    const r = await fetch(`/api/tasks/${taskId}/comments`);
    const comments = await r.json();
    renderComments(comments);
  } catch {
    list.innerHTML = '<div class="sdc-comment-empty">Failed to load comments.</div>';
  }
}

function renderComments(comments) {
  const list = document.getElementById('sdc-comment-list');
  if (!list) return;
  if (!Array.isArray(comments) || comments.length === 0) {
    list.innerHTML = '<div class="sdc-comment-empty">No comments yet. Be the first!</div>';
    return;
  }
  list.innerHTML = '';
  for (const c of comments) {
    const initials = (c.author_name || '?').split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
    const color    = _getAvatarColor(c.author_name);
    const timeAgo  = _formatTime(c.created_at);
    const bodyHtml = _renderBody(c.body);
    // Auth not landed yet — allow delete on every comment for now.
    const item = document.createElement('div');
    item.className = 'sdc-comment-item';
    item.dataset.commentId = c.id;
    item.innerHTML = `
      <span class="sdc-comment-avatar" style="background:${color};">${initials}</span>
      <div class="sdc-comment-body-wrap">
        <div class="sdc-comment-meta">
          <span class="sdc-comment-author">${_esc(c.author_name)}</span>
          <span class="sdc-comment-time">${timeAgo}</span>
          <span class="sdc-comment-delete" title="Delete comment">Delete</span>
        </div>
        <div class="sdc-comment-text">${bodyHtml}</div>
      </div>
    `;
    item.querySelector('.sdc-comment-delete').addEventListener('click', () => deleteComment(c.id));
    list.appendChild(item);
  }
  list.scrollTop = list.scrollHeight;
}

async function submitComment() {
  const textarea = document.getElementById('sdc-comment-input');
  const btn      = document.getElementById('sdc-comment-submit');
  const body     = (textarea?.value || '').trim();
  if (!body || !_currentTask) return;
  btn.disabled = true;
  try {
    const r = await fetch(`/api/tasks/${_currentTask.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Post failed');
    }
    textarea.value = '';
    hideMentionDropdown();
    await loadComments(_currentTask.id);
    await loadCommentCounts(_currentTask.project);
  } catch (err) {
    if (typeof showToast === 'function') {
      showToast('Failed to post comment: ' + (err.message || err), { kind: 'error' });
    } else {
      alert('Failed to post comment: ' + (err.message || err));
    }
  } finally {
    btn.disabled = false;
    textarea.focus();
  }
}

async function deleteComment(commentId) {
  if (!confirm('Delete this comment?')) return;
  try {
    await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
    await loadComments(_currentTask.id);
    await loadCommentCounts(_currentTask.project);
  } catch (err) {
    if (typeof showToast === 'function') {
      showToast('Failed to delete comment.', { kind: 'error' });
    }
  }
}

// ── @mention autocomplete ────────────────────────────────────────────────

let _mentionQuery    = '';
let _mentionStart    = -1;
let _mentionActive   = false;
let _mentionSelected = 0;

async function loadTeamNames() {
  if (_teamNames.length > 0) return;
  try {
    const r = await fetch('/api/team');
    const team = await r.json();
    _teamNames = (team || []).map(m => m.name).filter(Boolean);
  } catch {}
}

function handleMentionAutocomplete(e) {
  const textarea = e.target;
  const value    = textarea.value;
  const cursor   = textarea.selectionStart;
  const before   = value.slice(0, cursor);
  const atIdx    = before.lastIndexOf('@');
  if (atIdx < 0 || (atIdx > 0 && !/\s/.test(before[atIdx - 1]))) {
    hideMentionDropdown(); return;
  }
  const query = before.slice(atIdx + 1);
  if (query.includes(' ') && query.length > 20) { hideMentionDropdown(); return; }
  _mentionQuery  = query.toLowerCase();
  _mentionStart  = atIdx;
  _mentionActive = true;
  _mentionSelected = 0;
  const matches = _teamNames.filter(n => n.toLowerCase().startsWith(_mentionQuery)).slice(0, 8);
  if (matches.length === 0) { hideMentionDropdown(); return; }
  showMentionDropdown(matches, textarea);
}

function handleMentionNavigation(e) {
  const dropdown = document.getElementById('sdc-mention-dropdown');
  if (!_mentionActive || !dropdown || dropdown.style.display === 'none') return;
  const items = dropdown.querySelectorAll('.sdc-mention-item');
  if (e.key === 'ArrowDown') { e.preventDefault(); _mentionSelected = (_mentionSelected + 1) % items.length; updateMentionHighlight(items); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); _mentionSelected = (_mentionSelected - 1 + items.length) % items.length; updateMentionHighlight(items); }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); items[_mentionSelected]?.click(); }
  else if (e.key === 'Escape') { hideMentionDropdown(); }
}

function showMentionDropdown(matches, textarea) {
  const dropdown = document.getElementById('sdc-mention-dropdown');
  if (!dropdown) return;
  dropdown.innerHTML = matches.map((n, i) => {
    const initials = n.split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
    const color    = _getAvatarColor(n);
    return `<div class="sdc-mention-item${i === 0 ? ' active' : ''}" data-name="${_esc(n)}">
      <span style="width:22px;height:22px;border-radius:50%;background:${color};display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;flex-shrink:0;">${initials}</span>
      ${_esc(n)}
    </div>`;
  }).join('');
  dropdown.style.display = '';
  dropdown.querySelectorAll('.sdc-mention-item').forEach(item => {
    item.addEventListener('click', () => insertMention(item.dataset.name, textarea));
  });
  const rect = textarea.getBoundingClientRect();
  dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
  dropdown.style.left   = rect.left + 'px';
  dropdown.style.position = 'fixed';
  document.body.appendChild(dropdown);
}

function updateMentionHighlight(items) {
  items.forEach((el, i) => el.classList.toggle('active', i === _mentionSelected));
}

function hideMentionDropdown() {
  const dropdown = document.getElementById('sdc-mention-dropdown');
  if (dropdown) dropdown.style.display = 'none';
  _mentionActive = false;
}

function insertMention(name, textarea) {
  const val    = textarea.value;
  const before = val.slice(0, _mentionStart);
  const after  = val.slice(textarea.selectionStart);
  textarea.value = before + '@' + name + ' ' + after;
  const pos = (_mentionStart + name.length + 2);
  textarea.setSelectionRange(pos, pos);
  hideMentionDropdown();
  textarea.focus();
}

// ── Helpers ──────────────────────────────────────────────────────────────

function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function _renderBody(text) {
  return _esc(text).replace(/@([\w\s]+?)(?=\s|$|[^a-zA-Z\s])/g, '<span class="sdc-comment-mention">@$1</span>');
}

function _formatTime(iso) {
  try {
    const d    = new Date(iso);
    const diff = (Date.now() - d) / 1000;
    if (diff < 60)    return 'just now';
    if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return iso || ''; }
}

const _colorPalette = ['#1574c4', '#7c3aed', '#059669', '#dc2626', '#d97706', '#0891b2', '#be185d', '#65a30d'];
function _getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return _colorPalette[Math.abs(hash) % _colorPalette.length];
}

// ── Init ─────────────────────────────────────────────────────────────────

function initCommentsUI() {
  watchForTableRender();
  // Initial badge load for the current project.
  const project = (typeof state !== 'undefined' && state.filters?.project) || '';
  if (project) loadCommentCounts(project);
}

// Expose for app.js to call on project switches.
window.openCommentPanel  = openCommentPanel;
window.closeCommentPanel = closeCommentPanel;
window.loadCommentCounts = loadCommentCounts;
window.initCommentsUI    = initCommentsUI;
