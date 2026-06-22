# SDC Scheduler — Session Changes (2026-06-22)

## Overview

This document covers two sessions of work on the SDC Scheduler app on 2026-06-22.  
**Session 1** was a full overhaul of the Vendor PO Track page.  
**Session 2** was a full overhaul of the Projects page (UI/UX, search, state persistence).

---

# SESSION 1 — Vendor PO Track Overhaul

## Files Modified

| File | What changed |
|---|---|
| `public/app.js` | VPO helper functions + full `renderVendorPOsPage()` rewrite |
| `public/styles.css` | 8 visual improvement rules + ~15 new functional CSS rules |

---

## 1. Visual / UX Improvements (8 total)

### 1.1 Status Dot → Pill Badge
- Replaced plain colored circle with a compact rectangular pill (`vpo-dot`)
- Each status has its own color class: `vpo-dot-open`, `vpo-dot-late`, `vpo-dot-soon`, `vpo-dot-shipped`, `vpo-dot-partial`, `vpo-dot-complete`
- Icon inside the pill: ✓ complete · ! late · ▲ due soon · ↑ shipped · ~ partial

### 1.2 Sticky Toolbar
- Toolbar + legend wrapped in `<div class="vpo-sticky-controls">`
- Sticks to top of viewport (`position: sticky; top: 0; z-index: 15`) while scrolling through PO rows

### 1.3 Condensed Toolbar
- Reduced gap between toolbar elements (`gap: 7px`)
- Selects and search input use smaller padding/font so more controls fit on one line

### 1.4 Refined Head Stat Bar
- `.vpo-headstat` gets a card treatment (white bg, border, subtle shadow, border-radius 10px)
- Label text is muted/semibold uppercase
- Added **Open PO Value** tile (see §2.7)

### 1.5 Row Hover / Rhythm
- List rows get `background: #f8fafc` on hover
- Consistent `padding: 6px 10px; min-height: 36px` on all list rows
- Late rows: 3px navy left-border accent
- Due-soon rows: 3px amber left-border accent
- Complete rows: 72% opacity

### 1.6 Dashboard Card Refinement
- `.vpo-dash-main .sp-dcard-head`: lighter muted text, blue left-border accent, uppercase tracking
- `.vpo-dash-main .sp-dcard`: subtle `#fafbfc` background

### 1.7 Lighter ETO Pill
- `.vpo-eto-pill`: transparent background, slate border (`#cbd5e1`), 9px text — unobtrusive

### 1.8 Compact Legend Chips
- `.vpo-legend`: tighter gap (`4px`)
- `.vpo-leg`: pill with border + border-radius 20px, small color swatch inside

---

## 2. Functional Improvements (20 total)

### 2.1 Module-Level Guards & Constants
```js
let _vpoChangeBound = false;   // prevents duplicate change listeners
let _vpoChangeRoot = null;     // detects root element recreation
let _vpoSearchT = 0;           // debounce timer handle
const VPO_PAGE_SIZE = 100;     // rows per page
```

### 2.2 Extended State Defaults
`_vpoStateGet()` now initializes with:
```js
{ ..., page: 0, etaRange: 'all', sortKey: 'eta', sortDir: 'asc' }
```

### 2.3 Tracking Link Auto-Detection (`_vpoTrackingLink`)
New helper that turns raw tracking numbers into clickable links:
- UPS: `1Z` prefix + 16 alphanumeric chars → ups.com
- FedEx: 12 or 15 digits → fedex.com
- USPS: 20–22 digits → usps.com
- Falls back to plain text if no pattern matches

### 2.4 Enhanced Filtering & Sorting (`_vpoRows`)
- **ETA range filter**: `etaRange` state key filters to POs due within 7/14/30 days
- **Extended search**: now searches `po_price` field in addition to po/job/vendor/pm/tracking/comments
- **Multi-column sort** via `st.sortKey` + `st.sortDir`: supports `eta`, `job`, `vendor`, `pm`, `price`
- Completed POs always sort to bottom regardless of sort key

### 2.5 Save Feedback on Detail Inputs (`_vpoSetField`)
4th parameter `inputEl` added:
- Border turns **amber** while saving (`sp-saving`)
- Border turns **green** on success (`sp-saved`, clears after 1.5s)
- Border turns **red** on error (`sp-save-err`, clears after 2s)

