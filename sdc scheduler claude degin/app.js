/* ----------------------------------------------------------------------
 *  app.js — SDC Scheduler demo driver
 *  This is a lightweight stub that populates the UI with realistic mock data
 *  and wires up the light interactions called for in the design brief:
 *    - view tabs (Schedule / Team / Setup) switch
 *    - project tabs (open schedules) click to activate
 *    - filters popover + revision popover open/close
 *    - Smartsheet sync + keyboard help modals open/close
 *    - schedule grid + custom mock Gantt render aligned, hover highlights
 *  In production these are all real features driven by /api/* calls.
 * ---------------------------------------------------------------------- */

(() => {
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const TODAY = new Date('2026-05-13');

  /* ----------- 1. Mock projects + tasks ------------------------------- */

  // Helper to build a date offset N days from a base date.
  const dt = (base, days) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
  };
  const fmt = (d) => d.toISOString().slice(0, 10);
  const fmtShort = (d) => {
    const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    return `${m} ${d.getDate()}`;
  };
  const daysBetween = (a, b) => Math.round((b - a) / 864e5);

  // Build schedule for project M-2718 — Battery Pack Assembly Cell
  function buildProject2718() {
    const po = new Date('2026-01-12');
    const tasks = [];
    let id = 100;
    const T = (def) => { tasks.push({ id: id++, ...def }); };

    // --- ANCHOR: PO ---
    T({ name: 'Receipt of PO',          section: 'design_build', dept: '_anchor', subdept: null,
        phase: null, assignee: '—', start: po, end: po, duration: 0,
        progress: 100, pred: '', isAnchor: true, isMilestone: true });

    // --- Section 10 / Engineering / Mechanical ---
    T({ name: 'Concept layout',         section: 'design_build', dept: 'engineering', subdept: 'mech',
        phase: 'concept',  assignee: 'Riley Tomas', start: dt(po, 3),  end: dt(po, 17),
        duration: 14, progress: 100, pred: 'FS' });
    T({ name: 'Detail drawings',        section: 'design_build', dept: 'engineering', subdept: 'mech',
        phase: 'mech',     assignee: 'Sam Pham',    start: dt(po, 18), end: dt(po, 42),
        duration: 24, progress: 92, pred: 'FS+1d' });
    T({ name: 'BOM release',            section: 'design_build', dept: 'engineering', subdept: 'mech',
        phase: 'mech',     assignee: 'Devon Carr',  start: dt(po, 40), end: dt(po, 50),
        duration: 10, progress: 80, pred: 'SS' });

    // --- Section 10 / Engineering / Electrical ---
    T({ name: 'Schematic capture',      section: 'design_build', dept: 'engineering', subdept: 'elec',
        phase: 'elec',     assignee: 'Jordan Wells', start: dt(po, 14), end: dt(po, 38),
        duration: 24, progress: 88, pred: 'FS' });
    T({ name: 'Panel layout',           section: 'design_build', dept: 'engineering', subdept: 'elec',
        phase: 'elec',     assignee: 'Maya Cohen',   start: dt(po, 38), end: dt(po, 56),
        duration: 18, progress: 55, pred: 'FS' });

    // --- Section 10 / Engineering / Controls ---
    T({ name: 'PLC code v1',            section: 'design_build', dept: 'engineering', subdept: 'ctrls',
        phase: 'ctrls',    assignee: 'Alex Yu',     start: dt(po, 28), end: dt(po, 70),
        duration: 42, progress: 40, pred: 'SS' });
    T({ name: 'HMI screens',            section: 'design_build', dept: 'engineering', subdept: 'ctrls',
        phase: 'ctrls',    assignee: 'Bobby Chen',  start: dt(po, 56), end: dt(po, 84),
        duration: 28, progress: 12, pred: 'FS-10d' });

    // --- Section 10 / Procurement ---
    T({ name: 'Order long lead',        section: 'design_build', dept: 'procurement', subdept: null,
        phase: 'procure',  assignee: 'Priya Anand', start: dt(po, 7),  end: dt(po, 9),
        duration: 2, progress: 100, pred: 'FS' });
    T({ name: 'Receive servo motors',   section: 'design_build', dept: 'procurement', subdept: null,
        phase: 'procure',  assignee: 'Priya Anand', start: dt(po, 70), end: dt(po, 84),
        duration: 14, progress: 0, pred: 'FS' });

    // --- Section 10 / Shop / Fabrication ---
    T({ name: 'Frame weld-out',         section: 'design_build', dept: 'shop', subdept: 'fab',
        phase: 'fab',      assignee: 'Vince Pareto', start: dt(po, 56), end: dt(po, 80),
        duration: 24, progress: 0, pred: 'FS' });

    // --- Section 10 / Shop / Assembly ---
    T({ name: 'Sub-assembly',           section: 'design_build', dept: 'shop', subdept: 'assy',
        phase: 'assy',     assignee: 'Kade Lindstrom', start: dt(po, 80), end: dt(po, 110),
        duration: 30, progress: 0, pred: 'FS' });

    // --- ANCHOR: Machine Power-Up ---
    T({ name: 'Machine Power-Up',       section: 'design_build', dept: '_anchor', subdept: null,
        phase: null, assignee: '—', start: dt(po, 112), end: dt(po, 112), duration: 0,
        progress: 0, pred: '', isAnchor: true, isMilestone: true });

    // --- Section 40 / Shop ---
    T({ name: 'Mechanical debug',       section: 'machine_testing', dept: 'shop', subdept: null,
        phase: 'commission', assignee: 'Hannah Ohr', start: dt(po, 112), end: dt(po, 130),
        duration: 18, progress: 0, pred: 'FS' });
    T({ name: 'Electrical commission',  section: 'machine_testing', dept: 'shop', subdept: null,
        phase: 'commission', assignee: 'Tariq Rahim', start: dt(po, 116), end: dt(po, 140),
        duration: 24, progress: 0, pred: 'SS+4d' });
    T({ name: 'FAT prep',               section: 'machine_testing', dept: 'shop', subdept: null,
        phase: 'fat',      assignee: 'Theo Bell',   start: dt(po, 138), end: dt(po, 150),
        duration: 12, progress: 0, pred: 'FS' });

    // --- ANCHOR: FAT ---
    T({ name: 'FAT',                    section: 'machine_testing', dept: '_anchor', subdept: null,
        phase: null, assignee: '—', start: dt(po, 152), end: dt(po, 156), duration: 4,
        progress: 0, pred: 'FS', isAnchor: true, isMilestone: false });

    // --- Section 50 / Shop ---
    T({ name: 'Disassemble',            section: 'teardown_install', dept: 'shop', subdept: null,
        phase: 'fab',      assignee: 'Marcus Reed', start: dt(po, 158), end: dt(po, 168),
        duration: 10, progress: 0, pred: 'FS' });
    T({ name: 'Crate + load',           section: 'teardown_install', dept: 'shop', subdept: null,
        phase: 'fab',      assignee: 'Marcus Reed', start: dt(po, 168), end: dt(po, 174),
        duration: 6, progress: 0, pred: 'FS' });
    // --- Section 50 / Install ---
    T({ name: 'Customer install',       section: 'teardown_install', dept: 'install', subdept: null,
        phase: 'install',  assignee: 'Liz Hardt',   start: dt(po, 180), end: dt(po, 210),
        duration: 30, progress: 0, pred: 'FS+4d' });

    // --- ANCHOR: Ship ---
    T({ name: 'Ship Machine',           section: 'teardown_install', dept: '_anchor', subdept: null,
        phase: null, assignee: '—', start: dt(po, 178), end: dt(po, 178), duration: 0,
        progress: 0, pred: 'FS', isAnchor: true, isMilestone: true });

    return {
      id: 'M-2718',
      num: 'M-2718',
      name: 'Battery Pack Assembly Cell',
      customer: 'Northstar Cell',
      tasks,
      poDate: po
    };
  }

  // Light second project so the project-tab bar has more than one tab
  function buildProject2719() {
    const po = new Date('2026-03-02');
    return {
      id: 'M-2719',
      num: 'M-2719',
      name: 'Powder Coat Line',
      customer: 'Veridian Metals',
      tasks: [],
      poDate: po
    };
  }
  function buildProject2715() {
    return {
      id: 'M-2715',
      num: 'M-2715',
      name: 'CNC Tending Robot',
      customer: 'Apex Industries',
      tasks: [],
      poDate: new Date('2025-11-04'),
      starred: true
    };
  }

  const projects = [buildProject2715(), buildProject2718(), buildProject2719()];
  let activeProjectId = 'M-2718';
  const phasesByKey = Object.fromEntries(SDC.PHASES.map((p) => [p.key, p]));
  const sectionsByKey = Object.fromEntries(SDC.SECTIONS.map((s) => [s.key, s]));
  const deptByKey = Object.fromEntries(SDC.HIERARCHY_COLORS.map((h) => [h.key, h]));

  /* ----------- 2. View / tab switching ---------------------------------- */

  function setView(view) {
    document.body.dataset.view = view;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

  /* ----------- 3. Project tabs ----------------------------------------- */

  function renderProjectTabs() {
    const wrap = $('#project-tabs');
    if (!wrap) return;
    wrap.innerHTML = '';
    // "All projects" tab first
    const all = document.createElement('button');
    all.className = 'project-tab is-all' + (activeProjectId === '__all' ? ' active' : '');
    all.type = 'button';
    all.dataset.projectId = '__all';
    all.innerHTML = '<span class="project-tab-label">All projects</span>';
    wrap.appendChild(all);

    projects.forEach((p) => {
      const tab = document.createElement('button');
      tab.className = 'project-tab' + (activeProjectId === p.id ? ' active' : '');
      tab.type = 'button';
      tab.dataset.projectId = p.id;
      let html = '';
      if (p.starred) html += '<span class="project-tab-star" title="Pinned">★</span>';
      html += `<span class="project-tab-label">${p.num} · ${p.name}</span>`;
      html += '<span class="project-tab-close" title="Close" data-close>×</span>';
      tab.innerHTML = html;
      wrap.appendChild(tab);
    });

    wrap.addEventListener('click', onProjectTabClick, { once: true });
  }
  function onProjectTabClick(e) {
    const tab = e.target.closest('.project-tab');
    if (!tab) return renderProjectTabs();
    if (e.target.matches('[data-close]')) {
      // mock close — just re-render
      return renderProjectTabs();
    }
    activeProjectId = tab.dataset.projectId;
    renderProjectTabs();
    renderScheduleHeader();
    renderTable();
    renderGantt();
  }

  /* ----------- 4. Schedule project header ------------------------------ */

  function activeProject() {
    if (activeProjectId === '__all') return null;
    return projects.find((p) => p.id === activeProjectId);
  }
  function renderScheduleHeader() {
    const p = activeProject();
    const label = $('.schedule-project-label');
    const meta = $('.schedule-project-meta');
    if (!label || !meta) return;
    if (!p) {
      label.textContent = 'All projects';
      meta.textContent = `${projects.reduce((n, q) => n + q.tasks.length, 0)} tasks across ${projects.length} open schedules`;
    } else {
      label.textContent = `${p.num} — ${p.name}`;
      const open = p.tasks.filter((t) => !t.isAnchor && t.progress < 100).length;
      meta.textContent = `${p.customer} · ${p.tasks.length} tasks · ${open} open`;
    }
    document.body.dataset.activeProject = p ? `${p.num} ${p.name}` : 'All projects';
  }

  /* ----------- 5. Schedule grid ---------------------------------------- */

  const COLS = [
    { key: 'line',      label: '#',           cls: 'col-line',      w: 32 },
    { key: 'id',        label: 'ID',          cls: 'col-id',        w: 42 },
    { key: 'name',      label: 'Task',        cls: 'col-name',      w: null },
    { key: 'assignee',  label: 'Assigned',    cls: 'col-assignee',  w: 110 },
    { key: 'duration',  label: 'Dur',         cls: 'col-duration',  w: 70  },
    { key: 'progress',  label: 'Progress',    cls: 'col-progress',  w: 100 },
    { key: 'start',     label: 'Start',       cls: 'col-date',      w: 84  },
    { key: 'end',       label: 'End',         cls: 'col-date',      w: 84  },
    { key: 'pred',      label: 'Pred',        cls: 'col-pred',      w: 80  }
  ];

  function renderColGroupAndHead() {
    const cg = $('#tasks-colgroup');
    cg.innerHTML = COLS.map((c) => c.w ? `<col style="width:${c.w}px">` : `<col>`).join('');
    const tr = $('#tasks-thead-row');
    tr.innerHTML = COLS.map((c) => `<th class="${c.cls}"><span class="th-label">${c.label}</span></th>`).join('');
  }

  function renderTable() {
    const tbody = $('#tasks-tbody');
    tbody.innerHTML = '';
    const p = activeProject();
    const emptyEl = $('#empty-state');
    if (!p || !p.tasks.length) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    // Group tasks by section > dept > subdept
    const sectionOrder = ['design_build', 'machine_testing', 'teardown_install'];
    let line = 1;
    const tasksBySection = {};
    p.tasks.forEach((t) => {
      (tasksBySection[t.section] = tasksBySection[t.section] || []).push(t);
    });

    const rows = [];

    sectionOrder.forEach((secKey) => {
      const secTasks = tasksBySection[secKey] || [];
      if (!secTasks.length) return;
      const sec = sectionsByKey[secKey];

      // Section header (level 1)
      rows.push({
        kind: 'header',
        level: 1,
        sectionKey: secKey,
        label: sec.label,
        count: secTasks.filter((t) => !t.isAnchor).length
      });

      // Render anchor rows interspersed and dept-grouped tasks
      // We want: anchors and dept/subdept groups in their natural in-section order.
      // Walk linearly; emit dept header on first non-anchor task w/ that dept; subdept on subdept change.
      let curDept = null, curSubdept = null;
      secTasks.forEach((t) => {
        if (t.isAnchor) {
          // Anchor row breaks dept context
          curDept = null; curSubdept = null;
          rows.push({ kind: 'task', task: t, lineNo: '—', isAnchor: true });
          return;
        }
        if (t.dept !== curDept) {
          curDept = t.dept; curSubdept = null;
          const d = deptByKey[t.dept];
          rows.push({
            kind: 'header', level: 2,
            label: d ? d.label.replace(/^—\s*/, '') : t.dept,
            count: secTasks.filter((q) => q.dept === t.dept && !q.isAnchor).length,
            fill: d ? d.fill : null, text: d ? d.text : null
          });
        }
        if (t.subdept && t.subdept !== curSubdept) {
          curSubdept = t.subdept;
          const sd = deptByKey[t.subdept];
          rows.push({
            kind: 'header', level: 3,
            label: sd ? sd.label.replace(/^—\s*/, '') : t.subdept,
            count: secTasks.filter((q) => q.subdept === t.subdept && !q.isAnchor).length,
            fill: sd ? sd.fill : null, text: sd ? sd.text : null
          });
        }
        rows.push({ kind: 'task', task: t, lineNo: line++ });
      });
    });

    // Render
    let html = '';
    rows.forEach((r) => {
      if (r.kind === 'header') {
        const lvl = r.level;
        const swatch = r.fill ? `<span class="group-swatch" style="background:${r.fill}"></span>` : '';
        html += `<tr class="group-header level-${lvl}"${lvl===1?` data-section-key="${r.sectionKey}"`:''}>` +
          `<td colspan="${COLS.length}">` +
          `<span class="group-caret">▾</span>` + swatch +
          `<span class="group-label">${r.label}</span>` +
          `<span class="group-count">${r.count} tasks</span>` +
          `</td></tr>`;
        return;
      }
      const t = r.task;
      if (r.isAnchor) {
        html += `<tr class="anchor-row" data-id="${t.id}">` +
          `<td class="col-line"><span class="line-num">—</span></td>` +
          `<td class="col-id">${t.id}</td>` +
          `<td class="col-name"><span class="anchor-name-chip">◆ ${t.name}</span></td>` +
          `<td class="col-assignee">—</td>` +
          `<td class="col-duration">${t.duration ? t.duration + 'd' : '—'}</td>` +
          `<td class="col-progress">—</td>` +
          `<td class="col-date">${fmtShort(t.start)}</td>` +
          `<td class="col-date">${fmtShort(t.end)}</td>` +
          `<td class="col-pred">${t.pred || '—'}</td>` +
          `</tr>`;
        return;
      }
      const ph = phasesByKey[t.phase] || { bg: '#cbd5e1', text: '#334155', label: '—' };
      const isLate = t.progress < 100 && t.end < TODAY;
      const overAlloc = (t.assignee === 'Alex Yu' && t.name.includes('PLC')); // demo flag
      html += `<tr data-id="${t.id}" class="depth-3" style="--row-phase-color:${ph.bg}">` +
        `<td class="col-line"><span class="row-drag">⋮⋮</span><span class="line-num">${r.lineNo}</span></td>` +
        `<td class="col-id">${t.id}</td>` +
        `<td class="col-name">${t.name}</td>` +
        `<td class="col-assignee${overAlloc ? ' over-allocated' : ''}" data-col="assignee" title="${overAlloc ? 'Over-allocated this week' : ''}">${t.assignee}</td>` +
        `<td class="col-duration">${t.duration}d</td>` +
        `<td class="col-progress"><span class="progress-bar"><span style="width:${t.progress}%"></span></span>${t.progress}%</td>` +
        `<td class="col-date">${fmtShort(t.start)}</td>` +
        `<td class="col-date" ${isLate ? 'style="color:var(--danger);font-weight:700"' : ''}>${fmtShort(t.end)}</td>` +
        `<td class="col-pred">${t.pred || '—'}</td>` +
        `</tr>`;
    });

    tbody.innerHTML = html;
    tbody.style.setProperty('--row-h', '32px');
  }

  /* ----------- 6. Mock Gantt SVG --------------------------------------- */

  function renderGantt() {
    const container = $('#gantt-container');
    if (!container) return;
    container.innerHTML = '';

    const p = activeProject();
    const ganttEmpty = $('#gantt-empty');
    if (!p || !p.tasks.length) {
      if (ganttEmpty) ganttEmpty.classList.remove('hidden');
      return;
    }
    if (ganttEmpty) ganttEmpty.classList.add('hidden');

    // Compute date range from the first task to the last task, padded by 1 month each side.
    const allDates = p.tasks.flatMap((t) => [t.start, t.end]);
    const min = new Date(Math.min(...allDates));
    const max = new Date(Math.max(...allDates));
    min.setDate(min.getDate() - 14);
    max.setDate(max.getDate() + 14);
    const totalDays = daysBetween(min, max);
    const PX_PER_DAY = 8;            // demo zoom
    const totalW = totalDays * PX_PER_DAY;

    // Build the wrap
    const wrap = document.createElement('div');
    wrap.className = 'mock-gantt';
    wrap.style.setProperty('--gantt-week-w', (PX_PER_DAY * 7) + 'px');
    wrap.style.width = totalW + 'px';

    // ---- Header: month bands ----
    const hdr = document.createElement('div');
    hdr.className = 'mock-gantt-header';
    // Build months from min..max
    const cursor = new Date(min);
    cursor.setDate(1);
    while (cursor <= max) {
      const start = new Date(Math.max(cursor.getTime(), min.getTime()));
      const next = new Date(cursor);
      next.setMonth(next.getMonth() + 1);
      const end = new Date(Math.min(next.getTime(), max.getTime()));
      const days = daysBetween(start, end);
      const w = days * PX_PER_DAY;
      const mLabel = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][start.getMonth()];
      const mEl = document.createElement('div');
      mEl.className = 'mock-gantt-month';
      mEl.style.width = w + 'px';
      mEl.textContent = `${mLabel} ${start.getFullYear()}`;
      mEl.dataset.weeks = Math.round(days / 7) + 'w';
      hdr.appendChild(mEl);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    wrap.appendChild(hdr);

    // ---- Rows that match the table's render rows ----
    // Replicate the same grouping/sequence as renderTable so each row lines up.
    const sectionOrder = ['design_build', 'machine_testing', 'teardown_install'];
    const tasksBySection = {};
    p.tasks.forEach((t) => { (tasksBySection[t.section] = tasksBySection[t.section] || []).push(t); });

    const xFor = (d) => daysBetween(min, d) * PX_PER_DAY;

    sectionOrder.forEach((secKey) => {
      const secTasks = tasksBySection[secKey] || [];
      if (!secTasks.length) return;
      const sec = sectionsByKey[secKey];
      // Section header row
      const sh = document.createElement('div');
      sh.className = 'mock-gantt-row is-section';
      wrap.appendChild(sh);

      let curDept = null, curSubdept = null;
      secTasks.forEach((t) => {
        if (t.isAnchor) {
          curDept = null; curSubdept = null;
          const row = document.createElement('div');
          row.className = 'mock-gantt-row is-anchor';
          const dia = document.createElement('span');
          dia.className = 'mock-gantt-diamond';
          dia.style.left = xFor(t.start) + 'px';
          dia.title = `${t.name} · ${fmtShort(t.start)}`;
          row.appendChild(dia);
          // Label sits to the right of the diamond
          const lbl = document.createElement('span');
          lbl.style.cssText = `position:absolute;top:50%;transform:translateY(-50%);left:${xFor(t.start) + 14}px;font-size:11px;font-weight:700;color:var(--anchor-text,var(--sdc-dark));white-space:nowrap`;
          lbl.textContent = t.name;
          row.appendChild(lbl);
          wrap.appendChild(row);
          return;
        }
        if (t.dept !== curDept) {
          curDept = t.dept; curSubdept = null;
          const dh = document.createElement('div');
          dh.className = 'mock-gantt-row is-dept';
          wrap.appendChild(dh);
        }
        if (t.subdept && t.subdept !== curSubdept) {
          curSubdept = t.subdept;
          const sh2 = document.createElement('div');
          sh2.className = 'mock-gantt-row is-subdept';
          wrap.appendChild(sh2);
        }
        // Task row
        const row = document.createElement('div');
        row.className = 'mock-gantt-row';
        const bar = document.createElement('div');
        bar.className = 'mock-gantt-bar';
        const ph = phasesByKey[t.phase] || { bg: '#cbd5e1', text: '#334155' };
        bar.style.background = ph.bg;
        bar.style.color = ph.text;
        bar.style.left = xFor(t.start) + 'px';
        bar.style.width = Math.max(daysBetween(t.start, t.end) * PX_PER_DAY, 6) + 'px';
        bar.title = `${t.name} · ${fmtShort(t.start)} → ${fmtShort(t.end)} · ${t.progress}%`;
        if (t.progress > 0) {
          const prog = document.createElement('span');
          prog.className = 'bar-progress';
          prog.style.width = t.progress + '%';
          bar.appendChild(prog);
        }
        const lbl = document.createElement('span');
        lbl.textContent = t.name;
        lbl.style.cssText = 'position:relative;z-index:1';
        bar.appendChild(lbl);
        row.appendChild(bar);
        wrap.appendChild(row);
      });
    });

    // Today line
    const today = document.createElement('div');
    today.className = 'mock-gantt-today';
    today.style.left = xFor(TODAY) + 'px';
    today.style.height = (wrap.querySelectorAll('.mock-gantt-row').length * 32 + 60) + 'px';
    wrap.appendChild(today);

    container.appendChild(wrap);

    // Legend
    const legend = $('#gantt-legend');
    if (legend) {
      legend.innerHTML = SDC.PHASES.slice(0, 6).map((p) =>
        `<span class="legend-item"><span class="legend-swatch" style="background:${p.bg}"></span>${p.label}</span>`
      ).join('') +
      `<span class="legend-item"><span class="legend-swatch" style="background:var(--sdc-green-light)"></span>Anchor</span>`;
    }
  }

  /* ----------- 7. Filters popover -------------------------------------- */

  function renderFilters() {
    const pop = $('#filters-popover');
    if (!pop) return;
    pop.innerHTML = `
      <div class="filters-popover-title">Quick filters</div>
      <div class="filters-quick-chips">
        <button class="filter-chip is-active" data-chip="me">Assigned to me</button>
        <button class="filter-chip" data-chip="open">Open only</button>
        <button class="filter-chip" data-chip="late">Late</button>
        <button class="filter-chip" data-chip="critical">Critical path</button>
        <button class="filter-chip" data-chip="this-week">This week</button>
      </div>
      <div class="filters-popover-title">By</div>
      <div class="filters-popover-row">
        <label>Section
          <select class="filter-select">
            <option>All sections</option>
            <option>10 — Design &amp; Build</option>
            <option>40 — Machine Testing</option>
            <option>50 — Teardown &amp; Install</option>
          </select>
        </label>
      </div>
      <div class="filters-popover-row">
        <label>Assignee
          <select class="filter-select">
            <option>Anyone</option>
            <option>Riley Tomas</option>
            <option>Sam Pham</option>
            <option>Jordan Wells</option>
            <option>Alex Yu</option>
          </select>
        </label>
      </div>
      <div class="filters-popover-actions">
        <button class="btn-ghost btn-tight" data-close-popover>Clear</button>
      </div>
    `;
    $$('.filter-chip', pop).forEach((c) => c.addEventListener('click', () => c.classList.toggle('is-active')));
    $('[data-close-popover]', pop).addEventListener('click', () => pop.classList.add('hidden'));
  }

  function renderRevisions() {
    const pop = $('#revision-popover');
    if (!pop) return;
    const list = SDC.RELEASE_NOTES;
    pop.innerHTML = `
      <div class="revision-popover-head">
        <h3 class="revision-popover-title">What's new</h3>
        <span class="revision-popover-subtitle">Build ${list[0].version.replace(/^v/, '')}</span>
      </div>
      <div class="revision-popover-body">
        ${list.map((r) => `
          <div class="revision-entry">
            <div class="revision-entry-head">
              <span class="revision-entry-version">${r.version}</span>
              <span class="revision-entry-date">${r.date}</span>
            </div>
            <ul class="revision-entry-notes">${r.notes.map((n) => `<li>${n}</li>`).join('')}</ul>
          </div>
        `).join('')}
      </div>
    `;
    // Update topbar pill
    const ver = $('#revision-version');
    if (ver) ver.textContent = list[0].version;
  }

  function wireTopbar() {
    const btnFilters = $('#btn-filters');
    const popFilters = $('#filters-popover');
    btnFilters && btnFilters.addEventListener('click', (e) => {
      e.stopPropagation();
      popFilters.classList.toggle('hidden');
      $('#revision-popover').classList.add('hidden');
      if (!popFilters.classList.contains('hidden')) {
        const r = btnFilters.getBoundingClientRect();
        popFilters.style.top = (r.bottom + 6) + 'px';
        popFilters.style.left = Math.max(8, r.right - 300) + 'px';
      }
    });

    const btnRev = $('#btn-revision');
    const popRev = $('#revision-popover');
    btnRev && btnRev.addEventListener('click', (e) => {
      e.stopPropagation();
      popRev.classList.toggle('hidden');
      popFilters.classList.add('hidden');
      if (!popRev.classList.contains('hidden')) {
        const r = btnRev.getBoundingClientRect();
        popRev.style.top = (r.bottom + 6) + 'px';
        popRev.style.left = Math.max(8, r.right - 400) + 'px';
      }
    });

    document.addEventListener('click', () => {
      popFilters && popFilters.classList.add('hidden');
      popRev && popRev.classList.add('hidden');
    });
    [popFilters, popRev].forEach((el) => el && el.addEventListener('click', (e) => e.stopPropagation()));

    // Filter chip count badge
    const filterCount = $('#filter-chip-count');
    if (filterCount) {
      filterCount.hidden = false;
      filterCount.textContent = '1';
    }
  }

  /* ----------- 8. Modals ----------------------------------------------- */

  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.remove('hidden');
  }
  function closeModal(m) { m.classList.add('hidden'); }

  function wireModals() {
    $('#btn-smartsheet-sync') && $('#btn-smartsheet-sync').addEventListener('click', () => openModal('modal-smartsheet'));

    $$('.modal-overlay').forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target === m) closeModal(m);
      });
      $$('[data-close-modal]', m).forEach((b) => b.addEventListener('click', () => closeModal(m)));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $$('.modal-overlay').forEach(closeModal);
      if (e.key === '?' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
        openModal('modal-kbd');
      }
      if (e.key === '1') setView('schedule');
      if (e.key === '2') setView('team');
      if (e.key === '3') setView('setup');
    });
  }

  /* ----------- 9. Toolbar toggles (visual-only) ------------------------ */

  function wireToolbar() {
    // Segmented Grid / Both / Gantt
    $$('.seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        $$('.seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
        const split = $('#schedule-split');
        if (!split) return;
        split.classList.toggle('gantt-hidden', b.dataset.pane === 'grid');
        split.classList.toggle('gantt-only',  b.dataset.pane === 'gantt');
      });
    });
    // Toolbar toggle buttons (toggle is-active on click)
    $$('.toolbar-toggle-btn').forEach((b) => {
      b.addEventListener('click', () => b.classList.toggle('is-active'));
    });

    // Split divider drag
    let dragging = false, startX = 0, startW = 0;
    const div = $('#schedule-divider');
    const grid = $('#schedule-grid');
    div && div.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX; startW = grid.getBoundingClientRect().width;
      div.classList.add('dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(280, Math.min(1100, startW + (e.clientX - startX)));
      grid.style.width = w + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; div.classList.remove('dragging');
    });
  }

  /* ----------- 10. Team view ------------------------------------------- */

  function renderTeam() {
    const grid = $('#team-grid');
    if (!grid) return;
    const colors = {
      Mechanical: ['#dbeafe', '#1e3a8a'],
      Electrical: ['#fee2e2', '#9b1c1c'],
      Controls:   ['#f3e8ff', '#6b21a8'],
      Shop:       ['#fed7aa', '#9a3412']
    };
    grid.innerHTML = Object.entries(SDC.TEAM).map(([disc, members]) => {
      const [fill, text] = colors[disc];
      return `
        <div class="team-card">
          <header class="team-card-head" style="background:${fill};color:${text}">
            <h3>${disc}</h3>
            <span class="team-count">${members.length}</span>
          </header>
          <ul class="team-list">
            ${members.map((m) => `
              <li class="team-member">
                <input type="text" class="team-member-name" value="${m}" readonly />
                <button class="remove-btn" type="button" title="Remove">×</button>
              </li>
            `).join('')}
            <li class="team-member is-placeholder">
              <input type="text" class="team-member-name" value="Open — Senior ${disc} Eng" readonly />
            </li>
          </ul>
          <button class="team-add-btn" type="button">+ Add member</button>
        </div>
      `;
    }).join('');

    renderResources();
  }

  function renderResources() {
    const body = $('#resources-body');
    const discWrap = $('#resources-disciplines');
    if (!body || !discWrap) return;

    discWrap.innerHTML = Object.keys(SDC.TEAM).map((d, i) =>
      `<button class="discipline-tab${i === 0 ? ' active' : ''}" type="button" data-disc="${d}">${d}</button>`
    ).join('');
    $$('.discipline-tab', discWrap).forEach((b) => b.addEventListener('click', () => {
      $$('.discipline-tab', discWrap).forEach((x) => x.classList.toggle('active', x === b));
    }));

    // Populate the project select
    const sel = $('#resources-project');
    if (sel) {
      sel.innerHTML = '<option value="">All projects</option>' +
        projects.map((p) => `<option>${p.num} — ${p.name}</option>`).join('');
    }

    // Lightweight horizontal timeline preview — 16 weeks of stripes + a handful of bars
    const nameCol = 220, weekTick = 50, weeks = 18;
    body.style.setProperty('--name-col-w', nameCol + 'px');
    body.style.setProperty('--tl-width', (weekTick * weeks) + 'px');
    body.style.setProperty('--week-tick', weekTick + 'px');

    const names = SDC.TEAM.Mechanical;
    const samples = [
      // [name, startWeek, lengthWeeks, label, color, alloc]
      ['Riley Tomas',   0, 3, 'Concept · M-2718',    '#dbeafe', 100],
      ['Riley Tomas',   3, 4, 'Detail · M-2718',     '#dbeafe', 80],
      ['Sam Pham',      2, 5, 'Detail · M-2718',     '#dbeafe', 100],
      ['Sam Pham',      7, 3, 'Detail · M-2719',     '#fef3c7', 50],
      ['Devon Carr',    5, 2, 'BOM · M-2718',        '#dbeafe', 100],
      ['Devon Carr',    7, 4, 'BOM · M-2715',        '#cffafe', 75],
      ['Priya Anand',   1, 1, 'Long lead · 2718',    '#fef3c7', 100],
      ['Priya Anand',  10, 2, 'Recv servos · 2718',  '#fef3c7', 100]
    ];

    let rows = '';
    rows += `
      <div class="resources-header">
        <div class="resources-name-cell"><span class="resources-name" style="text-transform:uppercase;font-size:11px;letter-spacing:.05em;color:var(--text-muted)">Mechanical</span></div>
        <div class="resources-axis">${Array.from({length: weeks}, (_, i) => {
          const wd = new Date('2026-01-05'); wd.setDate(wd.getDate() + i * 7);
          return `<div class="resources-tick" style="left:${i * weekTick}px;width:${weekTick}px">W${i+1} · ${fmtShort(wd)}</div>`;
        }).join('')}</div>
      </div>
    `;
    names.forEach((nm) => {
      const myBars = samples.filter((s) => s[0] === nm);
      const isPlaceholder = nm === 'Devon Carr' ? false : false;
      rows += `
        <div class="resources-row${isPlaceholder ? ' is-placeholder' : ''}">
          <div class="resources-name-cell">
            <span class="resources-name">${nm}</span>
            <span class="resources-meta">${myBars.length} active · ${myBars.reduce((s,b)=>s+b[2],0)} wks</span>
          </div>
          <div class="resources-track" style="width:${weekTick*weeks}px">
            ${myBars.map((b) => `
              <div class="res-bar${b[5] < 80 ? ' low-alloc' : ''}" style="left:${b[1]*weekTick}px;width:${b[2]*weekTick-4}px;top:6px;height:22px;background:${b[4]};border-color:rgba(0,0,0,0.12);color:#1e293b">
                <span class="res-bar-priority">${b[5]}%</span>
                <span class="res-bar-label">${b[3]}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    });
    // Add a placeholder row showing the dashed-border treatment
    rows += `
      <div class="resources-row is-placeholder">
        <div class="resources-name-cell">
          <span class="resources-name">Open — Senior Mech Eng</span>
          <span class="resources-meta">Role placeholder · 0 wks</span>
        </div>
        <div class="resources-track" style="width:${weekTick*weeks}px"></div>
      </div>
    `;
    body.innerHTML = rows;

    const legend = $('#resources-legend');
    if (legend) legend.innerHTML = `
      <span class="legend-item"><span class="legend-swatch" style="background:#dbeafe"></span>M-2718</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#fef3c7"></span>M-2719</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#cffafe"></span>M-2715</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#dcfce7;border:1px solid #86efac"></span>100% load</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#fee2e2;border:1px solid #fca5a5"></span>Over-allocated</span>
    `;
  }

  /* ----------- 11. Setup view ------------------------------------------ */

  function renderSetup() {
    // Palette
    const pal = $('#palette-list');
    if (pal) pal.innerHTML = [
      ['SDC Blue',         '#1574c4'],
      ['SDC Yellow',       '#ffde51'],
      ['SDC Navy',         '#061d39'],
      ['SDC Green',        '#74c415'],
      ['SDC Green Light',  '#befa4f'],
      ['SDC Blue Light',   '#aacee8'],
      ['Slate',            '#64748b'],
      ['Danger Red',       '#dc2626']
    ].map(([name, hex]) => `
      <div class="palette-row">
        <span class="swatch" style="background:${hex}"></span>
        <input type="text" value="${name}" />
        <input type="text" class="hex-input" value="${hex.toUpperCase()}" />
        <button class="remove-btn" type="button" title="Remove">×</button>
      </div>
    `).join('');

    // Theme
    const setColor = (id, hex) => {
      const c = $('#' + id); const t = $('#' + id + '-hex');
      if (c) c.value = hex; if (t) t.value = hex.toUpperCase();
    };
    setColor('theme-primary',          '#1574c4');
    setColor('theme-dark',             '#061d39');
    setColor('theme-accent',           '#ffde51');
    setColor('section-design-build',   '#e2e8f0');
    setColor('section-machine-testing','#e2e8f0');
    setColor('section-teardown-install','#e2e8f0');
    setColor('anchor-fill',            '#befa4f');
    setColor('anchor-text',            '#061d39');

    // Hierarchy colors table
    const hier = $('#hierarchy-colors-list');
    if (hier) hier.innerHTML = SDC.HIERARCHY_COLORS.map((h) => `
      <tr>
        <td>${h.label}</td>
        <td><input type="color" value="${h.fill}" /></td>
        <td><input type="color" value="${h.text}" /></td>
        <td class="preview-cell"><span style="display:inline-block;padding:3px 10px;border-radius:4px;background:${h.fill};color:${h.text};font-weight:700;font-size:11px">${h.label.replace(/^—\s*/, '')}</span></td>
      </tr>
    `).join('');

    // Phases
    const ph = $('#phases-list');
    if (ph) ph.innerHTML = SDC.PHASES.map((p) => `
      <tr>
        <td class="col-drag">≡</td>
        <td><input type="text" value="${p.label}" /></td>
        <td><input type="text" class="key-input" value="${p.key}" /></td>
        <td><input type="color" value="${p.bg}" /></td>
        <td><input type="color" value="${p.text}" /></td>
        <td class="preview-cell"><span class="phase-chip" style="background:${p.bg};color:${p.text}">${p.label}</span></td>
        <td><button class="remove-btn" type="button">×</button></td>
      </tr>
    `).join('');

    // Default financials
    const fin = $('#default-financials-list');
    if (fin) fin.innerHTML = SDC.FINANCIAL_DEFAULTS.map((f) => `
      <tr>
        <td><input type="text" value="${f.name}" /></td>
        <td class="num"><input type="text" value="${f.pct}%" style="text-align:right;width:60px" /></td>
        <td><select><option>${f.syncTo}</option><option>—</option><option>Receipt of PO</option><option>FAT</option><option>Ship Machine</option></select></td>
        <td><button class="remove-btn" type="button">×</button></td>
      </tr>
    `).join('');

    // Milestone library
    const ms = $('#milestone-library-list');
    if (ms) ms.innerHTML = SDC.MILESTONE_LIBRARY.map((m) => `
      <tr>
        <td><input type="text" value="${m.name}" /></td>
        <td><input type="text" value="${m.section}" /></td>
        <td><input type="text" value="${m.dept}" /></td>
        <td><button class="remove-btn" type="button">×</button></td>
      </tr>
    `).join('');

    // Arrow demos — simple SVG cards
    const bar = $('#arrow-demo-bar-grid');
    if (bar) bar.innerHTML = ['FS','SS','FF','SF'].map((t) => `
      <div class="arrow-demo-card">
        <div class="arrow-demo-title">${t} — ${({FS:'Finish-to-Start',SS:'Start-to-Start',FF:'Finish-to-Finish',SF:'Start-to-Finish'})[t]}</div>
        <svg class="arrow-demo-svg" viewBox="0 0 240 96" preserveAspectRatio="none">
          <line class="demo-row-guide" x1="0" y1="32" x2="240" y2="32" />
          <line class="demo-row-guide" x1="0" y1="64" x2="240" y2="64" />
          <rect class="demo-bar"   x="20"  y="22" width="80" height="18" rx="3"/>
          <rect class="demo-bar b" x="140" y="54" width="80" height="18" rx="3"/>
          <text class="demo-bar-label" x="28" y="33">A</text>
          <text class="demo-bar-label" x="148" y="65">B</text>
          <path class="demo-arrow-line" d="M100 31 L 120 31 L 120 63 L 138 63" stroke="#334155" stroke-width="1.4" />
          <path d="m138 63-5-3 0 6z" fill="#334155"/>
        </svg>
        <div class="arrow-demo-syntax">Predecessor: <code>${t}</code></div>
      </div>
    `).join('');

    const ms2 = $('#arrow-demo-ms-grid');
    if (ms2) ms2.innerHTML = ['Bar → Milestone','Milestone → Bar','Milestone → Milestone'].map((t, i) => `
      <div class="arrow-demo-card">
        <div class="arrow-demo-title">${t}</div>
        <svg class="arrow-demo-svg" viewBox="0 0 240 96" preserveAspectRatio="none">
          <line class="demo-row-guide" x1="0" y1="32" x2="240" y2="32" />
          <line class="demo-row-guide" x1="0" y1="64" x2="240" y2="64" />
          ${i === 0
            ? `<rect class="demo-bar" x="20" y="22" width="80" height="18" rx="3"/>
               <text class="demo-bar-label" x="28" y="33">A</text>
               <polygon class="demo-diamond" points="160,55 168,63 160,71 152,63"/>
               <rect class="demo-pill" x="172" y="55" width="56" height="16" rx="3"/>
               <text class="demo-bar-label" x="178" y="65">Power-Up</text>
               <path class="demo-arrow-line" d="M100 31 L 130 31 L 130 63 L 152 63" stroke="#334155" stroke-width="1.4" />
               <path d="m152 63-5-3 0 6z" fill="#334155"/>`
            : i === 1
            ? `<polygon class="demo-diamond" points="40,31 48,39 40,47 32,39"/>
               <rect class="demo-pill" x="52" y="31" width="60" height="16" rx="3"/>
               <text class="demo-bar-label" x="58" y="41">Long Lead</text>
               <rect class="demo-bar b" x="140" y="54" width="80" height="18" rx="3"/>
               <text class="demo-bar-label" x="148" y="65">B</text>
               <path class="demo-arrow-line" d="M48 39 L 120 39 L 120 63 L 138 63" stroke="#334155" stroke-width="1.4" />
               <path d="m138 63-5-3 0 6z" fill="#334155"/>`
            : `<polygon class="demo-diamond" points="40,31 48,39 40,47 32,39"/>
               <text class="demo-bar-label" x="52" y="40">PO</text>
               <polygon class="demo-diamond" points="180,63 188,71 180,79 172,71"/>
               <text class="demo-bar-label" x="120" y="56" fill="#64748b" style="font-size:10px">+ 14d</text>
               <path class="demo-arrow-line" d="M48 39 L 120 39 L 120 71 L 168 71" stroke="#334155" stroke-width="1.4" />
               <path d="m168 71-5-3 0 6z" fill="#334155"/>`
          }
        </svg>
        <div class="arrow-demo-syntax">Routing: <code>orthogonal</code></div>
      </div>
    `).join('');
  }

  /* ----------- 12. Cross-panel row hover highlight --------------------- */

  function wireRowHoverHighlight() {
    const tbody = $('#tasks-tbody');
    if (!tbody) return;
    tbody.addEventListener('mouseover', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const idx = Array.from(tbody.children).indexOf(tr);
      $$('.mock-gantt-row', $('#gantt-container')).forEach((r, i) => {
        r.style.background = i === idx ? 'var(--row-hover)' : '';
      });
    });
    tbody.addEventListener('mouseleave', () => {
      $$('.mock-gantt-row', $('#gantt-container')).forEach((r) => (r.style.background = ''));
    });
  }

  /* ----------- 13. Boot ------------------------------------------------ */

  function boot() {
    setView('schedule');
    document.body.dataset.view = 'schedule';
    renderProjectTabs();
    renderColGroupAndHead();
    renderScheduleHeader();
    renderTable();
    renderGantt();
    renderFilters();
    renderRevisions();
    renderTeam();
    renderSetup();
    wireTopbar();
    wireToolbar();
    wireModals();
    wireRowHoverHighlight();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
