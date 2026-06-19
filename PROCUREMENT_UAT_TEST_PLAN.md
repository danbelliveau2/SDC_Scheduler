# SDC Scheduler Procurement Module — End-to-End UAT Test Plan

**Document Version:** 1.0  
**Created:** 2026-06-17  
**Test Scope:** Procurement page (Parts List, Assembly Tree, Vendors tabs) + PO Click Navigation feature  
**Environment:** Production-like database with Total ETO integration enabled

---

## Executive Summary

This test plan provides structured UAT coverage for the SDC Scheduler Procurement module, focusing on:
- **Parts List Page**: Column layout, filtering, search, and PO clickability
- **Assembly Tree**: Expand/collapse, hierarchy navigation, and PO visibility
- **Vendors Tab**: Card display, PO detail panels, and navigation
- **PO Click Navigation**: Cross-tab navigation with smooth scrolling and highlighting
- **General Navigation & State**: Tab switching, data persistence, and refresh
- **Error Handling**: Edge cases, empty states, and invalid data

Each test case includes:
- **Test ID** (e.g., PROC-001)
- **Description** of what is being tested
- **Steps to Reproduce** (numbered, executable)
- **Expected Result** (what should happen)
- **Priority** (Critical/High/Medium/Low)
- **Notes** (environment, data setup, or known issues)

---

## Part 1: PO Click Navigation Feature

### PROC-001: Click PO Number in Parts List → Navigate to Vendors Tab

**Description:**  
Verify that clicking a PO number in the Parts List table switches to the Vendors tab, scrolls to the PO card, highlights it, and opens the PO detail panel.

**Steps to Reproduce:**
1. Navigate to Procurement view
2. Select a linked ETO job from the job picker dropdown
3. Click the "Parts List" tab
4. Identify a row with a valid PO number (blue underlined text in the "PO #" column)
5. Click the PO number

**Expected Result:**
- View switches to the "Vendors" tab
- Page scrolls to the PO card smoothly (`behavior: 'smooth'`)
- PO card is briefly highlighted with a visual indicator (yellow/amber background)
- Highlight fades after 2 seconds
- PO detail panel opens to the right of the PO card, showing:
  - Vendor name (with initials avatar)
  - PO status badge (Open / Past Due / Received)
  - Received/Total item count with progress bar
  - Line items table with parts, quantities, received, due dates, and prices
- Panel can be closed via backdrop click or close button

**Priority:** Critical

**Notes:**
- Requires at least one job with linked ETO vendor data
- PO number styling: `color: #1574c4`, `text-decoration: underline`, `cursor: pointer`
- Highlight class: `.po-highlight` (2000ms timeout)
- Test with multiple PO clicks to ensure state resets correctly between clicks

---

### PROC-002: Click PO Number in Assembly Tree (Expanded) → Navigate to Vendors

**Description:**  
Verify PO click navigation works from PO numbers visible when an assembly is expanded in the Assembly Tree tab.

**Steps to Reproduce:**
1. Navigate to Procurement view → Assembly Tree tab
2. Select a linked ETO job
3. Click the caret (▸) next to an assembly name to expand it
4. Scroll down to see the nested parts list (appears below the assembly row)
5. Identify a part row with a PO number in the "PO" column (blue underlined)
6. Click the PO number

**Expected Result:**
- Same as PROC-001:
  - View switches to "Vendors" tab
  - PO card scrolls into view
  - Highlight applied then fades
  - Detail panel opens

**Priority:** Critical

**Notes:**
- Parts are only visible when the parent assembly is expanded
- PO selector in rendered HTML: `.proc-ppo.clickable` (inside `.proc-prow`)
- Test with nested assemblies (depth > 0) to confirm padding doesn't break click

---

### PROC-003: Click PO Number in Vendors Tab Detail Panel → Already on Tab (Smooth UX)

**Description:**  
Verify that clicking a PO number when already on the Vendors tab keeps the view smooth without unnecessary re-renders.