### 2.6 Pagination
- 100 POs per page (`VPO_PAGE_SIZE`)
- Prev / Next buttons + "Page X of Y (N POs)" info bar
- Page resets to 0 on any filter, sort, or search change

### 2.7 Open PO Value Tile
- Sums `po_price` across all open POs
- Displayed in headStat bar as large bold number (e.g. `$7,008,549`)

### 2.8 Bulk Actions
- Checkbox in column 1 of every list row
- "Select all" checkbox in header
- Bulk bar appears when ≥1 row is checked: **Mark Complete**, **Delete**, **Clear**
- Bulk delete shows confirmation dialog

### 2.9 Column Sorting (Click Headers)
- Sortable columns: Job, Vendor, ETA, PM, Price
- Click once → sort ascending (▲); click again → descending (▼)
- Active sort column highlighted in header

### 2.10 Click-to-Filter Cells
- Job, Vendor, PM cells in list rows are clickable
- Clicking applies that value as a filter instantly (no dropdown needed)
- Styled with `cursor: pointer; hover underline`

### 2.11 Dashboard Vendor Click-to-Filter
- Clicking a vendor row in the "Open by vendor" dashboard card:
  - Sets `fVendor` filter to that vendor
  - Switches to the **Open** tab
  - Jumps directly to the list

### 2.12 ETA Range Quick Filter
- New dropdown in toolbar: **ETA: any / ≤ 1 week / ≤ 2 weeks / ≤ 30 days**
- Filters to POs whose calculated ETA falls within the selected window

### 2.13 "Due Soon" Quick Button
- Added to the filter segment control next to Open / Complete / All
- Toggles `fStatus = 'soon'` (POs due within 7 days) / back to `all`

### 2.14 CSV Export
- ⬇ CSV button in toolbar
- Exports all currently **filtered** POs (not just the current page)
- Columns: PO#, Job, Vendor, ETA, Ship Date, Tracking, PM, Price, Status, Partial, Complete

### 2.15 PM Column (List View)
- Column 9 in the 12-column list grid
- Shows PM name; clickable to filter by PM

### 2.16 Price / Completed-On Column (List View)
- Column 10 in the 12-column list grid
- Open POs: shows `po_price`
- Completed POs: shows `completed_on` date

### 2.17 Add Form — New Fields
Three new fields added to the quick-add form:
- **ETA** (date)
- **Tracking** (text)
- **PO Price** (text)

### 2.18 Lazy Detail Field Rendering
- Detail panel renders an empty `sp-fields-lazy` placeholder
- Fields are only filled when the row is first expanded
- Avoids rendering 1,300+ inputs upfront for 100 rows per page

### 2.19 Scroll Into View on Expand
- When a PO row is expanded, the detail panel smoothly scrolls into view

### 2.20 Debounced Search
- Search input uses a 300ms debounce (module-level `_vpoSearchT`)
- Cursor position restored after re-render

---

## 3. Bug Fixes (Session 1)

| Bug | Fix |
|---|---|
| Change listener duplicated on every re-render | Module-level `_vpoChangeBound` + `_vpoChangeRoot` reference check |
| Search debounce timer carried stale reference across re-renders | Module-level `_vpoSearchT` instead of local variable |
| Tracking column (`1fr`) created giant blank gap when empty | Changed to fixed `160px`; Vendor column gets `minmax(80px,1fr)` |
| Dashboard vendor click didn't switch to Open tab | Added `st.filter = 'open'` in dashboard click handler |

---

## 4. CSS Grid — List View Column Layout

**Before:**
```
20px 22px 72px 88px 86px 78px 72px minmax(0,1fr) 76px 76px 32px 32px
```

**After:**
```
20px 22px 80px 72px minmax(80px,1fr) 78px 72px 160px 76px 100px 32px 32px
```

| Col | Width | Content |
|---|---|---|
| 1 | 20px | Bulk checkbox |
| 2 | 22px | Status pill |
| 3 | 80px | PO # |
| 4 | 72px | Job |
| 5 | minmax(80px,1fr) | Vendor *(grows to fill space)* |
| 6 | 78px | ETA |
| 7 | 72px | Ship date |
| 8 | 160px | Tracking *(was 1fr — caused huge blank gap)* |
| 9 | 76px | PM |
| 10 | 100px | Price / Completed-on |
| 11 | 32px | Partial checkbox |
| 12 | 32px | Done checkbox |

