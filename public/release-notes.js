// SDC Project Scheduler — release notes.
// Newest entry first. Each entry: { version, date (YYYY-MM-DD), notes: string[] }.
// The topbar revision pill reads the FIRST entry's version + date and shows the full
// array in the click popup. Edit this file directly when bumping the rev.
window.RELEASE_NOTES = [
  {
    version: '1.9.7',
    date: '2026-05-11',
    notes: [
      'Financial overlay labels were STILL overlapping the date row because frappe-gantt\'s .upper-header / .lower-header are <g> groups, not <rect>s, so getAttribute("height") returned null and the fallback (38px) was way short of the real rendered header (~55px+ depending on zoom). Fixed by anchoring yTop to the topmost task bar\'s Y position — bars always start below the entire header, so this is robust to zoom/header-style changes.',
    ],
  },
  {
    version: '1.9.6',
    date: '2026-05-11',
    notes: [
      'Financial overlay labels were sitting on top of the date numbers because the header height calc only counted the upper "Month" header row. Bumped lane spacing too. (Iterated again in 1.9.7.)',
    ],
  },
  {
    version: '1.9.5',
    date: '2026-05-11',
    notes: [
      'Back to full-height financial overlay lines (top of chart to bottom of last task row). The "shorter lines anchored to trigger task" experiments didn\'t feel right.',
      'Lines are bolder: 1.6px dashed (pending) / 2.2px solid (sent), opacity 0.8 / 1.0. Reads cleanly over busy bars without overwhelming them.',
      'Labels now have a real white pill backdrop with a thin green border so they\'re readable wherever they land — including over task names like "Receipt of PO".',
      'When milestone dates are close together, labels stack vertically into 14px-tall lanes so they never sit on top of each other.',
    ],
  },
  {
    version: '1.9.4',
    date: '2026-05-11',
    notes: [
      'Financial overlay lines now extend ~70px above and ~30px below the strict overlapping range. The top extension lands the line in empty whitespace (no bars there at the milestone\'s X), giving the label a clean spot to sit without overlapping any task bar.',
      'Label is now anchored ~12px inside the top of the extended line — sits clearly in the open space, easy to read.',
    ],
  },
  {
    version: '1.9.3',
    date: '2026-05-11',
    notes: [
      'Financial overlay lines now span the Y range of every task that\'s actively in-flight at that milestone\'s date — so the line cuts through exactly the rows it crosses, no more no less.',
      'Label sits at the top of each line (just above the topmost overlapping task bar). Different milestones hit different sets of tasks → labels land at different vertical positions → no more crammed-together labels.',
      'Untriggered milestones (no date-overlapping tasks) fall back to a short tick at the date axis.',
    ],
  },
  {
    version: '1.9.2',
    date: '2026-05-11',
    notes: [
      'Financial overlay lines now STOP at their trigger task\'s row instead of running the full chart height. (Iterated again in 1.9.3.)',
    ],
  },
  {
    version: '1.9.1',
    date: '2026-05-11',
    notes: [
      'Financial overlay refined to look less aggressive: lines are thinner and lower-opacity (read as reference markers, not barriers). Hover the line and it pops to full opacity.',
      'Dropped the heavy green pill behind each label — labels are now plain green text with a thin white halo so they stay legible over busy task bars.',
      'When milestone dates are close together, labels stack vertically into lanes so they don\'t overlap each other.',
    ],
  },
  {
    version: '1.9',
    date: '2026-05-11',
    notes: [
      'Financial milestones now render on the Gantt as VERTICAL LINES through the chart at each derived date — much easier to see which tasks line up with which payment event than the old $ diamonds in the corner.',
      'Line is DASHED when the invoice hasn\'t been sent yet, and goes SOLID once you check the "Sent" box in the Financials modal.',
      'Each line carries a small green pill label at the top with the milestone name + percent (e.g. "Down Payment 30%").',
      '"Paid" column renamed to "Sent" — this app cares about invoice events, not the actual payment (that\'s accounting\'s job).',
    ],
  },
  {
    version: '1.8.1',
    date: '2026-05-11',
    notes: [
      '"Show on Gantt" checkbox added to the Financial milestones modal head. Toggling it overlays the milestones on the Gantt as green $ diamonds (same flag as the toolbar $ Financial button — just discoverable from inside the modal too).',
    ],
  },
  {
    version: '1.8',
    date: '2026-05-11',
    notes: [
      'Financial milestones are now event-triggered instead of being fixed dates. New "Trigger" column accepts predecessor syntax — anchor name aliases (PO / Power-Up / FAT / Ship) or task line numbers, with optional lag like "+1w" or "-3d". Example: "FAT +1w" = one week after FAT.',
      'When a Trigger is set, the Date column shows the auto-derived date (read-only). Clear the Trigger to enter a fixed date manually.',
      'Standard seeded milestones now come pre-wired: Down Payment → PO, Acceptance at SDC → FAT, Acceptance at Customer → Ship. Edit FAT in the schedule and the SDC acceptance date follows automatically.',
      'Gantt overlay now uses the derived trigger date too, so the $ diamonds reposition live when you edit the anchors / triggering tasks.',
      'Migration on server startup converts legacy sync_to_anchor values to the new predecessor format (idempotent).',
    ],
  },
  {
    version: '1.7.2',
    date: '2026-05-11',
    notes: [
      'Financials modal slimmed down: Name / Due date / % / Paid / (delete). Dropped the Project value field, the totals row, the Amount ($) column, and the Sync to column — only the four columns you actually edit remain.',
      'Bug fix: default_financial_milestones setting had been overwritten with an empty array (from an early Setup save before the defaults were seeded). Added an idempotent migration on server startup that restores it (and project_milestone_library) to its standard defaults if empty.',
      'Each project now correctly seeds its four standard financial milestones (Down Payment 30% / Major Commercials 40% / Acceptance at SDC FAT 20% / Acceptance at Customer SAT 10%) on first open of the modal.',
      'Acceptance at SDC FAT date still auto-syncs to the FAT anchor under the hood — that wiring lives in the data layer, no longer exposed in the modal UI.',
    ],
  },
  {
    version: '1.7.1',
    date: '2026-05-11',
    notes: [
      'Reverted financials editor back to a centered modal popup (the inline panel didn\'t feel right).',
      '$ Financials header button now matches the other toolbar buttons — plain white with a thin border, no more lime green.',
      '+ Add milestone no longer uses a native browser prompt (that ugly little dialog at the top of the window). Instead it drops an empty row at the bottom of the table and focuses the Name cell so you can type immediately.',
    ],
  },
  {
    version: '1.7',
    date: '2026-05-11',
    notes: [
      'Financials editor moved out of the modal popup and into an inline panel that slides down between the schedule header and the task grid. (Reverted in 1.7.1.)',
    ],
  },
  {
    version: '1.6',
    date: '2026-05-11',
    notes: [
      'Filters reworked: popover is now a row of quick-chip toggles — Behind schedule / Ahead of schedule / Milestones only / Assigned (real work) / Over-allocated. One click per chip; click again to turn off. Anchors (PO / Power-Up / FAT / Ship) are always exempt so the spine stays visible.',
      '"Behind" / "Ahead" use the same business-day math as the ±Nd chips on the Gantt — they\'re in sync.',
      '"$ Financials" button moved from the project tab to the schedule header (next to the project name + task count) so it\'s easier to spot. Click opens the per-project Financial Milestones editor. Right-click → Financial milestones… on the project tab still works as a backup.',
      'Financials modal now shows synchronous content immediately. If the API isn\'t reachable (e.g. the server hasn\'t been restarted with the new financials routes), the modal shows a clear "restart the server" message instead of a confusing dark backdrop with nothing in it.',
      'Row-height control compacted: just `−` `rows` `+` — no percentage label, smaller buttons. Frees up ~40px of toolbar space.',
      'Filters popover reparented to <body> so it paints above the project-tab bar (same stacking-context fix that was applied to the revision popover earlier).',
    ],
  },
  {
    version: '1.5',
    date: '2026-05-11',
    notes: [
      'Cross-panel row highlight — hovering a row in the grid now lights up the matching row across the Gantt with a continuous stripe. Makes it easy to spot which bar corresponds to which task without squinting at row alignment. Stripe disappears when the mouse leaves the grid.',
    ],
  },
  {
    version: '1.4',
    date: '2026-05-11',
    notes: [
      'Row height control moved from Setup to the schedule toolbar — sits next to the date zoom as a − / rows / + segmented control. Plus = taller rows (more breathing room), minus = shorter rows (more on screen). Each click changes by 2px. Persists per-browser.',
      'Row-height minimum lowered from 22px to 14px — tight, but lets you cram a 60-row schedule into one viewport when scanning.',
      'The bottom drag handle still works for fine-grained adjustment; the toolbar control and the drag handle stay in sync.',
      'Setup → Display card removed (it only held the row-height slider, which is now in the toolbar).',
    ],
  },
  {
    version: '1.3',
    date: '2026-05-11',
    notes: [
      'Anchor rows now have a heavy top/bottom border + slight background tint so they pop off the rows above and below. Fixes the "FAT looks like a SHOP task" confusion — the visual break makes it obvious FAT is a section-level gate, not another dept row.',
      'The colored name chip on anchor rows is slightly larger with a subtle drop shadow.',
      'Gantt + grid now have 50vh of overscroll at the bottom — you can drag/scroll PAST the last row to bring the bottom rows to the middle of the viewport instead of having them pinned to the very bottom. Same applies to vertical drag in either panel.',
    ],
  },
  {
    version: '1.2.1',
    date: '2026-05-11',
    notes: [
      'Fixed Receipt of PO double-rendering: stale phase_group=teardown_install on the PO anchor (left over from an earlier section-50 split migration) was causing it to appear both on the spine AND inside the teardown bucket. Bucket walk now matches anchors explicitly by anchor_key — only Machine Power-Up is admitted, regardless of stored phase_group. DB migration on next server restart clears the stale fields on PO / FAT / Ship Machine.',
    ],
  },
  {
    version: '1.2',
    date: '2026-05-11',
    notes: [
      'Machine Power-Up relocated from the top of section 40 to section 10 → Shop → Wire — it\'s the END of the wire team\'s work (the moment the panel turns on), not the start of testing. Still rendered with anchor styling (concentric diamond, name chip in the grid) so it reads as a key date.',
      'Existing Machine Power-Up rows are auto-migrated to the new placement on server restart.',
      'Per-project $ icon on every project tab — click it to open the Financial Milestones editor for that project. Replaces the harder-to-find "right-click → Financial milestones…" path (the right-click option still works as a backup).',
    ],
  },
  {
    version: '1.1',
    date: '2026-05-11',
    notes: [
      'Anchor milestones expanded from 3 to 4: Receipt of PO → Machine Power-Up → FAT → Ship Machine. Machine Power-Up auto-creates for every project and opens section 40.',
      'Default anchor color changed to SDC lime (#BEFA4F) with dark slate text — replaces the bolder green. Still configurable in Setup → Anchor Color.',
      'Non-anchor milestones (Mech Release, Design Review, First Part Full Auto, etc.) render as a solid slate diamond on the Gantt — clearly secondary to the lime concentric anchors.',
      'Financial milestones: per-project payment events (Down Payment 30% / Major Commercials 40% / Acceptance at SDC FAT 20% / Acceptance at Customer SAT 10%). Defaults auto-seed on first use, then fully editable per project.',
      'Right-click any project tab → "Financial milestones…" opens an editable table per project: name / due date / % / amount / sync-to-anchor / paid.',
      '$ Financial toolbar toggle overlays the financial milestones on the Gantt as green $ diamonds along the top band — diamond fills when paid.',
      'FAT-synced financial milestones (e.g. Acceptance at SDC) auto-mirror the FAT anchor\'s date — edit FAT in the grid and the financial marker follows.',
      'Setup → Standard Financial Milestones — edit the default name/percent/anchor-sync list that gets applied to new projects.',
      'Setup → Standard Project Milestones — library of common in-flow milestones (Mech Release 1/2, Design Review, Order Long Lead, Order Commercial Parts, First Part Full Auto).',
    ],
  },
  {
    version: '1.0',
    date: '2026-05-10',
    notes: [
      'Initial revision baseline.',
      'Schedule grid + Gantt with hierarchical sections (10 Design & Build, 40 Machine Testing, 50 Teardown & Install) and configurable section/department colors.',
      'Three hard-coded anchor milestones per project: Receipt of PO, FAT, Ship Machine — concentric red diamonds, configurable color.',
      'Business-day scheduling (Mon–Fri). Duration is the source of truth; end dates derive automatically. Default allocation 90%.',
      'Critical path mode with a linked "Only" sub-toggle to filter the view to just the project-driving chain.',
      'Ahead/behind chips on Gantt bars: green +Nd / red −Nd vs expected progress at today\'s date.',
      'Resources view per-discipline. Placeholder team members (anything named "X Placeholder") get role-stand-in treatment — no over-allocation warnings, no load strip, no priority pills; bars carry through duplicates so new projects start pre-staffed by role.',
      'Click any resource bar (placeholder OR real person) → menu to reassign across the team or jump to the task on the schedule.',
      'Priority pill on overlapping tasks is click-to-cycle (1 → 2 → … → N → 1). Priorities are per-person.',
      'Pane segmented control: Grid / Both / Gantt — auto-fits the Gantt when switching to a Gantt-visible mode.',
      'Project tabs with right-click menu: rename, duplicate, merge, mark as template (★, can\'t be closed), delete.',
      'Filters consolidated into a single topbar dropdown.',
      'Bar labels stay inside bars (binary-search-truncated with hover tooltip). Milestone labels are plain text to the right of the diamond, no pills.',
      'Arrow routing: at most two segments, no U-routes, arrows render behind bars via z-order.',
    ],
  },
];
