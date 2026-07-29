# Job Hours — MySQL Rebuild (Option B: Full Model)

> **Living project document.** Plan + tracking + append-only work log for rebuilding the
> Power BI "Job Hours Report — Management Level" semantic model inside the SDC Scheduler
> MySQL database. Update the **Status dashboard** and **Work Log** every session.
>
> **Owner:** Abhi (backend/deployment). **Cross-repo:** sources & model live in sibling
> `../SDC-PowerBI-DEV`; implementation lands in this repo (`SDC_Scheduler`).
> **Created:** 2026-06-29.

---

## 0. How to resume (read this first each session)

1. Read the **Status dashboard** (§1) — it's the single source of truth for "where are we."
2. Read the **most recent Work Log entry** (§13, bottom) — what was last done + next step.
3. Pick the next unchecked item in the **Phase breakdown** (§9) whose dependencies are met.
4. Do the work, then **append a Work Log entry** and tick the checkboxes you completed.
5. Never mark a measure "done" until it passes **reconciliation against live PBI** (§10).

Authoritative model inventory (tables, every measure's DAX, relationships) is reproduced in
§5–§8 here; the raw source is the TMDL under
`../SDC-PowerBI-DEV/Job Hours Report - Management Level/...SemanticModel/definition/` and
`../SDC-PowerBI-DEV/mcp-server/MODEL-NOTES.md`.

---

## 1. Status dashboard

| Area | Status | Notes |
|---|---|---|
| **Overall** | 🟡 Planning | Inventory complete; no code written yet |
| Phase 0 — Discovery & access | 🟡 In progress | Inventory done; access provisioning not started |
| Phase 1 — Schema (dims) | ⬜ Not started | |
| Phase 2 — Ingestion: SharePoint Excel | ⬜ Not started | hours actual, hierarchy, estimates, travel, sales |
| Phase 3 — Ingestion: Sage SQL | ⬜ Not started | Part Purchase, Sage Part Cost |
| Phase 4 — Ingestion: Fabric SQL | ⬜ Not started | ETC history (hours + costs) |
| Phase 5 — Core hours measures (7) | ⬜ Not started | Quoted/Actual/ETC — what the scheduler drawer needs |
| Phase 6 — Remaining measures (124) | ⬜ Not started | billable, eng/shop, parts, profitability, ETC, fees |
| Phase 7 — API + frontend | ⬜ Not started | replace `lib/hoursApi.js` reads |
| Phase 8 — Validation & cutover | ⬜ Not started | parallel-run vs PBI, sign-off, retire exe |

Legend: ⬜ not started · 🟡 in progress · 🟢 done · 🔴 blocked.

**Revised effort estimate (post-inventory):** this is a **multi-month** effort. 131 measures
(many with non-trivial DAX), 27 tables, 3 distinct data-access types. The earlier "few weeks"
figure assumed Excel-only sources; the Sage + Fabric SQL dependencies and the measure count
push it out. Realistic: **~2–4 months** part-time to full parity; **the scheduler's own needs
(Phase 5) are reachable in ~1–2 weeks** once SharePoint access exists.

---

## 2. Decision & scope

- **Chosen:** Option B — rebuild the **entire** model in MySQL (all 27 tables, 131 measures),
  not just the 3 measures the scheduler drawer uses (that was Option A).
- **Why full:** the intent is to own the hours/cost/profitability reporting in-house and
  eventually retire the Power BI exe dependency (and its LocalSystem/DPAPI hang — see
  `lib/hoursApi.js` and the hours-feature memory).
- **Split across sessions:** yes — this document is the chunking mechanism. Phases are sized
  so each can be picked up and finished independently where dependencies allow.

### Guiding principles
1. **Single source of truth.** Do NOT fork the numbers. The MySQL model must read the *same*
   upstream sources Power BI reads (same SharePoint files, same Sage/Fabric tables) so the two
   can't drift. During build, PBI stays canonical; MySQL is validated against it before any
   cutover.
2. **Parallel run before cutover.** Every measure ships behind a reconciliation gate (§10).
   The scheduler keeps using the PBI exe until the MySQL equivalent matches for a sample of jobs.
3. **Idempotent, observable ingestion.** Every refresh logs row counts, timings, and errors
   (§11). Re-running a load must be safe (upsert/replace, not append-duplicate).
4. **Mirror PBI semantics exactly**, including its quirks (§4) — a "cleaner" interpretation
   that produces different numbers is a bug, not an improvement.

---

## 3. Critical PBI quirks to replicate (numbers won't match without these)

| # | Quirk | Where it bites |
|---|---|---|
| Q1 | **`Function Hierarchy[Is Total]` doubles rows** — 824 = 412 leaf + 412 rollup. Filter `Is Total = FALSE` for leaf numbers; only use `TRUE` rows for grand totals. **Never both.** | every function-level aggregation |
| Q2 | **Job ID zero-padding** — 3-digit numeric IDs → 4-digit ("123"→"0123"). Applied on ingest to ALL sources (hours, estimates, ETC, parts, sales, travel). | all joins on Job Id |
| Q3 | **Function-ID remaps** — `512→412` (shop→eng reclass), `315→518` (Paylocity→internal), and `10-311` split into `10-312` (30%) + `10-313` (70%). | Hours Actual ingest |
| Q4 | **Total Function IDs** — 990 PM, 991 Engineering, 992 Shop, 993 Manufacturing, 998 Invalid, 999 Grand — synthesized rollup rows (`Is Total = TRUE`). | Function Hierarchy build |
| Q5 | **Column-name inconsistency** — `Job[Job Id]` vs `Part Purchase[Job ID]` (capital D); `Travel Expenses[Section-Funtion Code]` (typo). Preserve exact source names in staging; normalize on join. | joins |
| Q6 | **`Part Purchase` unmatched Job IDs** — ~2,340 of 28,691 lines have a Job ID absent from the Job dim (~$623K). They are RI mismatches, not NULLs. Surface as a blank-Job bucket, don't silently drop. | parts/cost rollups |
| Q7 | **`Job Profitability %` clamps at 100%** and is not Profit÷Sales for jobs without booked cost. Rank by `Job Profit/Loss` dollars, not %. | profitability measures |
| Q8 | **`Meta[Hours Refreshed Thru]`** = max date where that day has ≥20 actual hours, ≤ model refresh time (EST). Rebuild as a computed value on each ingest. | "as of" / ETC-to-date logic |
| Q9 | **Billable departments allowlist** — many measures gate on `Employee Department IN {"Controls Engineering","Machine Building","Machine Wiring","Mechanical Engineering","Manufacturing"}` and exclude jobs `{"4000","1083","6000","7000","10000"}`. Encode as shared constants. | utilization/billable family |
| Q10 | **Section prefix semantics** — `LEFT(Section-Function Code,2)`: `70`=Warranty, `80`=Service, `90`=Spare Parts, `98`=Invalid. | billable/service splits |

---

## 4. Target architecture

```
SharePoint (Graph API) ─┐
Sage on-prem MSSQL ──────┼─►  ingestion service (Node cron)  ─►  MySQL staging + star schema
Fabric warehouse MSSQL ─┘            (lib/hoursModel/*.js)              │
                                                                       ▼
                                                        measures layer (SQL views / JS compute)
                                                                       │
                                                                       ▼
                                              routes/hours.js  ─►  scheduler drawer + Job Hours page
```

- **Ingestion service:** new `lib/hoursModel/` module. One ingester per source. Scheduled via
  `lib/cronJobs.js` (mirrors the existing PBI warm cadence). Writes to staging tables, then
  transforms into the star schema. Uses `xlsx` (already installed) for Excel, `mssql` (already
  a dep via `etoDb.js`) for Sage/Fabric.
- **Schema:** MySQL tables mirroring the 27 PBI tables (§6). Prefix `jh_` (job-hours) to namespace.
- **Measures layer:** start with **SQL views** for simple aggregations; use a **JS compute layer**
  (`lib/hoursModel/measures.js`) for the gnarly context-transition / time-intelligence measures
  that don't translate cleanly to a single SQL view. Each measure is a named function/view with a
  1:1 mapping to its DAX (documented in §8 checklist).
- **API:** extend `routes/hours.js` to serve from MySQL. Keep the PBI exe path behind a feature
  flag (`HOURS_SOURCE=mysql|pbi`) for parallel running and instant rollback.
- **Frontend:** no shape change needed initially — the existing drawer/JHP consume
  `{fns, bgTotals, totals}`; Phase 5 produces that same shape from MySQL.

---

## 5. Data sources (the 7 upstreams) + access status

| # | Source | Type | Feeds | Access method | Status |
|---|---|---|---|---|---|
| S1 | `Current_Job_Hours.xlsx` (sheet `Report`) | SharePoint Excel | Hours Actual (YtD), Employee/Job seeds | Graph API download | 🔴 needs headless access |
| S2 | `Job_Hours_2025.xlsx` (sheet `Report`) | SharePoint Excel | Hours Actual (2025) | Graph API | 🔴 |
| S3 | `Project Planner Data Control.xlsx` (`FunctionHierarchy`, `Estimated Hours`, `FunctionDepartment`, `Employees`, `Controls`) | SharePoint Excel | Function Hierarchy, Hours Quoted/Estimated/ETC-ME, Employee, Controls | Graph API | 🔴 |
| S4 | `Paid_Expenses___DSB.xlsx` (sheet `Report`) | SharePoint Excel | Travel Expenses | Graph API | 🔴 |
| S5 | `Job Sales.xlsx` (sheet `Job Sales`) | SharePoint Excel | Job Sales | Graph API | 🔴 |
| S6 | Sage on-prem MSSQL `10.0.0.7:1433` db `SDC` | SQL | Part Purchase, Sage Part Cost | `mssql` (like etoDb) | 🔴 needs creds + network |
| S7 | Fabric warehouse `…database.fabric.microsoft.com:1433` db `SDC-DataWarehouse-…` | SQL | ETC history (hours + costs), ETC periods | `mssql` + Entra auth | 🔴 needs creds |
| — | `Section Sub-Section` map | Base64 in-model | Function Hierarchy join | port the static map verbatim | ⬜ trivial |

**Access is the long pole.** All 7 are 🔴 until provisioned. SharePoint (S1–S5) needs a headless
Graph path (app registration / client credentials) that the server's service account can use —
the interactive SharePoint MCP connector in dev is NOT available headless on the pm2/LocalSystem
service. Sage (S6) and Fabric (S7) need DB creds + network reachability from the server box.

> **Snapshot fallback for prototyping:** `../SDC-PowerBI-DEV/source-data/` holds static copies of
> the Excel files (dated 2025-06-03). Use ONLY for building/validating ETL offline; never for
> production (stale). There are no snapshot copies of the Sage/Fabric SQL data.

---

## 6. Target MySQL schema (star)

Follow the existing `db.js init()` pattern: `CREATE TABLE IF NOT EXISTS` + idempotent
`ALTER TABLE … ADD COLUMN ….catch(()=>{})`. All tables prefixed `jh_`. Staging tables `jh_stg_*`
hold raw source rows pre-transform.

### Dimensions (13)
- `jh_job` — PK `job_id` (VARCHAR, padded). Cols: job_name, customer, type, status, is_estimated,
  is_active, start_date, complete_date, effective_close_date, job_order. (`Is Overrun*` are
  measures, computed — not stored.)
- `jh_employee` — PK `employee_id`. first/last/name, department, billing_group, dept_order,
  title, supervisor_id, work_email, is_active.
- `jh_date` — PK `date_id` (INT yyyymmdd). Full calendar incl. `year_month_id`, `is_weekend`,
  `is_etc_to_date`, week-start/end. Generated, not sourced.
- `jh_function_hierarchy` — PK `section_function_code`. section_id, section_name, sub_section_id,
  function_id, function_name, section_function_name, section_function_group, function_group,
  billing_group, is_engineering, is_shop, is_valid, **is_total**, data_source, section_order,
  function_department_name/order, section_function_order. **Includes synthesized total rows (Q4).**
- `jh_etc_period` — PK `etc_period_key`. name, is_active, begin/end date, created_by, created_at,
  relative_index.
- `jh_me_etc_function` — composite key `job_section_function_code`. (derived bridge.)
- `jh_controls` — singleton: engineering_employees, shop_employees, work_hours_per_day.
- `jh_meta` — singleton: hours_refreshed_thru, model_refresh_datetime (computed per Q8).
- What-if params (`jh_param_shop_rate`, `_eng_rate`, `_mfg_pct`, `_pm_pct`) — config rows, editable.
- `jh_hours_type_selector`, `jh_standard_fees`, `jh_display_costs_header` — small/config.

### Facts (14)
- `jh_hours_actual` — grain employee×job×date×function. hours, date_id, job_id, employee_id,
  section_function_code, job_section_function_code, travel, data_source. **(Q2,Q3 on ingest.)**
- `jh_hours_estimated` — grain job×function. hours_quoted, hours_etc, hours_me_etc,
  section_function_code, job_id.
- `jh_job_employee_hours` — summarized (job×employee×date, sub_section_id='80').
- `jh_part_purchase` — PO line. job_id, section_id, category, part_no, description, manufacturer,
  supplier, po_no, qty, purchase_price, total_price, invoiced_amount, invoiced_qty, invoiced_date,
  purchase_date, cost_type. **(Q6 unmatched-job bucket.)**
- `jh_travel_expenses`, `jh_cost_estimated`, `jh_job_sales`, `jh_hours_etc_history`,
  `jh_costs_etc_history`, `jh_assembly`, `jh_sage_part_cost`, `jh_part_purchase_date`,
  `jh_standard_fees_fact`.

> Full per-column DDL is authored in Phase 1/3/4 as each table is built; column lists are in the
> §5 source map and the model inventory. Don't pre-build all 27 — build per phase, just-in-time.

---

## 7. Relationships (33) — join map

Port as FK-style joins (not enforced constraints initially, to tolerate Q6 RI gaps). Key ones:
- `jh_hours_actual.job_id → jh_job.job_id` (M:1)
- `jh_hours_actual.employee_id → jh_employee.employee_id` (M:1)
- `jh_hours_actual.date_id → jh_date.date_id` (M:1)
- `jh_hours_actual.section_function_code → jh_function_hierarchy.section_function_code` (**M:M — apply Q1**)
- `jh_hours_estimated.{job_id, section_function_code}` → job / function hierarchy
- `jh_part_purchase.job_id → jh_job.job_id` (M:1, **Q6**)
- `jh_job_sales.job_id ↔ jh_job.job_id` (**1:1 bidirectional** — only bidi rel in the model)
- ETC history → job / etc_period / function_hierarchy / date(year_month_id, **M:M**)

Full table in the inventory. Auto `LocalDateTable_*` relationships are PBI artifacts — ignore.

---

## 8. Measure porting checklist (131 measures)

Strategy per measure: **(V)** = pure SQL view/aggregation, **(J)** = JS compute (needs filter
context / time-intelligence / iterators), **(C)** = config/display string (trivial). Tick when the
SQL/JS is written **and** it passes reconciliation (§10). DAX for each is in the inventory; the
hard ones are transcribed inline in code comments at implementation time.

### 8a. Core hours — Phase 5 (the scheduler's actual dependency)
- [ ] `Hours Actual` (V) — `SUM(hours_actual)`
- [ ] `Hours Quoted` (V) — `SUM(hours_estimated.hours_quoted)`, ignores Date filter
- [ ] `Hours Estimated to Complete` (V) — `SUM(hours_estimated.hours_etc)`, removes Date filter
- [ ] `Hours Quoted Remaining` / `Hours Quoted Variance` (V) — quoted − actual
- [ ] `Hours ETC Variance` (J) — ETC − actual-est-to-date
- [ ] `Overrun %` (V) — DIVIDE(actual−quoted, quoted)
- [ ] `Is Overrun` (V) — quoted_remaining < 0

### 8b. Hours cuts & cumulative
- [ ] `Hours Actual ME` · `Hours Estimated to Complete ME` · `Hours Actual Average` (V)
- [ ] `Hours Actual, Cumulative` · `…, Est to Date` · `…, Est to Date Cumulative` (J — running)
- [ ] `Hours ETC Variance, Cumulative` (J)
- [ ] `Hours Actual Travel` · `Hours Actual Travel %` (V)
- [ ] `Engineering Hours` · `Shop Hours` · `Other Hours` (V — billing group)
- [ ] `Overtime Hours` · `Engineering Overtime Hours` (J — per employee×day >8)
- [ ] `Hours Date Max` · `Hours Date Min` · `Relative Days` (V)
- [ ] `Estimated to Complete As Of Date` (J — active ETC period EOMONTH−1)

### 8c. Billable / utilization (Q9, Q10 heavy)
- [ ] `Hours Actual Billable` · `… Active` · `… Warranty` · `… Service` · `… Spare Parts` · `… Bellco` (J)
- [ ] `Hours Actual Non-Billable` (J)
- [ ] `Utilization Hours Expected` · `Utilization %` · `Available Hours %` (J/V)
- [ ] `Theoretical Total Hours` · `Theoretical vs Actual Hours` · `Working Days` · `Employees` · `Jobs` (V)

### 8d. Engineering / shop specifics
- [ ] `Engineering Design Hours` · `Engineering Debug Hours` · `Engineering Design to Debug Ratio` (V/J)
- [ ] `Estimated Remaining Days Shop` · `… Engineering` (J — uses Controls headcount)
- [ ] `Estimated Shop Work Thru` · `Estimated Engineering Work Thru` (J)
- [ ] `Is Shop Overrun` · `Is Engineering Overrun` (J)

### 8e. Parts & cost
- [ ] `Part Cost Quoted` · `… Estimated To Complete` · `… Purchased` · `… Actual ETC to Date` (V/J)
- [ ] `Part Cost Total Dynamic` · `… Estimated Dynamic` · `… Invoiced Dynamic` (J — Hours Type Selector)
- [ ] `Part Invoiced Amount` · `Part Invoiced ETC to Date` · `Part % Invoiced` · `Part Cost Left to Spend` (V/J)
- [ ] `Part Purchase Quantity` · `Part Purchase Price` · chart-spacer measures (V)
- [ ] `Part Cost Actual Historical` · `Part Cost Total with 1.3 Markup` (V)
- [ ] `Budget Projection` · `Budget Projection % Of Quoted` · `Parts Cost Estimated To Purchase` (J)
- [ ] Card-display string measures (C)

### 8f. Profitability (Q7)
- [ ] `Sales Amount` · `Change Order Amount` · `Sales Total Amount` (V)
- [ ] `Engineering/Shop/Project Management/Manufacturing Labor Cost` · `Total Labor Cost` (J — what-if rates)
- [ ] `Job Sales Sage Cost` · `… Percent of Sales` · `Total Job Cost` (V/J)
- [ ] `Job Profit/Loss` · `Job Profitability %` · `Weighted Average Profit` (J)
- [ ] `Job Cost % of Total` · `… of Total Sales` (J — ALLSELECTED)
- [ ] `Job Parts Cost, Excl SDC Supplier` · vs-Sage variants (J)
- [ ] `Job Sage Cost` · `Costs Estimated to Complete` (V/J)

### 8g. ETC history / monthly process (time-intelligence — hardest set, all J)
- [ ] `ETC Historical Hours` · `… Prior Month` · `… Diff` · `… Left` · `Hours Actual Prior Month` (+ employee count)
- [ ] `Net Billable Hours` (+ per employee, total, prior-month service) · `Project Progression Hours %`
- [ ] `ETC Historical Costs` (+ prior month, left, diff) · `Costs Actual Prior Month` · `Net Billable Costs` · `Project Progression Costs %`
- [ ] `ETC Historical Working Days` · `ETC Monthly Process - Prior ETC` (+ Cost) · `Prior Month Start`
- [ ] `Standard Fees - Monthly Process - Hours Quoted/Actual by ETC Period` · `Standard Fees Hours Pulled` (+ previous month)
- [ ] `Has Quoted Hours` · `Total Net Billable Hours` (+ per employee)

### 8h. Meta / display / config (C/V)
- [ ] `Model Refresh Date Time` · `Hours Refreshed Thru` · `Utilization Thru` (Q8)
- [ ] `Engineering Employees` · `Shop Employees` · `Work Hours Per Day` (from Controls)
- [ ] `Job Display` · `Select One Job Display` · `Blank` · display/card strings · `HTML IFRAME SMARTSHEETS` (C)
- [ ] `Service Hourly Rate` · `Service Cost` · `Travel Expense Amount` (V/J)

### 8i. Assembly (BOM hierarchy — 8, all J, hierarchy-context)
- [ ] `EntityBrowseDepth` · `Show Row In Hierarchy` · `Max Level` · `Level Count` · `Row Count`
- [ ] `Sum Part Quantity` · `Sum Part Cost` · `Sum Assembly Quantity` · `Line Assembly Quantity`

> **~131 line items.** Group ownership by phase: 8a in Phase 5; 8b–8i in Phase 6 (can be split
> further per sub-section across sessions). Each becomes its own Work Log entry when tackled.

---

## 9. Phase breakdown (the work-split plan)

Each phase lists deliverable + exit criteria. Phases 2/3/4 are independent once their access
exists; 5 depends on 1+2; 6 depends on 5; 7 on 5; 8 last.

### Phase 0 — Discovery & access  🟡
- [x] Full model inventory (tables/measures/relationships/sources) — **done 2026-06-29**
- [ ] Provision **SharePoint headless** access (Graph app reg / client creds usable by the service account)
- [ ] Provision **Sage SQL** creds + confirm network reachability from the server box
- [ ] Provision **Fabric SQL** creds + Entra auth path
- [ ] Add env vars (§12); confirm `xlsx` + `mssql` usable in this repo
- **Exit:** a throwaway script can read 1 row from each of the 7 sources from the server.

### Phase 1 — Schema: dimensions
- [ ] `jh_date` generator (calendar incl. `is_etc_to_date`, `year_month_id`, `is_weekend`)
- [ ] `jh_job`, `jh_employee`, `jh_function_hierarchy` (incl. Q1/Q4 totals), `jh_controls`,
      `jh_etc_period`, what-if param tables, `jh_meta`
- **Exit:** tables created via `db.js`/migration; empty but correct.

### Phase 2 — Ingestion: SharePoint Excel (S1–S5)
- [ ] Graph download helper (`lib/hoursModel/sharepoint.js`)
- [ ] Ingest Function Hierarchy + Estimates + FunctionDepartment + Employees + Controls (S3)
- [ ] Ingest Hours Actual YtD (S1) + 2025 (S2) with Q2/Q3 transforms (+ historical 20250131)
- [ ] Ingest Travel (S4), Job Sales (S5)
- **Exit:** `jh_hours_actual`, `jh_hours_estimated`, `jh_function_hierarchy`, `jh_employee`,
  `jh_job`, `jh_travel_expenses`, `jh_job_sales` populated; row counts logged.

### Phase 3 — Ingestion: Sage SQL (S6)
- [ ] Port the Part Purchase SQL (PO header/detail/receiver/AP union + Extra Costs) → `jh_part_purchase`
- [ ] `jh_sage_part_cost`
- **Exit:** parts facts populated; ~28.7k rows; Q6 blank-job bucket present.

### Phase 4 — Ingestion: Fabric SQL (S7)
- [ ] ETC history (hours + costs) + ETC periods → `jh_hours_etc_history`, `jh_costs_etc_history`, `jh_etc_period`
- [ ] `jh_cost_estimated`
- **Exit:** ETC facts populated.

### Phase 5 — Core hours measures (8a) + drawer cutover prep
- [ ] Implement 8a measures (SQL/JS) producing the `{fns, bgTotals, totals}` shape per job
- [ ] Reconcile 8a vs PBI for ≥5 sample jobs (incl. a multi-job rollup like `1129&1143`)
- [ ] `HOURS_SOURCE` feature flag in `routes/hours.js`
- **Exit:** scheduler drawer can run on MySQL behind the flag; numbers match PBI.

### Phase 6 — Remaining measures (8b–8i)
- [ ] Sub-batches: cuts/cumulative → billable/util → eng/shop → parts → profitability → ETC history → meta/display → assembly
- **Exit:** all 131 measures implemented + each reconciled.

### Phase 7 — API + frontend
- [ ] Serve Job Hours page + drawer fully from MySQL; add any new measure surfaces if desired
- **Exit:** UI parity from MySQL source.

### Phase 8 — Validation & cutover
- [ ] Parallel-run window; full reconciliation report; sign-off
- [ ] Flip `HOURS_SOURCE=mysql` default; retire PBI exe path (keep as emergency fallback one release)
- **Exit:** PBI exe no longer on the critical path; LocalSystem/DPAPI hang risk gone.

---

## 10. Validation & reconciliation strategy

- **Oracle = live Power BI**, queried via the existing `lib/hoursApi.js` DAX path (run as akamuju
  where the token works). For each measure, compare MySQL vs the equivalent DAX `EVALUATE` for a
  fixed **sample set of jobs** (pick ~8 spanning active/complete/overrun/multi-job/edge cases).
- **Tolerance:** hours/counts exact; currency within rounding ($1). Any mismatch = measure stays
  unchecked; log the delta + suspected quirk.
- **Reconciliation harness:** `scripts/hours-reconcile.js` — takes a measure name + job set,
  prints MySQL value, PBI value, delta. Append results to the Work Log.
- **Regression:** keep the sample-set expected values in a fixture; re-run after any ingest/ETL change.

---

## 11. Logging & observability (required)

- **`jh_ingest_log` table:** one row per ingest run — source, started_at, finished_at, rows_read,
  rows_written, status, error_text. Powers an admin "data freshness" view.
- **`jh_meta`:** `hours_refreshed_thru`, `model_refresh_datetime` (mirrors PBI Meta) updated each run.
- **Structured console logs:** prefix `[hoursModel]` like the existing `[hoursApi]`/`[eto]`
  convention; log per-source counts, transform anomalies (e.g. count of Q3 remaps applied, Q6
  unmatched-job rows), and timings.
- **Validation log:** reconciliation results appended to §13 with date + job set + pass/fail.
- **Failure handling:** an ingest failure leaves the prior data intact (transactional swap or
  staging→promote), logs the error, and surfaces it on the freshness view — never silently serves
  half-loaded data.

---

## 12. Access & ops requirements

- **Env vars (add to `.env`, gitignored):**
  `SP_TENANT_ID`, `SP_CLIENT_ID`, `SP_CLIENT_SECRET`, `SP_SITE` (SDC-PowerBIIntegration);
  `SAGE_SQL_HOST=10.0.0.7`, `SAGE_SQL_PORT=1433`, `SAGE_SQL_USER/PASSWORD/DB=SDC`;
  `FABRIC_SQL_HOST`, `FABRIC_SQL_DB`, `FABRIC_AUTH` (Entra);
  `HOURS_SOURCE=pbi|mysql` (default `pbi` until Phase 8).
- **Reminder:** `.env` edits don't auto-restart the server (gitignored → no auto-pull trigger).
  After editing, `pm2 restart sdc-scheduler` (LocalSystem pm2) or piggyback on a code push. See
  the SDC Assistant fix note — same mechanism.
- **Runs under:** the existing pm2 `sdc-scheduler` app (port 4003). Cron via `lib/cronJobs.js`.
- **Libraries:** `xlsx` ✅ installed; `mssql` ✅ used by `etoDb.js`. No new deps expected.

---

## 13. Risks & open questions

- **R1 — Access is the gating dependency.** Three distinct auth setups (SharePoint Graph, Sage,
  Fabric), partly IT-dependent. Until provisioned, only offline prototyping on the stale
  `source-data/` snapshots is possible (Excel only; no SQL snapshots).
- **R2 — Measure fidelity.** 131 measures with filter-context/time-intelligence DAX. The ETC
  history + Standard Fees + billable families (8c/8g) are the highest-risk to reproduce in SQL/JS.
- **R3 — Drift.** If anyone edits the PBI model or the source files' shape, MySQL ingest breaks or
  diverges. Mitigate: schema-shape assertions on ingest + the freshness view.
- **R4 — Sage SQL is shared infra.** Read-only, off-hours scheduling, and a row cap to avoid
  loading the ERP. Confirm a read replica or acceptable query window with whoever owns Sage.
- **R5 — Is this worth it vs Option A?** Open. If the real goal is just a reliable scheduler
  drawer, Phase 5 (≈Option A) delivers that; Phases 6–8 are only justified to retire PBI reporting
  org-wide. **Revisit after Phase 5.**
- **Q — Where do `Employees`/`Controls` sheets actually live and stay current?** (S3 workbook —
  confirm ownership/refresh.)
- **Q — Fabric warehouse: is it the canonical ETC store, or is ETC also derivable from Excel?**

---

## 14. Ownership & coordination

- Implementation is backend → **Abhi**. Touches `db.js`, `lib/`, `routes/hours.js`,
  `lib/cronJobs.js`, `.env`. No `public/app.js` change needed until Phase 7 (then coordinate w/ Dan).
- Model/source definitions are in **`../SDC-PowerBI-DEV`** (separate repo) — read-only reference;
  do not modify the PBI model as part of this.

---

## 15. Work Log (append-only — newest at bottom)

### 2026-06-29 — Discovery complete; plan authored
- Read `lib/hoursApi.js` — current bridge uses 3 measures (Quoted/Actual/ETC) by job×function via DAX.
- Extracted full model inventory from TMDL: **27 tables, 131 measures, 33 relationships, 7 sources**.
- **Key correction to earlier assumption:** sources are NOT all Excel — `Part Purchase`/`Sage Part Cost`
  come from **Sage on-prem MSSQL (10.0.0.7)** and ETC history from a **Fabric warehouse**. Only
  hours/hierarchy/estimates/travel/sales are SharePoint Excel.
- Confirmed `xlsx` installed; `mssql` available via `etoDb.js`; `db.js` uses idempotent init pattern.
- Catalogued the 10 critical PBI quirks (§3) that must be replicated for numbers to match.
- Wrote this plan. **Status:** Phase 0 in progress (inventory ✓, access ✗).
- **Next step:** decide go/no-go on full Option B vs stopping at Phase 5; if go, start Phase 0
  access provisioning (SharePoint headless first — it unblocks the most). Or build the offline
  Phase 2 ETL prototype against `../SDC-PowerBI-DEV/source-data/` to de-risk while access is arranged.

<!-- Template for new entries:
### YYYY-MM-DD — <short title>
- what was done
- decisions / surprises
- reconciliation results (measure, job set, pass/fail, deltas)
- next step
-->