---

## 5. Pending / Not Implemented (Session 1)

These two improvements were intentionally deferred — they require a **database schema change** (`vendor_pos` table):

| # | Feature | Reason deferred |
|---|---|---|
| 17 | Explicit "Shipped" checkbox | Needs new `shipped` column in DB |
| 18 | On-hold / Cancelled status | Needs new `status` column + server migration |

---

---

# SESSION 2 — Projects Page Overhaul + VPO Dashboard + Bug Fixes

## Files Modified

| File | What changed |
|---|---|
| `public/app.js` | Projects page rewrite, VPO dashboard cards, column resize, state persistence |
| `public/styles.css` | Projects page styles, VPO dashboard card styles, resize handle styles |

---

## 1. VPO Dashboard Cards (5 cards)

### 1.1 Uniform Card Height
- All 5 dashboard cards made equal height using CSS flex (`display: flex; flex-direction: column`)
- `.vpo-dash-main { grid-template-columns: repeat(5, minmax(0, 1fr)); align-items: stretch; }`
- List containers fixed to `height: 220px; overflow-y: auto` (~10 rows, then scroll)

### 1.2 PO# Clickable Links
- PO numbers in all 4 dashboard card types (In Transit, Late POs, Completed, Longest Outstanding) are now clickable
- Click sets search to that PO#, switches to `filter='all'`, scrolls to and highlights the row
- Highlight: yellow flash animation (`vpo-highlight-flash`) + 2px accent outline for 1.8s

### 1.3 Clear Search Button
- `✕ Clear` button appears in toolbar when a search/filter is active
- Resets search and filter back to default state

### 1.4 Excel-Style Column Resize (Drag Handles)
- Drag handles (`vpo-rhandle`) on each list column header
- Dragging resizes that column in real-time via dynamic `<style id="vpo-col-style">` injection
- Widths persist to `localStorage` key `vpoColWidths`
- Double-click any handle to reset that column to its default width
- Vendor column uses `minmax(Npx, 1fr)` so it absorbs remaining space — total width never exceeds container

---

## 2. Projects Page — Visual / UX Overhaul

### 2.1 Search Bar
- Text filter input at top of page, filters all workspace rows in real-time client-side
- Search state (`state._projectsSearch`) clears when navigating away from the Projects page
- Cursor positioned at end after each keystroke to prevent character-reversal bug (fixed: `setSelectionRange`)

### 2.2 Stats Row
- Replaced plain subtitle with a scannable stats row: **N total · N open · N sales**
- Open count only shown if > 0

### 2.3 Color-Coded Workspace Sections
- Each workspace gets a 4px colored left border via CSS `--ws-accent` variable:
  - **Active** → blue `#1574c4`
  - **Sales** → amber `#d97706`
  - **Closed** → gray `#94a3b8`

### 2.4 Colored Count Pills
- Workspace row count pill color matches the workspace accent:
  - Active → blue bg `#dbeafe`, text `#1d4ed8`
  - Sales → amber bg `#fef9c3`, text `#92400e`
  - Closed → gray bg `#f1f5f9`, text `#64748b`

### 2.5 Green Status Dot (Replaces "open" Badge)
- Old: blue outlined text badge reading "open" — easy to miss
- New: small dot (`.projects-row-dot`) on the left of each row
  - Gray dot = not open
  - Green dot + green glow ring = currently open in a tab

### 2.6 Secondary Metadata Line
- Each project row now shows a second line of info in muted text
- Job number extracted from project name prefix (e.g. `1104` → `Job #1104`)
- Last-opened label shown if project is in `state.recentProjects` (e.g. `opened recently`)
- Both combined: `Job #1104 · opened recently`

### 2.7 Gold Favorited Star
- Fixed: favorited star was `#AACEE8` (light blue, hard to see)
- Now: `#f59e0b` (gold/amber) — clearly distinguishable

---

## 3. Bug Fixes (Session 2)

