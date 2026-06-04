# SDC Project Scheduler — Working Rules

**Dan's rules. Read every session before touching code. Don't slip on these.**

---

## Hard rules (no exceptions)

1. **NEVER bump the rev in `public/release-notes.js`.**
   Only Dan updates the rev. Verbatim from Dan: *"you only update rev when i say no other tiems."* You break things and call it a new release. Don't.

2. **NEVER tell Dan to open dev tools or check the console.**
   Verbatim: *"I'm not fucking doing this dev tools bullshit. I'm not doing it."* Use visible alerts, in-app diagnostics, or just fix it.

3. **NEVER commit without being explicitly asked.**

4. **NEVER claim something works without verifying.**
   Don't say "fixed!" when you haven't actually tested it.

---

## Design philosophy

- **Strip code, simplify.** Verbatim: *"make hte code as simple as you can.. delete everytihgn you cna and have the same function. then build these features"*
- **No overcomplication.** Verbatim: *"stop overthinking", "stop trying ot overcomplicate"*
- **Personal view should mirror the main Schedule view.** Same patterns, same layout (grid LEFT + Gantt RIGHT), same column headers, same row-by-row alignment, same controls. Do NOT diverge — duplicating render logic creates drift that breaks the user's mental model.
- **If a feature exists in the main Schedule view, the personal view inherits the same UX.** Don't reinvent.

---

## Specific UX rules

### Column widths in ANY grid
**Verbatim:** *"Anytime you build a... any kind of grid for me, the columns have to all make sense for what they are. It's a description column. It's gotta fit the descriptions. Right? If it's a percent complete, it should be a small column."*

- Description / Name columns get the MOST width — `width: auto` or `1fr` so they take the remainder. Long text like `"Acceptance at Customer (SAT)"` must not clip.
- Numeric columns (%, $, qty) get small widths (~60–80 px). They hold 2-4 digits and a percent sign — nothing more.
- Date columns sized for the ISO `YYYY-MM-DD` input (~130–150 px).
- Single-icon columns (checkbox, ✓/×, delete button) get tiny widths (~40–60 px). They hold one glyph.
- **Use `table-layout: fixed`** + `<colgroup>` so the widths actually apply. Without `fixed`, browsers redistribute width based on cell content (which is exactly what causes the bug — long placeholder text in one column starves the description column).
- Tooltips on `<th>` should `white-space: nowrap` + `text-overflow: ellipsis` so long header text doesn't push the column wider than its data needs.

### Grid + Gantt panels
- Grid on LEFT, Gantt on RIGHT, side-by-side (not stacked).
- Grid rows align row-by-row with Gantt bars — `alignGanttToGrid()` pattern. Personal view needs this too.
- Column headers visible at the top of the grid (Task / Project / Dur / Due for personal; the standard set for main).

### Right-click any row
- "+ Add row below" always shown. No conditions. New row inherits the clicked row's section info, lands directly below via `sort_order = clicked + 0.5`.
- Verbatim: *"if i click any line regardlesso f where it is i can add below it who cares about the sections.. just right click any line and it adds one below no quetions no notihng its so easy"*

### Filters
- Quick filters in the popover are "show ONLY X" filters. None should appear "on" with nothing checked.
- "Show completed" ON = show ONLY completed; OFF = no completion filtering (all show).
- **Hide completed items** lives in the **View** menu, NOT in filters. Separate toggle.

### Completed (100%) tasks
- **Grid row stays normal.** No row-wide hash, no row-wide lime border. Just the green-check % pill.
- **Gantt bar: lime green outline + diagonal lime hash lines through the bar.** Description label stays readable.
- **NO ahead/behind drift chip on done tasks.** Baseline feature already covers finish-variance.
- **Completed column exists in the grid** — shows `completed_on` date. Server auto-stamps when progress → 100, clears when it drops below.

### Backlog
- **GUTTED.** No special-case handling. If user wants a Backlog row, they add a regular row and name it "Backlog". `isBacklogTask()` returns false everywhere. No auto-create. No special filter exemptions. No special delete protection.

### Personal view (Actions tab when signed in)
- Toolbar with: View (Grid / Both / Gantt), Filter chips (Overdue / Ahead / Hide done), Zoom (− / Fit / +), name + sign-out.
- Filters are SEPARATE from the main Schedule's filters (live in `_actionsPageState.personalFilters`).
- View modes inherit from main schedule patterns — Grid is the simple list, Both is grid+gantt side-by-side, Gantt is the personal Gantt full-width.

---

