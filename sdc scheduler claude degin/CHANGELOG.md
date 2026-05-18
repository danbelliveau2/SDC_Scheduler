# SDC Scheduler — Visual System v2 Changelog

Drop-in replacement for `styles.css`, with markup-only additions to `index.html`
and a structural reshape of `login.html`. Every change below maps back to a pain
point or upgrade goal from the design brief.

The data scripts (`phases.js`, `release-notes.js`, `app.js`) are demo stubs that
populate the prototype with believable engineering-to-order project data so the
visual changes can be reviewed against real-looking content. In production those
files stay; their contents come from `/api/*` calls.

---

## Foundations — design tokens at the top of `styles.css`

A new `:root` block adds tokens the rest of the sheet now references:

| Token family | Values | Why |
|---|---|---|
| **Spacing** | `--s-1`..`--s-8` on a 4px base | Replaces the 6/7/9px scatter called out in Upgrade Goals → Spacing rhythm. |
| **Type** | `--fs-label: 11px`, `--fs-body: 13px`, `--fs-section: 15px`, `--fs-title: 17px` | Three-tier hierarchy from Upgrade Goals → Typography. |
| **Radii** | `--r-sm: 4px` → `--r-xl: 12px`, `--r-pill: 999px` | Consistent corner language across buttons / cards / pills / modals. |
| **Elevation** | `--shadow-0/1/2/4`, plus `--shadow-modal` and `--shadow-topbar` | Layered shadows from Upgrade Goals → Visual polish. Cards = 1dp, modals = special, dropdowns/popovers = 4dp. |
| **Motion** | `--t-fast: 120ms ease`, `--t-med: 200ms ease`, `--t-slow: 280ms cubic-bezier(.16,1,.3,1)` | Used everywhere a hover/active/visibility change happens. |
| **Surfaces** | `--surface-alt-2`, `--text-faint`, `--danger-tint`, `--sdc-primary-tint`, `--sdc-dark-2`, `--sdc-accent-hover` | Filler tokens needed by the new components below; all derived from the fixed palette. |

A universal `:focus-visible` rule paints a 2px SDC Blue outline on every keyboard-focused element — addresses Upgrade Goals → Focus states.

---

## Pain Point 1 — Topbar feels flat

- The brand area now sits in a fixed-width anchor with **inline SVG mark + wordmark + tagline** (added to `index.html` as a markup addition; the original broken `<img>` is preserved but `display:none`).
- A subtle gradient vertical seam (`.brand::after`) separates the brand from the view tabs the way a newspaper masthead separates from its nav.
- View tabs (`.tab`) drop the pill-on-pill treatment and become real tabs with a **3px yellow underline** indicator on the active tab — reads as navigation, not just highlighted buttons.
- Topbar gets its own elevation via `--shadow-topbar`, so it floats above the project tab bar.
- Filter button + revision pill keep their visual weight on the right (Pain Point 1) but use translucent backgrounds so the brand stays the primary anchor.

## Pain Point 2 — Project tab bar visually merged with the topbar

- Topbar background is `--sdc-primary` (blue); project tab bar background is `--sdc-dark` (navy) — already different colors. The merge feeling was about *layering*, so the project tab bar now gets:
  - `inset 0 1px 0 rgba(255,255,255,0.04)` — a hairline top highlight.
  - `0 2px 6px rgba(6,29,57,0.20)` — a soft bottom shadow.
- Active project tab "punches through" the bar's bottom edge with a white fill + yellow inset border so it reads as a folder tab fronting the panel below, instead of just a colored pill.

## Pain Point 3 — Schedule toolbar cluttered (12+ controls)

- All toolbar buttons are now **30px tall** with consistent border + radius (`--r-md`) and identical font sizing — answers Pain Point 3's "consistent button sizing and alignment" ask.
- `.seg-divider` (already in the HTML between groups) renders as a faint 1px vertical bar that visually separates: [Layout segmented] | [View toggles] | [Baseline/Financial] | [Column/Row controls] | [Zoom] | [Fit] | [Export/Print].
- Toolbar toggle buttons drop the muted-on-white default and now use a white surface with `--border-strong`; on hover they tint blue; on active they invert to solid SDC Blue. Easier to scan which toggles are on.
- The two segmented pairs (Critical/Only and Set baseline/Baseline) share their border so they read as one linked control, not two adjacent buttons.

## Pain Point 4 — Grid rows cramped

- Subtle **zebra striping** on data rows via `nth-child(even of [data-id])`. Anchor rows and group headers are excluded so the hierarchy still reads cleanly.
- Row hover (`--row-hover`) and zebra (`--surface-alt`) are both tuned so the hover state wins on alternate rows.
- The phase color stripe on `td.col-name::before` is widened to 4px and pinned to the cell's left edge for a stronger color cue.
- Borders between rows soften from `--border-strong` to `--border` so the stripe-on-stripe doesn't read as a heavy ruled table.

## Pain Point 5 — Group header rows lack hierarchy

Three distinct levels now:

- **Level 1 — Section header** (`tr.group-header.level-1`): 32px row, 12px caps, 800 weight, full-width tinted bar in section color (configurable via Setup → Section Colors). Section 10/40/50 each get their own tint.
- **Level 2 — Department header** (`tr.group-header.level-2`): 26px row, 11px caps, 700 weight, `--surface-alt` background, indented 20px.
- **Level 3 — Sub-department header** (`tr.group-header.level-3`): 22px row, 10px caps, 600 weight, muted text color, indented 32px, **dashed** top border instead of solid — visually demotes it relative to level 2.
- Anchor rows (`tbody tr.anchor-row`) sit outside the group hierarchy: 36px row, heavy 2px borders top + bottom in the anchor text color, name wrapped in `.anchor-name-chip` (rounded yellow-green chip with shadow).