| Bug | Fix |
|---|---|
| VPO column resize handles not visible | Added `rh(i)` handle HTML inside `sHdr()` 3rd param — embedded inside span, not as sibling grid item |
| Column content overflowing container when dragging | Vendor col uses `minmax(Npx,1fr)` to absorb remaining space |
| Header text overlap with resize handle (`TRACKING\|M`) | Handle at `right: 0`; header cells get `overflow: hidden; padding-right: 8px; text-overflow: ellipsis` |
| Projects page blank on hard refresh | `renderProjectsPage()` now merges `Object.keys(state.projectsIndex)` + `uniqueValues('project')`; re-called after `/api/projects` fetch |
| Projects page not scrollable | Added `#view-projects.active { overflow-y: auto }` |
| Projects search input reverses characters when typing fast | Added `setSelectionRange(len, len)` after `focus()` on each re-render |
| Projects page workspaces collapsed after refresh | Root cause: `renderProjectsPage()` ran before `loadProjectTabs()` set `_projectsExpanded`; fixed by re-rendering projects page inside `if (!state._tabsHydrated)` block after `loadProjectTabs()` |
| `sdcProjectsExpanded = {}` in localStorage overrode Active default | Changed to merge pattern: `{ Active: true, ...saved }` so Active is open unless user explicitly closed it |

---

## 4. State Persistence — Scroll Position (New, Across App)

Added `_setupScrollPersist()` called once on init. Attaches passive scroll listeners to 5 views:
- `projects`, `favorites`, `recents`, `vendor-pos`, `shop-parts`

On scroll: saves `scrollTop` to `localStorage` key `sdcScroll_{view}` (300ms debounce).  
On `setView()`: calls `_restoreScrollPos(view)` via `requestAnimationFrame` after render — restores exact position.  
Also: `_saveScrollPos(state.view)` called at the START of every `setView()` to capture position before leaving.

---

---

---

# SESSION 3 — Performance Fixes + Tab Behavior

## Files Modified

| File | What changed |
|---|---|
| `public/app.js` | `computeCriticalPath()` memoization, `applyFilters()` dedup, Gantt drawer deferral, tab clean-start |

---

## 1. Performance Fixes

### 1.1 `computeCriticalPath()` Memoized
- Added `_criticalPathCache` + `_criticalPathCacheKey` module-level vars
- Cache key: `project|taskCount|maxTaskId` — auto-invalidates when tasks are added/removed/saved
- Eliminates 2–3× O(n×m) predecessor graph walk per render pass (was called by `renderTable` + `renderGantt` on every tab switch)

### 1.2 `applyFilters()` Deduplicated in `renderGantt()`
- Was called twice in the non-`sortByStart` branch: once for `ordered`, once for `visibleIds`
- Single `const _ganttFiltered = applyFilters(state.tasks)` at top; both branches reuse it

### 1.3 Gantt Drawer Chain Deferred to `requestAnimationFrame`
- 13 drawer functions moved inside `requestAnimationFrame(() => { ... })`:
  `drawCustomArrows`, `drawBaselineGhosts`, `drawTodayLine`, `drawMilestoneDiamonds`, `drawMilestoneLabels`, `clipBarLabels`, `drawScheduleStatus`, `drawDoneHashOverlay`, `drawWeekdayLetters`, `drawFinancialOverlay`, `drawPenaltyClauseLine`, `drawBarMeta`, `drawMachineBorders`, `renderProjectStatsPopup`
- Base chart is now visible immediately on tab switch; decorations layer in one frame later (~16ms)
- Each drawer wrapped in `try/catch` per CLAUDE.md defensive render chain rule

---

## 2. Tab Behavior Change

### No Auto-Restored Project Tabs on Load
- `loadProjectTabs()` now always starts clean: `state.openProjects = ['']`, `state.filters.project = ''`
- Previously restored whichever tabs were open at last session from `sdcOpenProjects` localStorage
- Users now explicitly open projects they want from the Projects page each session

---

## Notes

- PM2 runs as SYSTEM on port **4003**. To deploy: update `.update-sha` file and POST to `:4013/trigger`.
- Never bump rev in `public/release-notes.js` — Dan controls that.
- Never commit without being explicitly asked.
- Auto-updater replaces `public/` wholesale from `danbelliveau2/SDC_Scheduler` — Abhi's changes to `app.js` / `styles.css` will be overwritten by the next sync unless the sync is paused.