## Architecture notes (so you don't blow these away)

- **Server**: `server.js` (Express + `node:sqlite`). FIELDS list at line 18 includes `completed_on`.
- **Client**: single-page app under `public/`. `app.js` is the everything-file.
- **Schema migrations**: `db.js` does `ALTER TABLE tasks ADD COLUMN …` on boot. Don't re-run, just add new lines if needed.
- **`HIERARCHY`** constant drives every grid/gantt walk. Sections 10 / 40 / 50.
- **`inferredAnchorKey(task)`** is the canonical anchor check. Returns null for `anchor_key='backlog'` (backlog is gutted; treated as regular row).
- **`taskScheduleDelta(task)`** returns 0 for completed tasks — no drift chip when done.
- **`alignGanttToGrid()`** at ~line 3357 aligns bars to grid rows by `data-id` → `offsetTop`. Personal view needs an analog.

### Gantt render chain — DEFENSIVE WRAPPING REQUIRED

`renderGantt()` calls a chain of drawers in order. **EVERY new drawer added to this chain MUST be wrapped in `try/catch`.** If any drawer throws, every drawer after it is skipped — that breaks zoom (scroll-restore in `setZoom` never runs → view drifts), breaks alloc/dur labels (`drawBarMeta` is at the end of the chain), and breaks any future feature anchored at the bottom.

```js
function drawNewThing() {
  try {
    // ...actual work...
  } catch (_) { /* swallow — cosmetic, render chain must continue */ }
}
```

This rule cost a half-day of debugging when `drawDoneHashOverlay` killed zoom + bar-meta labels. Never again.

### Adding SVG children to a `.bar-wrapper` — USE `appendChild`, NOT `insertBefore`

`.bar-label` in frappe-gantt is NOT a direct child of `.bar-wrapper`. It's nested. Calling `wrap.insertBefore(elem, label)` throws `DOMException: The node before which the new node is to be inserted is not a child of this node.` Combined with our defensive `try/catch`, the exception is silently swallowed and nothing renders.

ALWAYS use `wrap.appendChild(elem)` when adding overlays to a bar-wrapper. This paints the element ON TOP of bar-label, so make the element thin / faint enough that the description text underneath still reads.

URL references inside SVG attributes (`clip-path="url(#...)"`, `mask="url(#...)"`, `fill="url(#pattern)"`) also fail silently in this SVG context. Stick to inline math (clip endpoints to bar bounds, compute polygon vertices, etc.) and basic SVG primitives (`<rect>`, `<line>`, `<polygon>`). No URL refs.

This rule cost multiple rounds of "ship and you can't see it" debugging on the done-task hash overlay. Never again.

### SVG `<text>` elements need `font-family` inline

frappe-gantt's stylesheet sets `font-family` on `.gantt text { ... }`. If you add a `<text>` element WITHOUT setting `style.fontFamily = 'sans-serif'` inline, the text inherits whatever frappe-gantt's stylesheet picked — which may not render visibly. Result: `<line>` and `<rect>` elements you add show up just fine, but `<text>` is invisible.

Always copy the pattern from `drawBarMeta` for new SVG text:
```js
text.style.fontFamily = 'sans-serif';
text.style.fontSize = '10px';
text.style.fontWeight = '700';
// Optional but recommended for legibility on busy backgrounds:
text.setAttribute('paint-order', 'stroke');
text.setAttribute('stroke', 'rgba(255,255,255,0.9)');
text.setAttribute('stroke-width', '2.5');
text.setAttribute('stroke-linejoin', 'round');
```

This rule cost MULTIPLE rounds of "letters not visible" debugging on the weekday-letters header row. Never again.

### `state.gantt.gantt_start` is a Date OBJECT, not a string

In frappe-gantt v0.6, `state.gantt.gantt_start` is a `Date` instance. Do NOT concatenate strings to it — `gantt_start + 'T00:00:00Z'` produces garbage like `"Fri Aug 07 2026 00:00:00 GMT-0500T00:00:00Z"` → `new Date(NaN)` → silent date-math failure (getUTCDay returns NaN, array[NaN] returns undefined, etc.). Always pass directly:

```js
const startMs = new Date(g.gantt_start).getTime();  // handles both Date and string inputs
```

This bug masquerades as "elements not rendering" because empty `textContent` produces invisible text. Took a day of investigation. Never again.

---

## When in doubt
- Ask Dan once, then move forward.
- Keep changes small and reversible.
- The main Schedule view's UX is the reference. The personal view should look and behave the same way, scoped to one person.