## Pain Point 6 — Empty state and loading state

- `.empty-state` now lays out as `flex column` with `align-items: center`. It renders a 96px circular tint behind a 56px inline SVG illustration (linked via `<use href="#i-empty">`), then a 15px section title, then a 12px body line. Two illustrations: one for the grid (clipboard + magnifier), one for the Gantt (bars on a timeline).
- New **`.skeleton`** + `.skeleton-row` + `.skeleton-cell` classes provide a shimmering loader. The HTML adds a `<div id="grid-loading">` block with five skeleton rows; app.js can flip its `.hidden` class between fetches. `@keyframes shimmer` drives a 1.4s linear gradient sweep.

## Pain Point 7 — "+ Add task" and "Zoom to fit" treatment

Both are now the **same primary pill**: 32px height, yellow accent fill (`--sdc-accent`), navy text, 1px shadow. They read as twin actions — one to grow the schedule, one to reframe it.

## Pain Point 8 — Setup cards feel like a form dump

- `.setup-card` keeps its rounded border and gets `--shadow-1` at rest, `--shadow-2` on hover — gives the cards a quiet sense of elevation that lifts on focus.
- `.setup-card-head` is now a `display: flex` with **icon accents**: each card gains a 36px square `.icon-accent` slot rendering an inline SVG glyph (palette / paint / layers / anchor / tree / phases / money / flag / arrow / team). All icons are inline SVG via a `<defs>` block at the top of `index.html` — no icon font dependency.
- Card titles bumped to `--fs-section` (15px) so they stand out from body text.

## Pain Point 9 — Modal dialogs

- Both `.modal-overlay` and the existing `.modal-backdrop` (used by Financials) now share:
  - `border-radius: var(--r-xl)` (12px).
  - `box-shadow: var(--shadow-modal)` — 28+10 layered shadow for hard separation from the page.
  - **Backdrop blur** of 4px (`backdrop-filter`) so the underlying schedule fades softly into focus.
  - `@keyframes modalIn` — 200ms fade + translate-up + 0.96→1 scale — on entrance.
- The Smartsheet sync modal (added as markup in `index.html`) demos this with a four-step list (verified / fetching / resolve / apply), each step a `.sync-step` card with a numbered chip that turns blue when current and green when done.
- A second modal (Keyboard help, bound to `?`) demos the same chrome for help dialogs.

## Pain Point 10 — Login page

- `login.html` reshapes into a **left brand panel + right form panel** split.
- Brand panel: SDC Navy background, radial-gradient accents in SDC Blue and SDC Green, and a faint diagonal grid pattern (drawn entirely in CSS via `background-image`; no asset). Contains an inline SVG mark, a 36px headline ("Plan every machine from PO to ship."), a 15px lede, and a four-item bullet list with green dots evoking the Gantt phase tints.
- Form panel: white surface, single 380px column, 24px bold title, 11px uppercase labels, larger 44px input height, blue focus ring, error message shakes (`@keyframes shake`) when shown.
- The original `<img class="login-logo">` is preserved in the markup but hidden via CSS — addresses the spec's request to fall back gracefully when the SVG asset is missing. Inline SVG provides the actual mark.
- Below 880px viewport the brand panel hides; only the form panel remains.

---

## Upgrade Goals coverage

| Goal | How |
|---|---|
| Visual polish, layered shadows | `--shadow-0/1/2/4/modal/topbar` tokens applied per surface tier. Cards 1dp, modals special, dropdowns/popovers 4dp. |
| 4px spacing rhythm | `--s-1`..`--s-8` tokens replace all the prior 6/7/9px values across buttons, padding, gap, margins. |
| 120ms ease transitions | `--t-fast: 120ms ease` consistently applied to hover/active/visibility on every interactive element. |
| Typography hierarchy | 11/13/15 (+17 for modal titles) via `--fs-label`/`--fs-body`/`--fs-section`/`--fs-title`. |
| Focus states | Universal `:focus-visible` rule + special inverted treatment on dark-surface buttons. |
| Scrollbar styling | Grid + Gantt panels now show a **thin** (8px) scrollbar thumb in muted slate (`rgba(100,116,139,0.45)`) on hover, transparent at rest. Drag-pan still works as before. |

---

## Files in this delivery

- `styles.css` — the only stylesheet; full drop-in replacement.
- `styles.original.css` — your prior file, copied in untouched for reference / diff.
- `index.html` — markup additions only:
  - inline SVG `<defs>` block in `<head>` (10 reusable icons)
  - `.brand-mark` SVG and `.brand-wordmark` `<span>` inside `.brand` (original `<img>` and `<h1>` preserved)
  - `.icon-accent` wrappers inside each `.setup-card-head` (each existing `<h2>` and `<p>` preserved, just wrapped in `.head-text`)
  - enriched `#empty-state` and `#gantt-empty` content
  - `#grid-loading` skeleton block
  - `#modal-smartsheet` and `#modal-kbd` modal markup before the script tags
- `login.html` — restructured per the brief (the original is the only file we restructured; the brief explicitly asked for a brand-panel split here).
- `phases.js`, `release-notes.js`, `app.js` — demo data + behavior stubs. Replace with production equivalents.
- `CHANGELOG.md` — this file.