**Steps to Reproduce:**
1. Navigate to Procurement → Vendors tab
2. Identify a PO card with an open detail panel already visible
3. Click a different PO number in the vendor card list (in the PO # button row)

**Expected Result:**
- Current detail panel closes (if clicking a different PO under same vendor)
- New PO detail panel opens without full page re-render
- No flash or layout shift
- Vendor avatar and badge remain visible in the panel
- Scroll position is maintained or smoothly adjusted

**Priority:** High

**Notes:**
- Tests state management when already on the target tab
- Ensures `_procOpenPoPanel()` doesn't duplicate panels or leak memory

---

### PROC-004: PO Click with No Vendor Data (Edge Case)

**Description:**  
Verify graceful handling when a PO is clicked but vendor data hasn't loaded yet or is missing.

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Pick a job, wait for parts list to render
3. Disconnect network (or force slow network in DevTools)
4. Click a PO number very quickly before vendor data loads
5. Observe the result

**Expected Result:**
- PO click is accepted (not disabled)
- Tab switches to "Vendors"
- Page shows "Loading vendor status from Total ETO…" message
- Once vendor data arrives, PO card renders and detail panel opens
- If vendor data fails to load, error message appears instead and no panel opens

**Priority:** High

**Notes:**
- Test network reliability; vendor data fetch is asynchronous
- Vendor data cache key: `_procVendorCache[job]`
- Fallback message: `.proc-empty` div

---

### PROC-005: Click Invalid PO Number (Null, Empty, Malformed)

**Description:**  
Verify that PO columns do not appear clickable if the PO value is null, empty, or invalid.

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Scan the "PO #" column for cells showing "—" (dash = no PO)
3. Attempt to click the "—" cell

**Expected Result:**
- Cell is NOT clickable (no underline, no blue color, `cursor: default`)
- Click has no effect (does not switch tabs or navigate)
- Inspect element shows no `clickable` class and `data-poid` is empty

**Priority:** High

**Notes:**
- PO rendering in Parts List: `<span class="proc-plpo${p.poId ? ' clickable' : ''}" data-poid="${p.poId || ''}">`
- If `p.poId` is falsy, the `clickable` class is NOT added
- Same pattern in Assembly Tree for `proc-ppo`

---

### PROC-006: PO Click Highlight Animation and Cleanup

**Description:**  
Verify the PO card highlight animation runs and cleans up properly, and does not leave residual CSS classes.

**Steps to Reproduce:**
1. Navigate to Procurement → Vendors tab
2. Note current PO cards (no highlight)
3. Click a PO number from the Parts List
4. Watch the PO card for 2 seconds
5. Click the browser's inspect element tool on that PO card after the highlight fades

**Expected Result:**
- PO card has yellow/amber background for ~1500ms
- `.po-highlight` class is applied then removed automatically
- After 2 seconds, element has no `po-highlight` class
- No visual artifacts or stray CSS classes remain
- Multiple clicks in succession work smoothly (cleanup runs before the next click)

**Priority:** Medium

**Notes:**
- Highlight class cleanup: `setTimeout(() => poCard.classList.remove('po-highlight'), 2000)`
- CSS for `.po-highlight`: provides visual feedback (yellow/gold background)
- Test rapid PO clicks to verify no race conditions in cleanup

---

## Part 2: Parts List Page

### PROC-007: Column Widths and Layout Alignment

**Description:**  
Verify that column widths follow design rules: numeric columns narrow, description wide, dates fixed.

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Load a job with parts data
3. Resize browser window to different widths (1920px, 1366px, 768px)
4. Inspect each column's rendered width

**Expected Result:**
- **Qty** column: ~60–80px (fits 2–3 digits + space)
- **PO #** column: ~80–100px (fits monospace 6-digit PO + padding)
- **Part No**: ~120px (fits typical part numbers)
- **Description**: WIDE (`1fr` or `auto`), takes remaining space after fixed columns
  - Long descriptions like "Acceptance at Customer (SAT)" do not wrap or clip
  - Text truncation only if absolutely necessary at very narrow widths
- **Category**: ~120px
- **Parent Assembly**: ~140px (two lines: part # + description)
- **Mfr**: ~100px
- **Purchased** (date): ~130px (`YYYY-MM-DD` input size)
- **Exp** (date): ~130px
- **Status** (pill): ~120px

**Priority:** Critical

**Notes:**
- Parts List uses CSS `table-layout: fixed` with `<colgroup>` widths
- If columns are not fixed, browser redistributes width dynamically based on content
- Test with real data: descriptions of various lengths
- Resize responsively: test at 100%, 75%, 50%, and 125% zoom levels

---

### PROC-008: Parts List Column Order Matches Specification

**Description:**  
Verify the Parts List displays columns in the correct order with correct headers.

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Load a job with parts data
3. Take a screenshot of the column headers
4. Compare left-to-right order against expected sequence

**Expected Result:**
Column order (left to right):
1. **Qty** — quantity ordered (numeric, right-aligned)
2. **PO #** — purchase order number (monospace, centered)
3. **Part No** — part number
4. **Description** — full description of the part
5. **Category** — category name
6. **Parent Assembly** — assembly the part belongs to (with parent part # and description)
7. **Mfr** — manufacturer
8. **Purchased** — PO purchase date (`YYYY-MM-DD`)
9. **Exp** — expected delivery date
10. **Status** — status pill (Received / On Order / No PO, etc.)

**Priority:** High

**Notes:**
- Column header row has CSS class `.proc-plist-head`
- Parts rows have CSS class `.proc-plrow`
- Any column reordering should fail this test immediately

---

### PROC-009: Filter Functionality — STATUS Filter

**Description:**  
Verify the STATUS filter (Received / On Order / No PO / Hold) works correctly.

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Load a job with mixed-status parts (some received, some on order, some no-PO)
3. Locate the filter bar above the parts table (filter chips)
4. Click the "STATUS" filter chip to open a dropdown or popover
5. Select "Received" → observe parts list updates
6. Select "On Order" → observe parts list updates
7. Select "No PO" → observe parts list updates
8. Select "All" or "Show all" → observe parts list resets

**Expected Result:**
- Filter dropdown displays options: Received / On Order / No PO / (On Hold) / All
- Clicking a status shows ONLY parts with that status
- Status pill in each row matches the filter selection
- Parts count drops when filtering (status bar / part count visible)
- "All" option shows all statuses
- Filter state persists when switching tabs and returning (state saved in `_procState.pstatus`)

**Priority:** High

**Notes:**
- Status determination in code: `_procPartStatus(p)` returns `{ key, label, cls, sub }`
- Filter key: `_procState.pstatus` (stored in localStorage)
- Status values: 'received', 'ordered', 'hold', 'nopo'
- Empty state message if no parts match: "No parts match the current filter or search."

---

### PROC-010: Filter Functionality — CATEGORY Filter

**Description:**  
Verify the CATEGORY filter shows only parts in selected categories.

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Load a job with parts in multiple categories (e.g., "Electronics", "Hardware", "Structural")
3. Locate the CATEGORY filter
4. Select a category (e.g., "Electronics")
5. Verify only parts with that category appear
6. Switch to another category
7. Reset to "All" or blank

**Expected Result:**
- Filter dropdown lists all unique categories in the data
- Clicking a category filters the parts list
- Only parts with matching `category` field appear
- Category names are case-sensitive
- "All" option shows all categories

**Priority:** High

**Notes:**
- Category filter key: `_procState.pcat`
- Filter check: `(p.category || '') !== cat`
- Categories come from ETO BOM data
- If no categories in data, filter shows "No categories" or similar

---

### PROC-011: Filter Functionality — MANUFACTURER Filter

**Description:**  
Verify the MANUFACTURER filter shows only parts from selected manufacturers.

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Load a job with parts from different manufacturers
3. Locate the MANUFACTURER filter
4. Select a manufacturer (e.g., "Siemens" or "FANUC")
5. Verify only parts from that manufacturer appear
6. Note: parts with no manufacturer default to "SDC" (in-house)
7. Reset to "All"

**Expected Result:**
- Filter dropdown lists all unique manufacturers
- Clicking a manufacturer filters the parts list
- Parts without a manufacturer show as "SDC" in the grid
- "All" option shows all manufacturers
- Case-sensitive matching

**Priority:** High

**Notes:**
- Manufacturer filter key: `_procState.pmfr`
- Manufacturer source: `p.manufacturer` (from ETO) or defaults to "SDC"
- Filter check: `_procMfr(p) !== mfr`

---

### PROC-012: Filter Functionality — SUPPLIER Filter

**Description:**  
Verify the SUPPLIER filter shows only parts from selected suppliers.

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Load a job with parts from multiple suppliers
3. Locate the SUPPLIER filter
4. Select a supplier (e.g., a vendor name)
5. Verify only parts from that supplier appear
6. Reset to "All"

**Expected Result:**
- Filter dropdown lists all unique suppliers in the data
- Clicking a supplier filters the parts list
- Only parts with matching `supplier` field appear
- "All" option shows all suppliers

**Priority:** Medium

**Notes:**
- Supplier filter key: `_procState.psup`
- Supplier source: `p.supplier` (from ETO)
- Filter check: `(p.supplier || '') !== sup`

---

### PROC-013: Filter Functionality — DATE RANGE Filter

**Description:**  
Verify the DATE RANGE filter (Purchased / Expected delivery dates) narrows the parts list.

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Load a job with parts ordered over several months
3. Locate the DATE RANGE filter section (two date inputs: From / To)
4. Toggle between "Purchased date" and "Expected delivery date" radio buttons
5. Enter a date range (e.g., "2026-01-01" to "2026-06-30")
6. Verify only parts within the date range appear
7. Clear the date range (empty both fields)

**Expected Result:**
- "Purchased date" mode: filters on `p.orderDate`
- "Expected delivery date" mode: filters on `p.expDate` or `p.requiredDate`
- Parts with dates outside the range are hidden
- Empty from/to fields show all parts (no date filtering)
- Date inputs accept ISO format (`YYYY-MM-DD`)

**Priority:** Medium

**Notes:**
- Date filter keys: `_procState.pdatemode` ('purchase' or 'invoiced'), `_procState.pfrom`, `_procState.pto`
- Date comparison: simple string comparison (`dcol < from` or `dcol > to`)
- Empty state when no parts match date range

---

### PROC-014: Search Functionality — Text Search

**Description:**  
Verify the search box filters parts by text across multiple fields (part #, description, category, manufacturer, supplier, PO #).

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Load a job with parts data
3. Locate the search box (placeholder: "Search parts, PO #, manufacturers…")
4. Type a partial part number (e.g., "12345")
5. Verify only parts with that number in any searchable field appear
6. Clear and search by description fragment (e.g., "motor")
7. Clear and search by manufacturer (e.g., "sie" for Siemens)
8. Clear and search by PO # (e.g., "PO-001")

**Expected Result:**
- Search is case-insensitive
- Matching is substring-based (contains, not exact match)
- Results update in real-time as user types
- Search looks across: part number, description, category, manufacturer, supplier, parent part #, parent description, PO #
- Exact hit count should decrease as search becomes more specific
- Empty search shows all parts

**Priority:** High

**Notes:**
- Search box ID: `#proc-search`
- Search state key: `_procState.search`
- Search logic: `q = (_procState.search || '').toLowerCase()`, then check if any field includes `q`
- Focus is restored to search box after each keystroke (for continuous typing UX)

---

### PROC-015: Parts List Data Accuracy — Quantities and Costs

**Description:**  
Verify parts are displayed with correct quantities, unit prices, and calculated totals.

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Load a job
3. Pick a part row with visible quantity and (if available) unit price data
4. Cross-reference the quantity with the ETO source (Total ETO BOM report)
5. If a unit price is shown, verify it matches the latest PO for that part
6. Calculate: qty × unit_price = total_price (if both visible)

**Expected Result:**
- Quantities match ETO BOM exactly
- Unit prices match the latest PO price for each part
- Calculated totals (qty × unit_price) are accurate
- No mathematical errors or rounding artifacts
- Prices display with 2 decimal places and $ symbol

**Priority:** High

**Notes:**
- Parts data source: ETO `getPartLines()` or readiness API
- Unit price source: ETO's `lines` data (latest PO price per part)
- Row rendering: `.proc-plrow` with cells for qty, PO #, part #, description, etc.

---

### PROC-016: PO Number Styling and Interaction

**Description:**  
Verify that PO numbers in the Parts List are styled correctly and respond to hover/click.

**Steps to Reproduce:**
1. Navigate to Procurement → Parts List tab
2. Locate a part with a valid PO number (blue, underlined)
3. Hover over the PO number (mouse over)
4. Note the cursor and color change
5. Move mouse away
6. Inspect the element with DevTools

**Expected Result:**
- **Resting state**: Blue color (`#1574c4`), underline, monospace font
- **Hover state**: Darker blue (`#0d47a1`), cursor changes to `pointer`
- **Element**: `<span class="proc-plpo clickable" data-poid="..." ...>`
- **Transition**: color change is smooth (0.2s)
- **No PO state**: If PO is null/empty, cell shows "—" (dash) in default gray, NOT clickable

**Priority:** Medium

**Notes:**
- CSS class: `.proc-plpo.clickable`
- Styling: `color: #1574c4; text-decoration: underline; cursor: pointer; transition: color 0.2s;`
- Hover: `color: #0d47a1;`
- Non-clickable: `.proc-plpo` without `.clickable` class

---

## Part 3: Assembly Tree

### PROC-017: Assembly Tree Expand/Collapse All Buttons

**Description:**  
Verify "Expand All" and "Collapse All" buttons work correctly in the Assembly Tree tab.

**Steps to Reproduce:**
1. Navigate to Procurement → Assembly Tree tab
2. Load a job with hierarchical assemblies (nested sub-assemblies)
3. Locate the "Expand All" button (top-left of the tree)
4. Click "Expand All"
5. Verify all assemblies expand to show their child assemblies and parts
6. Click "Collapse All"
7. Verify all assemblies collapse (only top-level assemblies visible)

**Expected Result:**
- **Expand All**: All assembly rows toggle open (caret changes from ▸ to ▾), child assemblies and parts are visible
- **Collapse All**: All assembly rows toggle closed (caret changes from ▾ to ▸), only parent-level assemblies visible
- State is saved to `_procState.open` (localStorage)
- Expand/Collapse is smooth (no lag or flicker)
- Button visibility: buttons only appear if there are assemblies to expand/collapse

**Priority:** High

**Notes:**
- Button IDs: `#proc-expand` (expand all), `#proc-collapse` (collapse all)
- State tracking: `_procState.open` is a map of assembly IDs → true/false
- Expansion toggles visibility of child assemblies and parts rows

---

### PROC-018: Individual Assembly Expand/Collapse

**Description:**  
Verify clicking the caret (▸/▾) next to an assembly name expands/collapses that assembly.

**Steps to Reproduce:**
1. Navigate to Procurement → Assembly Tree tab
2. Load a job with nested assemblies
3. Locate an assembly with a caret (▸) indicating it can expand
4. Click the caret
5. Verify the assembly expands to show sub-assemblies and parts
6. Verify the caret toggles to ▾
7. Click the caret again to collapse

**Expected Result:**
- Click expands/collapses the assembly
- Caret toggles direction (▸ → ▾ → ▸)
- Child assemblies appear below the parent row (indented further)
- Child parts appear in a gray box below with column headers: Part No, Description, Mfr, PO, Qty, Price, Total, Exp Date, PO/Rcvd
- Parts belong to that assembly only (not to sibling assemblies)
- Expand/collapse is immediate (no loading delay)
- State persists when switching tabs (saved in localStorage)

**Priority:** Critical

**Notes:**
- Caret cell has CSS class `.proc-caret`
- Assembly rows have CSS class `.proc-arow` with `data-aid` attribute (assembly ID)
- Click listener: `root.querySelectorAll('.proc-arow').forEach(row => row.addEventListener('click', ...)`
- Expanded state: `_procState.open[nodeId] = true`

---

### PROC-019: Assembly Tree Parent Assembly Display

**Description:**  
Verify parent assembly names and descriptions are displayed correctly in the assembly tree.

**Steps to Reproduce:**
1. Navigate to Procurement → Assembly Tree tab
2. Load a job with multi-level assemblies
3. Locate an assembly row
4. Inspect the displayed values:
   - Part number (PN)
   - Assembly description

**Expected Result:**
- Parent PN is displayed (monospace, clickable as copy button)
- Parent description is displayed (full text, with tooltip on hover)
- Descriptions do not wrap (single-line truncation if too long)
- Parent assembly at depth 0 has no indentation
- Child assemblies at depth > 0 have left padding that increases with depth: `10 + depth * 26px`

**Priority:** Medium

**Notes:**
- Part # click copies to clipboard (no navigation)
- Rendering: `<button class="proc-pn" data-copy="...">` with copy event listener
- Description: `<span class="proc-aname" title="...">` (title for full text on hover)

---

### PROC-020: Assembly Tree Parts Display Within Expanded Assembly

**Description:**  
Verify that when an assembly is expanded, its parts are shown in a nested table with correct columns and data.

**Steps to Reproduce:**
1. Navigate to Procurement → Assembly Tree tab
2. Load a job
3. Expand an assembly (click caret)
4. Scroll down to see the parts list below the assembly row
5. Inspect the parts table:
   - Column headers
   - Part data (PN, description, manufacturer, PO, qty, prices, dates)

**Expected Result:**
- Parts are visible in a `.proc-parts` div below the parent assembly
- Column headers: Part No | Description | Mfr | PO | Qty | Price | Total Price | Exp Date | PO / Rcvd
- Each part row shows:
  - Status dot (colored circle: Received/In Stock/On Order/Hold/No PO)
  - Part number (clickable copy button)
  - Description (full text visible, tooltip on hover)
  - Manufacturer
  - PO # (blue underlined if valid, clickable)
  - Quantity
  - Unit price
  - Total price (qty × unit price)
  - Expected delivery date
  - PO quantity / Received quantity
- Parts list is indented and visually separated from the assembly hierarchy

**Priority:** High

**Notes:**
- Parts container: `.proc-parts` div with `margin-left` padding
- Parts table header: `.proc-phead` with column spans
- Parts rows: `.proc-prow` with status-specific class (`.proc-prow-received`, `.proc-prow-ordered`, etc.)
- PO click from assembly tree parts works same as Parts List tab

---

### PROC-021: Assembly Tree Nested Indentation and Alignment

**Description:**  
Verify that nested assemblies are properly indented and visually aligned with their parent.

**Steps to Reproduce:**
1. Navigate to Procurement → Assembly Tree tab
2. Load a job with 3+ levels of nested assemblies
3. Expand top-level assembly to show children
4. Expand one child assembly to show its children
5. Inspect the horizontal indentation of each level

**Expected Result:**
- Level 0 (top-level): `padding-left: 10px`
- Level 1 (children): `padding-left: 10 + 1*26 = 36px`
- Level 2 (grandchildren): `padding-left: 10 + 2*26 = 62px`
- Level 3+: continues incrementing by 26px
- Caret, PN button, and description text all start at the indented position
- Visual hierarchy is clear (deeper = further right)
- Alignment is consistent across all assembly levels

**Priority:** Medium

**Notes:**
- Indentation formula in CSS: `padding-left: ${10 + depth * 26}px`
- Applied via inline style on `.proc-arow` elements
- CSS custom property `--d: ${depth}` also set for debugging

---

### PROC-022: Assembly Tree PO Visibility and Clickability in Nested Parts

**Description:**  
Verify PO numbers are visible and clickable when parts are displayed in expanded assemblies.

**Steps to Reproduce:**
1. Navigate to Procurement → Assembly Tree tab
2. Load a job
3. Expand an assembly to show its parts
4. Scan the "PO" column for valid PO numbers (blue, underlined)
5. Click a PO number

**Expected Result:**
- PO numbers are visible in the "PO" column of the nested parts table
- PO numbers are styled consistently with Parts List (blue, underlined, clickable)
- Clicking a PO from an expanded assembly:
  - Switches to Vendors tab
  - Scrolls to and highlights the PO card
  - Opens the detail panel
- Non-clickable POs (null/empty) show as blank cells (no "—" dash in this context)

**Priority:** High

**Notes:**
- PO element in expanded parts: `.proc-ppo.clickable` (similar to Parts List `.proc-plpo`)
- Data attribute: `data-poid`
- Click listener attached in `renderProcurementPage()` at line ~9191

---

### PROC-023: Assembly Tree Search in Expanded Context

**Description:**  
Verify that the search box filters assembly tree parts when assemblies are expanded.

**Steps to Reproduce:**
1. Navigate to Procurement → Assembly Tree tab
2. Load a job
3. Expand multiple assemblies to show their parts
4. Type in the search box (e.g., a manufacturer name or part #)
5. Verify only matching parts are shown in expanded assemblies
6. Clear search to reset

**Expected Result:**
- Search filters parts WITHIN expanded assemblies (assembly tree structure remains, but parts are filtered)
- Assemblies remain expanded and visible
- Only parts matching the search criteria are displayed
- Search looks across: part #, description, manufacturer
- Search is case-insensitive
- Expanded assembly with no matching parts shows an empty parts container

**Priority:** Medium

**Notes:**
- Search state: `_procState.search`
- Assembly-level search filter (inside `_procAssemblyRow()`): `node.parts.filter(p => [p.pn, p.desc, p.manufacturer].some(...))`
- This is different from Parts List search, which filters top-level parts across all assemblies

---

### PROC-024: Assembly Tree Filter Interactions

**Description:**  
Verify filters (STATUS, CATEGORY, MANUFACTURER, etc.) work correctly in the Assembly Tree tab.

**Steps to Reproduce:**
1. Navigate to Procurement → Assembly Tree tab
2. Load a job
3. Expand an assembly to see all its parts
4. Apply a filter (e.g., STATUS = "Received")
5. Verify only assemblies with at least one matching part are visible
6. Check that assembly stats (Rcvd/Total, No PO count) reflect the filtered data
7. Change to a different filter value
8. Reset filter to "All"

**Expected Result:**
- Filters hide assemblies that have no matching parts
- Assembly statistics (received/total, no-PO count, material cost) recalculate based on filtered parts
- Progress bars adjust accordingly
- Filtering is immediate (no loading)
- Expand/collapse state is preserved across filter changes
- Assembly tree structure remains intact (no collapsing when filter applied)

**Priority:** Medium

**Notes:**
- Filters in Assembly Tree: same as Parts List (STATUS, CATEGORY, MANUFACTURER, SUPPLIER, DATE RANGE)
- Assembly tree re-renders completely on filter change
- Filter state: `_procState.pstatus`, `_procState.pcat`, etc.

---

## Part 4: Vendors Tab

### PROC-025: Vendor Card Display and Layout

**Description:**  
Verify each vendor is displayed as a card with correct information layout.

**Steps to Reproduce:**
1. Navigate to Procurement → Vendors tab
2. Load a job with vendor data from Total ETO
3. Inspect the first vendor card

**Expected Result:**
- Card shows:
  - **Vendor initials avatar** (top-left): initials in a colored circle
  - **Vendor name** (top): full vendor name, truncated with ellipsis if too long
  - **Status badge** (top-right): color-coded badge (Open / Past Due / Received)
  - **PO count and item count** (below name): "X POs · Y items"
  - **Readiness progress bar** (middle): visual bar showing % received
  - **Percentage** (right of bar): numeric % value, color-coded (red < 60%, yellow 60–90%, green > 90%)
  - **PO list** (bottom): table of PO rows with columns: PO # | Received | Date | Status dot

**Priority:** High

**Notes:**
- Card CSS class: `.proc-vcard`
- Avatar: `.proc-vavatar` with initials from vendor name
- Status badge: `.proc-vbadge` with status-specific class (color varies by status)
- Progress bar: `.proc-bar` with filled section `.proc-bar-fill`

---

### PROC-026: Vendor Card PO List and Metadata

**Description:**  
Verify each vendor card displays a list of POs with correct metadata.

**Steps to Reproduce:**
1. Navigate to Procurement → Vendors tab
2. Load a job with vendors
3. Inspect a vendor card's PO list section
4. Check each PO row for:
   - PO number
   - Received count
   - Date (expected or received based on status)
   - Status indicator (dot)

**Expected Result:**
- **PO # column**: 
  - Blue, monospace, clickable (text button)
  - Clicking the PO # copies it to clipboard (no navigation)
- **Received column**: Shows "X/Y received" (e.g., "3/5 rcvd")
- **Date column**: 
  - For open POs: "exp MM-DD" (expected delivery date in short format)
  - For received POs: "rcvd MM-DD" (received date)
  - Overdue POs shown in red text
- **Status dot**: 
  - Green if all parts received
  - Yellow if partial receipt (on order)
  - Red if past due
  - Gray if on hold or no PO
- Each PO row is clickable to open detail panel

**Priority:** High

**Notes:**
- PO row CSS: `.proc-vpo` (inside `.proc-vpos` container)
- PO # button: `.proc-pn.proc-pn-sm` with copy functionality
- Received meta: `.proc-vpo-rcvd`
- Date: `.proc-vpo-date` with status-specific class (`proc-vpo-date-exp`, `proc-vpo-date-rcvd`, `proc-vpo-date-late`)
- Status dot: `.proc-dot.proc-dot-${status}`

---

### PROC-027: Vendor Card Progress Bars and Percentages

**Description:**  
Verify vendor progress bars and percentage displays are accurate and color-coded.

**Steps to Reproduce:**
1. Navigate to Procurement → Vendors tab
2. Load a job with vendors
3. Inspect several vendor cards with different completion percentages
4. Verify the progress bar fill width matches the percentage
5. Verify the percentage color matches the bar fill color

**Expected Result:**
- Progress bar width: `width: ${Math.min(100, v.pct)}%` (capped at 100%)
- Percentage color coding:
  - **Red**: 0–59% (incomplete, needs attention)
  - **Yellow/Amber**: 60–89% (mostly done, almost there)
  - **Green**: 90–100% (nearly complete or complete)
- Bar fill color matches percentage text color
- Text shows numeric value (e.g., "75%")

**Priority:** Medium

**Notes:**
- Percentage calculation: `(receivedQty / totalQty) * 100`
- Color function: `_procBarColor(pct)` returns hex color based on % threshold
- Progress bar element: `.proc-bar-fill` with inline `background` style and `width`

---

### PROC-028: Vendor Card Filter (STATUS Filter in Vendors Tab)

**Description:**  
Verify the vendor status filter (Open / Past Due / Received) works in the Vendors tab.

**Steps to Reproduce:**
1. Navigate to Procurement → Vendors tab
2. Load a job with vendors in various statuses
3. Locate the status filter dropdown (above vendor cards)
4. Select "Open" to show only vendors with open POs
5. Select "Past Due" to show only vendors with late POs
6. Select "Received" to show only vendors with fully received POs
7. Reset to "All" to show all vendors

**Expected Result:**
- Filter dropdown shows options: All / Open / Past Due / Received
- Selecting a status shows only vendors matching that status
- Vendor count updates as filter changes
- Filter state persists when switching tabs (saved in `_procState.vstatus`)
- Vendor status is determined by the status of their POs (not individual vendors)

**Priority:** Medium

**Notes:**
- Filter state key: `_procState.vstatus`
- Dropdown ID: `#proc-vstatus` (appears only in Vendors tab)
- Status values: 'all', 'open', 'pastdue', 'received'

---

### PROC-029: Vendor Card Search

**Description:**  
Verify the search box filters vendors by name or PO number.

**Steps to Reproduce:**
1. Navigate to Procurement → Vendors tab
2. Load a job with vendors
3. Type a vendor name fragment (e.g., "sie" for Siemens) in the search box
4. Verify only matching vendors appear
5. Clear and search by PO number (e.g., "PO-001")
6. Verify vendors containing that PO number appear

**Expected Result:**
- Search is case-insensitive
- Matching is substring-based
- Search looks across: vendor name, PO numbers
- Results update in real-time as user types
- Empty search shows all vendors
- If no vendors match, empty-state message: "No vendors match the filter or search."

**Priority:** High

**Notes:**
- Search state key: `_procState.search`
- Search box placeholder: "Search vendors or PO #…"
- Filter logic applies to vendor name and all PO numbers for that vendor

---

### PROC-030: PO Detail Panel — Opening and Closing

**Description:**  
Verify the PO detail panel opens and closes correctly when clicking a PO or clicking the backdrop.

**Steps to Reproduce:**
1. Navigate to Procurement → Vendors tab
2. Load a job with vendors
3. Click a PO row (anywhere on the row) to open its detail panel
4. Verify the panel slides in from the right
5. Click the backdrop (dark overlay) to close the panel
6. Verify the panel closes
7. Click another PO in a different vendor card

**Expected Result:**
- **Opening**: Detail panel slides in from the right, covering vendor cards
- **Panel content**: Vendor info + PO detail + line items table
- **Closing via backdrop**: Click the dark `.proc-po-backdrop` area to close
- **Closing via close button**: If present, close button (✕ or ×) closes the panel
- **New PO click**: If a different PO is clicked, old panel closes and new one opens
- **Smooth transitions**: no flicker or lag

**Priority:** Critical

**Notes:**
- Panel HTML: `<aside class="proc-po-panel" role="dialog" aria-label="PO detail">`
- Backdrop: `.proc-po-backdrop` with `data-action="ppo-close"`
- Function: `_procOpenPoPanel(job, vendorName, poId)`
- Panel is removed and re-created on each click (not reused)

---

### PROC-031: PO Detail Panel — Vendor and PO Metadata

**Description:**  
Verify the detail panel shows correct vendor name, initials, status badge, and PO number.

**Steps to Reproduce:**
1. Navigate to Procurement → Vendors tab
2. Click a PO to open the detail panel
3. Inspect the panel header for:
   - Vendor name
   - Vendor initials avatar
   - Status badge
   - PO number

**Expected Result:**
- **Vendor initials avatar**: Colored circle with first+last initials (or other initials scheme)
- **Vendor name**: Full name displayed prominently
- **Status badge**: Color-coded (Open / Past Due / Received)
  - Badge text: e.g., "Open", "10d late", "Rcvd"
  - Badge color: green (received), red (late), yellow (open)
- **PO #**: Large, monospace, easily readable

**Priority:** High

**Notes:**
- Avatar: `.proc-vavatar`
- Status badge: `.proc-vbadge` with status-specific class
- Panel rendering function: `_procOpenPoPanel()`

---

### PROC-032: PO Detail Panel — Received/Total Progress and Line Items

**Description:**  
Verify the detail panel displays PO progress (received/total items) and a table of line items.

**Steps to Reproduce:**
1. Open a PO detail panel (Procurement → Vendors tab → click PO)
2. Inspect the panel for:
   - Received count (e.g., "3/5 received")
   - Progress bar
   - Percentage
   - Line items table with columns

**Expected Result:**
- **Received/Total stat**: 
  - Shows "X/Y received" (e.g., "3/5 received")
  - Progress bar under the stat shows % received
  - Percentage colored based on completion: red (low), yellow (medium), green (high)
- **Line items table** (live from Total ETO):
  - Columns: (status dot) | Part No | Description | Qty | Rcvd | Due | Price
  - Each row shows one part line on the PO
  - Status dot indicates if part is received or open
  - Due date may show a "↻" indicator if revised by buyer

**Priority:** Critical

**Notes:**
- Progress stat: `.ppo-stat.ppo-prog`
- Progress bar: `.proc-bar` with fill
- Line items: lazily fetched via `_vpoLoadLines()`
- Line items cache: `_vpoLinesCache[job|po]`
- Loading message: "Loading parts from Total ETO…"
- Error message: "⚠ Could not load part lines: [error]"

---

### PROC-033: PO Detail Panel — Line Items Data Accuracy

**Description:**  
Verify the line items in the PO detail panel are accurate and match Total ETO.

**Steps to Reproduce:**
1. Open a PO detail panel with line items visible
2. Cross-reference part numbers, quantities, and received quantities with Total ETO
3. Check due dates and prices

**Expected Result:**
- **Part No**: Matches ETO part line data
- **Description**: Matches ETO description
- **Qty**: Original PO quantity matches ETO
- **Rcvd**: Received quantity matches ETO receiving records
- **Due date**: Expected delivery date is accurate; shows "↻" if buyer revised it
- **Price**: Unit price matches PO line item

**Priority:** High

**Notes:**
- Line items source: ETO `api.eto.poLines(job, po)`
- Data structure: `{ partNumber, desc, qty, received, dateRequired, dateRevised, price, status }`
- Status values: 'received', 'ordered'

---

### PROC-034: PO Detail Panel — Revised Due Date Indicator

**Description:**  
Verify that when a buyer revises a PO line's due date, the revised date is shown with a "↻" indicator and original date is in tooltip.

**Steps to Reproduce:**
1. Open a PO detail panel with line items
2. Look for line items with the "↻" symbol next to the due date
3. Hover over the revised date to see the tooltip

**Expected Result:**
- If `line.dateRevised != line.dateRequired`, show:
  - **Date cell**: Shows `dateRevised` (the new date)
  - **Indicator**: "↻" symbol after the date
  - **Tooltip**: "Buyer revised this date — originally YYYY-MM-DD"

**Priority:** Medium

**Notes:**
- Revised date logic: `const revised = !!(l.dateRevised && l.dateRequired && l.dateRevised !== l.dateRequired);`
- Rendering: `<span class="${revised ? 'vpo-line-revised' : ''}" title="...">Revised date↻</span>`

---

### PROC-035: Vendor Card Navigation Between Vendors

**Description:**  
Verify navigation between vendor cards (scrolling, clicking different vendors) is smooth.

**Steps to Reproduce:**
1. Navigate to Procurement → Vendors tab
2. Load a job with 5+ vendors
3. Scroll through the vendor cards
4. Click POs from different vendors (opens/closes panel each time)
5. Scroll back to a previously viewed vendor

**Expected Result:**
- Vendor cards scroll smoothly (no flicker or layout shift)
- Clicking a PO from any vendor opens its detail panel correctly
- Closing a panel and opening a PO from a different vendor is smooth
- Scroll position is maintained when panels open/close
- All vendor data is visible (no vendors hidden or cut off)

**Priority:** Medium

**Notes:**
- Vendor container: `.proc-vendors` (flex layout)
- Smooth scrolling: `poCard.scrollIntoView({ behavior: 'smooth', block: 'center' })`

---

## Part 5: General Navigation & State

### PROC-036: Tab Switching — Parts List ↔ Assembly Tree ↔ Vendors

**Description:**  
Verify switching between tabs preserves state and renders correctly.

**Steps to Reproduce:**
1. Navigate to Procurement view
2. Select a job
3. Go to Parts List tab and apply filters (e.g., STATUS = "Received")
4. Switch to Assembly Tree tab
5. Verify the same job is displayed and expand an assembly
6. Switch to Vendors tab
7. Switch back to Parts List
8. Verify filters are still applied

**Expected Result:**
- Switching tabs is instant (no loading)
- Job selection persists across tabs
- Filter states persist:
  - Parts List filters saved in `_procState.pstatus`, `_procState.pcat`, etc.
  - Vendors filter saved in `_procState.vstatus`
- Expand/collapse state in Assembly Tree persists in `_procState.open`
- Search state persists across tabs in `_procState.search`
- All state is saved to localStorage on every change

**Priority:** Critical

**Notes:**
- Tab buttons: `[data-ptab="parts"]`, `[data-ptab="assemblies"]`, `[data-ptab="vendors"]`
- Active tab styling: `.is-active` class
- State storage: `localStorage.setItem('sdcProcState', JSON.stringify(_procState))`
- State restore: `_procState = Object.assign(_procState, JSON.parse(localStorage.getItem('sdcProcState') || '{}'))`

---

### PROC-037: Job Selection and Loading

**Description:**  
Verify selecting a different job from the dropdown loads that job's data correctly.

**Steps to Reproduce:**
1. Navigate to Procurement view
2. Open the job picker dropdown (top of page)
3. Select a different linked job
4. Verify the new job's data loads (parts, assemblies, vendors)
5. Check that the job selection is saved
6. Reload the page (F5)
7. Verify the same job is loaded on page reload

**Expected Result:**
- Job dropdown lists all linked ETO jobs (those linked via the 🔗 chip on project banners)
- Selecting a job immediately loads its procurement data
- Data is fetched from ETO (async, may show "Loading BOM readiness…" message)
- Job selection is saved in localStorage: `_procState.job`
- Filters reset or stay in place depending on implementation (check design)
- On page reload, the previously selected job is loaded

**Priority:** High

**Notes:**
- Job picker ID: `#proc-job-pick`
- Job list source: `_procLinkedJobs()` (from ETO linked projects)
- Last option: "Load a different job…" allows manual entry of any ETO job
- Job state key: `_procState.job`

---

### PROC-038: Load Different Job (Manual Entry)

**Description:**  
Verify the "Load a different job…" option allows manual entry of any ETO job number.

**Steps to Reproduce:**
1. Navigate to Procurement view
2. Open the job picker dropdown
3. Scroll to the bottom and click "🔍 Load a different job…"
4. A modal or prompt appears asking for the job number
5. Enter a valid ETO job number (e.g., "98765")
6. Submit
7. Verify that job's data loads

**Expected Result:**
- Prompt accepts numeric job input
- Error handling if:
  - Job number is invalid (non-numeric, not in ETO)
  - Network error during fetch
- Success: job data loads and displays
- Job is now selectable in the dropdown (even if not linked to any project)
- Job state is saved (persists on page reload)

**Priority:** Medium

**Notes:**
- Manual entry triggers: `fetch('/api/eto/vendors/' + encodeURIComponent(job))`
- Error message appears in toast or modal
- Success loads procurement data the same way as linked jobs

---

### PROC-039: Refresh Functionality

**Description:**  
Verify the Refresh button clears caches and reloads data from Total ETO.

**Steps to Reproduce:**
1. Navigate to Procurement view
2. Load a job with visible data (parts, assemblies, vendors)
3. Locate the Refresh button (🔄 icon near the top)
4. Click it
5. Observe the data re-fetches (may show "Loading…" message temporarily)
6. Verify the data is up-to-date with ETO (no stale cached values)

**Expected Result:**
- Refresh button clears all caches (`_procCache`, `_procVendorCache`, `_procCostCache`, `_vpoLinesCache`)
- Forces re-fetch from ETO with `?refresh=1` query param
- Data reloads (may show "Loading…" briefly)
- All tabs (Parts List, Assembly Tree, Vendors) show updated data
- User's current tab is maintained (no forced switch to another tab)

**Priority:** High

**Notes:**
- Refresh button ID: `#proc-refresh`
- Calls: `loadProcurement(true)` (true = force refresh)
- Cache clearing: `_procCache[job] = null`, etc.
- API refresh param: `?refresh=1`

---

### PROC-040: Data Consistency Across Tabs

**Description:**  
Verify that data is consistent across all three tabs (same job, same totals, same POs).

**Steps to Reproduce:**
1. Load a job in Procurement
2. Note totals: total parts, received parts, no-PO count, total cost
3. Switch to Parts List tab and count matching parts
4. Switch to Assembly Tree and expand all, count matching parts
5. Switch to Vendors tab and count unique POs
6. Verify all counts are consistent

**Expected Result:**
- **Total parts count**: Same across all tabs
- **Received count**: Matches across tabs
- **No-PO count**: Consistent
- **Total material cost**: Same if displayed in multiple places
- **PO numbers**: Same PO # appears in parts/assemblies and in vendor cards
- **Vendor names**: Consistent spelling/casing

**Priority:** High

**Notes:**
- Data source: Single ETO API call per job (`getVendorStatus`, `readiness`)
- State: `_procCache[job]` holds the canonical data
- Counts: `state.gantt.totalParts`, `state.gantt.totalReceived`, etc. (if tracked)

---

## Part 6: Error Handling & Edge Cases

### PROC-041: Empty State — No Data for Selected Job

**Description:**  
Verify graceful handling when a job has no procurement data.

**Steps to Reproduce:**
1. Navigate to Procurement view
2. Select or manually enter a job number that exists in ETO but has no BOM
3. Wait for data to load

**Expected Result:**
- **Parts List tab**: "No parts match the current filter or search." or "This job has no parts in its BOM."
- **Assembly Tree tab**: "No assemblies for this job." or similar
- **Vendors tab**: "Total ETO has no POs for this job yet."
- No errors in the console
- Refresh works to retry

**Priority:** High

**Notes:**
- Empty state element: `.proc-empty` div
- Each tab has its own empty-state message

---

### PROC-042: Error State — Total ETO Connection Fails

**Description:**  
Verify error handling when Total ETO API is unreachable.

**Steps to Reproduce:**
1. Disable network or stop the ETO server
2. Navigate to Procurement view
3. Try to load a job

**Expected Result:**
- Error message displayed: "⚠ [error message from server]"
- Error state element: `.proc-empty.proc-error`
- Refresh button is available to retry
- No unhandled exceptions in console

**Priority:** High

**Notes:**
- Server response: `{ error: 'message' }`
- HTTP status: 503 (service unavailable)
- Frontend shows `data.error` in `.proc-empty.proc-error` div

---

### PROC-043: Missing Vendor Information (Null Vendor Name)

**Description:**  
Verify graceful handling when vendor data is missing or incomplete.

**Steps to Reproduce:**
1. Load a job with vendors where some vendor names are null or empty
2. Go to Vendors tab
3. Inspect the vendor cards

**Expected Result:**
- Vendor card displays with fallback/placeholder (e.g., "(unknown vendor)" or initials "?")
- No crash or layout break
- PO list under the vendor still displays correctly
- Click functionality still works

**Priority:** Medium

**Notes:**
- Vendor name rendering: `<span class="proc-vname" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</span>`
- If `v.name` is empty, shows empty string (may need fallback text)
- Initials derivation: Should handle empty names gracefully

---

### PROC-044: Invalid or Missing PO Data

**Description:**  
Verify handling of parts with invalid PO references or missing PO details.

**Steps to Reproduce:**
1. Load a job with a part that references a PO that doesn't exist in vendor data
2. Go to Parts List tab
3. Try to click the PO number
4. Go to Vendors tab and observe

**Expected Result:**
- **Parts List**: PO # is still clickable (styled correctly)
- **Vendors tab**: 
  - Switch to Vendors tab
  - If PO doesn't exist, no matching vendor card found
  - Toast or error message: "PO not found" or silent failure (no panel opens)
- No console errors

**Priority:** Medium

**Notes:**
- PO lookup in vendors: `vendor.pos.find(p => String(p.po) === String(poId))`
- If not found, `po` is undefined
- Panel opening check: `if (po)` before accessing properties

---

### PROC-045: Large Dataset Handling

**Description:**  
Verify performance with a large BOM (1000+ parts, 50+ assemblies, 20+ vendors).

**Steps to Reproduce:**
1. Load a very large job (if available in test ETO) or create test data with 1000+ parts
2. Go to Parts List tab
3. Scroll through the list, apply filters
4. Go to Assembly Tree and expand assemblies
5. Go to Vendors tab

**Expected Result:**
- **Performance**: 
  - Initial load takes < 5 seconds
  - Tab switching is < 1 second
  - Filtering is instant (< 500ms)
  - Scrolling is smooth (60 FPS, no stutter)
- **Memory**: No memory leak observed over 5 minutes of interaction
- **Stability**: No crashes or unresponsive UI

**Priority:** Medium

**Notes:**
- Monitor browser DevTools Performance tab
- Check memory usage in DevTools (Ctrl+Shift+M)
- Large datasets should not degrade UX significantly

---

### PROC-046: Special Characters in Data

**Description:**  
Verify handling of special characters in descriptions, vendor names, and part numbers.

**Steps to Reproduce:**
1. Load a job with parts containing special characters:
   - Quotes: `"Part "Smart" System"`
   - Ampersands: `R&D Component`
   - Less-than/greater-than: `<10mm Fastener`
   - Unicode: `Ø12mm Bolt` (diameter symbol)
2. Go to Parts List tab
3. Verify special characters are displayed correctly (not HTML-encoded or garbled)
4. Try searching for these parts

**Expected Result:**
- Special characters display correctly (not double-encoded, not garbled)
- HTML encoding applied where needed (e.g., in titles, data attributes)
- Search works for parts with special characters (can find by typing the character)
- No console errors

**Priority:** Medium

**Notes:**
- HTML escaping: `escapeHtml()` function used for display text
- Data attributes: also escaped for safe HTML
- Search: case-insensitive, substring match (should work with special chars)

---

### PROC-047: PO Panel Loading States

**Description:**  
Verify the PO detail panel shows appropriate loading and error states for line items.

**Steps to Reproduce:**
1. Open a PO detail panel
2. Observe the line items section as it loads
3. Simulate a network error (e.g., interrupt network)
4. Observe error handling

**Expected Result:**
- **Loading state**: "Loading parts from Total ETO…" message shown in line items area
- **Success**: Line items table renders with data
- **Error**: "⚠ Could not load part lines: [error message]" shown (retryable if user reopens panel)
- No console errors

**Priority:** Medium

**Notes:**
- Loading state: `.vpo-lines-note` div with message
- Error state: same element with error message
- Line items lazy-loaded via `_vpoLoadLines(box)` when panel opens

---

### PROC-048: Null/Undefined Data Fields

**Description:**  
Verify graceful handling of null/undefined values in data fields across all tabs.

**Steps to Reproduce:**
1. Load a job with incomplete data:
   - Parts with no description
   - Parts with no manufacturer
   - Parts with no category
   - Parts with no supplier
   - Vendors with no status info
2. Inspect each tab for rendering issues

**Expected Result:**
- Null/empty fields show as "—" (dash) or empty string
- No "undefined", "null", or "[object Object]" text
- Layout doesn't break (no misaligned columns)
- Tooltips handle empty values gracefully

**Priority:** Medium

**Notes:**
- Standard fallback: `${value || '—'}`
- Date fields: `fmt(d) => d ? fmtDate(d) : '—'`
- Numeric fields: similar fallback
- Descriptions with no text: empty span (tooltip may be empty too)

---

## Summary of Test Cases by Priority

### Critical (Must Pass Before Release)
- PROC-001: Click PO in Parts List
- PROC-002: Click PO in Assembly Tree
- PROC-007: Column widths correct
- PROC-017: Expand/Collapse All buttons
- PROC-018: Individual assembly expand/collapse
- PROC-030: PO detail panel open/close
- PROC-032: PO detail panel content accurate
- PROC-036: Tab switching state preservation

### High (Should Pass)
- PROC-003, PROC-004, PROC-005: PO click edge cases
- PROC-008, PROC-009–PROC-016: Parts List functionality
- PROC-019–PROC-022: Assembly Tree core features
- PROC-025–PROC-029: Vendor card display and filtering
- PROC-031, PROC-033: PO detail accuracy
- PROC-037–PROC-039: Navigation and state
- PROC-041, PROC-042: Error handling

### Medium (Nice to Have / Polish)
- PROC-006: Highlight animation
- PROC-023, PROC-024: Assembly Tree search/filter
- PROC-027: Progress bar colors
- PROC-028: Vendor status filter
- PROC-034, PROC-035: PO panel details
- PROC-040: Data consistency
- PROC-043–PROC-048: Edge cases and performance

---

## Execution Tips

1. **Test Data**: Use a production-like ETO job with:
   - 100–500 parts (mix of statuses)
   - 5–10 assemblies with nesting
   - 3–5 vendors with open/closed POs
   - Complete and incomplete data (null fields)

2. **Browser**: Test in Chrome, Firefox, Safari, and Edge (if possible)

3. **Performance**: Open DevTools Performance tab during large-dataset tests

4. **Accessibility**: Check tab navigation with keyboard (Tab key), screen reader compatibility

5. **Regression**: After fixes, re-run all Critical tests + related High tests

6. **Sign-off**: Document results in a test report with pass/fail for each case, notes on any failures

---

**End of Test Plan**
