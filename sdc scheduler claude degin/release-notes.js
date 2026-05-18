/* ----------------------------------------------------------------------
 *  release-notes.js
 *  Release notes shown in the revision popover (topbar "Rev N" pill).
 * ---------------------------------------------------------------------- */

window.SDC = window.SDC || {};

window.SDC.RELEASE_NOTES = [
  {
    version: 'v2.4.0',
    date: 'May 12, 2026',
    notes: [
      'New: layered topbar / project-tab bar visual hierarchy.',
      'New: thin auto-hide scrollbars on the schedule grid + Gantt.',
      'Polished: setup cards now have icon accents and elevated shadows.',
      'Polished: modals fade + scale in, backdrop is blurred for focus.',
      'Fixed: login page logo no longer requires the SVG asset.'
    ]
  },
  {
    version: 'v2.3.4',
    date: 'April 28, 2026',
    notes: [
      'Section / department / sub-department rows now read at three distinct weights.',
      'Subtle zebra striping on task rows for easier scanning.',
      '+ Add task and Zoom-to-fit reconciled as the same primary pill.'
    ]
  },
  {
    version: 'v2.3.3',
    date: 'April 14, 2026',
    notes: [
      'Schedule toolbar regrouped: layout / view toggles / baseline / column / zoom / export.',
      'Consistent 30px button height across the toolbar.',
      'Keyboard focus rings now visible on every interactive element.'
    ]
  },
  {
    version: 'v2.3.2',
    date: 'March 30, 2026',
    notes: [
      'Resources view: over-allocated bars get a red outline and warning glyph.',
      'Critical-path arrows snap to red even when frappe-gantt re-renders.',
      'Financials modal totals now turn green only when the sum is exactly 100%.'
    ]
  },
  {
    version: 'v2.3.1',
    date: 'March 16, 2026',
    notes: [
      'Anchor rows (PO / Power-Up / FAT / Ship) get heavier top + bottom borders.',
      'Baseline ghost paints behind each task in the task\u2019s own phase color.',
      'Smartsheet sync now preserves the local baseline snapshot.'
    ]
  }
];
