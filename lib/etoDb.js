'use strict';
/**
 * etoDb.js — read-only bridge to the Total ETO ERP database (SQL Server).
 *
 * Total ETO is the system of record for projects, purchase orders, and
 * receiving. This module NEVER writes to ETO — it only reads, and pushes
 * the results into the scheduler's own MySQL tables (vendor_pos).
 *
 * Entirely optional: when ETO_HOST is unset every function is a no-op /
 * throws a clear "not configured" error, same pattern as SMTP_HOST.
 *
 * Env vars: ETO_HOST, ETO_DATABASE, ETO_USER, ETO_PASSWORD,
 *           ETO_DOMAIN (optional, NTLM), ETO_PORT (default 1433)
 *
 * The join key between the two systems:
 *   scheduler projects.job_number  ===  ETO ProjectID  (e.g. 1083, 1119)
 */
require('dotenv').config();

let sql = null;
try { sql = require('mssql'); } catch (_) { /* dep optional until installed */ }

let pool = null;

const CONFIGURED = !!(process.env.ETO_HOST && sql);

const config = CONFIGURED ? {
  server: process.env.ETO_HOST,
  database: process.env.ETO_DATABASE,
  user: process.env.ETO_USER,
  password: process.env.ETO_PASSWORD,
  domain: process.env.ETO_DOMAIN || undefined,
  port: process.env.ETO_PORT ? parseInt(process.env.ETO_PORT) : 1433,
  options: { encrypt: false, trustServerCertificate: true },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
} : null;

async function getPool() {
  if (!CONFIGURED) {
    throw new Error('Total ETO is not configured. Set ETO_HOST, ETO_DATABASE, ETO_USER, ETO_PASSWORD in .env.');
  }
  if (!pool) pool = await sql.connect(config);
  return pool;
}

// ── Queries (read-only) ──────────────────────────────────────────────────────

/** Cheap connectivity probe. */
async function ping() {
  const db = await getPool();
  await db.request().query('SELECT 1 AS ok');
  return true;
}

/** Project name lookup — validates a scheduler job_number against ETO. */
async function getProjectInfo(projectId) {
  const db = await getPool();
  const active = await db.request()
    .input('projectId', sql.Int, projectId)
    .query(`SELECT TOP 1 ProjectID, PDescription AS ProjectName FROM vwProjects WHERE ProjectID = @projectId`);
  if (active.recordset[0]) return active.recordset[0];
  // vwProjects excludes closed/archived jobs — specs existing means the job is real
  const specCheck = await db.request()
    .input('projectId2', sql.Int, projectId)
    .query(`SELECT TOP 1 ProjectID FROM tblSpec WHERE ProjectID = @projectId2`);
  if (specCheck.recordset[0]) {
    return { ProjectID: projectId, ProjectName: `Project ${projectId} (closed/archived)` };
  }
  return null;
}

/** Est-vs-actual hours / labor / materials / margin for one project. */
async function getProjectCosting(projectId) {
  const db = await getPool();
  const result = await db.request()
    .input('projectId', sql.Int, projectId)
    .query(`
      SELECT
        C.ProjectID AS JobID, C.PDescription AS Description,
        C.EstEngHours AS EstEngHrs,   C.ActEngHours AS ActEngHrs,
        C.EstMfgHours AS EstMfgHrs,   C.ActMfgHours AS ActMfgHrs,
        C.EngEstimateExtended AS EstEngLabor, C.ActEngLabor AS ActEngLabor,
        C.MfgEstimateExtended AS EstMfgLabor, C.ActMfgLabor AS ActMfgLabor,
        C.EstTotalMaterials AS EstMaterials,  C.ActTotalMaterials AS ActMaterials,
        C.ExtendedEstimate AS TotalEstimate,  C.ActTotalCost AS TotalActualCost,
        C.SalesPrice AS SalesPrice, C.BudgetMargin AS BudgetMargin, C.ActualMargin AS ActualMargin
      FROM vwProjectActualsVSEstimates C WITH(NOLOCK)
      WHERE C.ProjectID = @projectId
    `);
  return result.recordset[0] || null;
}

/**
 * Part-cost financial summary for one project — mirrors Total ETO's "Part Cost"
 * report card. MATERIALS only (purchased parts), not labor:
 *   estimated  = vwProjectActualsVSEstimates.EstTotalMaterials  (planning baseline)
 *   actual     = vwProjectActualsVSEstimates.ActTotalMaterials
 *   purchased  = Σ(PO line qty × price)         — committed on POs
 *   received   = Σ(received qty × price)         — physically in
 *   paid       = Σ AP invoiced amount            — billed/paid to vendors
 *   leftToPay  = purchased − paid                — committed but not yet billed
 *   etc        = max(0, estimated − purchased)   — estimate-to-complete
 * ETO has no per-project "budget" field (the BI gauge's budget is a report
 * parameter), so `estimated` is the baseline rather than a hard budget.
 */
async function getPartCost(projectId) {
  const db = await getPool();
  const [po, paid, costing] = await Promise.all([
    db.request().input('p', sql.Int, projectId).query(`
      SELECT
        ISNULL(SUM(pod.PurchaseQty * pod.PurchasePrice), 0) AS Purchased,
        ISNULL(SUM(ISNULL(rl.QtyReceived, 0) * pod.PurchasePrice), 0) AS ReceivedValue
      FROM tblPurchaseOrderDetails pod
      LEFT JOIN (
        SELECT PurchaseDetailID, SUM(QtyReceived) AS QtyReceived
        FROM tblReceiverLog GROUP BY PurchaseDetailID
      ) rl ON rl.PurchaseDetailID = pod.PurchaseDetailID
      WHERE pod.ProjectID = @p`),
    db.request().input('p', sql.Int, projectId).query(`
      SELECT ISNULL(SUM(TotalInvoicedAmount), 0) AS Paid
      FROM vwCostingPurchasedMaterialsInvoicedRaw WHERE ProjectID = @p`),
    getProjectCosting(projectId).catch(() => null),
  ]);
  const purchased = Number(po.recordset[0].Purchased) || 0;
  const received  = Number(po.recordset[0].ReceivedValue) || 0;
  const paidAmt   = Number(paid.recordset[0].Paid) || 0;
  const estimated = costing ? Number(costing.EstMaterials) || 0 : 0;
  const actual    = costing ? Number(costing.ActMaterials) || 0 : 0;
  const leftToPay = Math.max(0, purchased - paidAmt);
  const etc       = Math.max(0, estimated - purchased);
  return {
    job: projectId,
    estimated, actual, purchased, received, paid: paidAmt, leftToPay, etc,
    projection: purchased + etc,
    pctPaid:      purchased ? Math.round((paidAmt  / purchased) * 100) : 0,
    pctReceived:  purchased ? Math.round((received / purchased) * 100) : 0,
    pctOfEstimate: estimated ? Math.round((purchased / estimated) * 100) : null,
    generatedAt: new Date().toISOString(),
  };
}

/** PO detail lines (with received qty) for a set of ETO project IDs. */
async function getPoDetailsMulti(projectIds) {
  if (!projectIds || projectIds.length === 0) return [];
  const db = await getPool();
  const req = db.request();
  const placeholders = projectIds.map((id, i) => {
    req.input('pid' + i, sql.Int, id);
    return '@pid' + i;
  }).join(',');
  const result = await req.query(`
    SELECT
      pod.ProjectID,
      poh.PurchaseOrderID,
      poh.PurchaseDate,
      poh.PurchaseDateRequired,
      poh.PurchaseDateRevised,
      c.CName AS Supplier,
      pod.PurchaseDetailID,
      pod.ItemID,
      eim.ItemCompanyID   AS PartNumber,
      eim.ItemDescription AS PartDesc,
      eim.Manufacturer    AS Manufacturer,
      pod.PurchaseQty,
      pod.PurchasePrice,
      pod.DateRequired,
      pod.DateRevised,
      ISNULL((
        SELECT SUM(rl.QtyReceived) FROM tblReceiverLog rl
        WHERE rl.PurchaseDetailID = pod.PurchaseDetailID
      ), 0) AS ReceivedQty,
      (
        SELECT TOP 1 rl2.[Date] FROM tblReceiverLog rl2
        WHERE rl2.PurchaseDetailID = pod.PurchaseDetailID
        ORDER BY rl2.[Date] DESC
      ) AS LastReceivedDate
    FROM tblPurchaseOrderDetails pod
    JOIN tblPurchaseOrderHeader poh ON pod.PurchaseOrderID = poh.PurchaseOrderID
    JOIN tblCompany c               ON poh.PurchaseSupplierID = c.CompanyID
    JOIN tblEngItemMaster eim       ON pod.ItemID = eim.ItemID
    WHERE pod.ProjectID IN (${placeholders})
      AND eim.ItemCompanyID NOT IN ('Shipping', 'FEE', 'TARIFF')
    ORDER BY poh.PurchaseOrderID
  `);
  return result.recordset;
}

// ── BOM / readiness (Procurement page) ───────────────────────────────────────
// Ported from the Build Readiness Report app: walk the engineering BOM per
// spec, mark every leaf part received / ordered / no-PO, and roll readiness
// percentages up through the assembly tree.

async function getSpecs(projectId) {
  const db = await getPool();
  const result = await db.request()
    .input('projectId', sql.Int, projectId)
    .query(`
      SELECT SpecAutoID, SpecID, SDescription, SQuantity
      FROM tblSpec
      WHERE ProjectID = @projectId
      ORDER BY SpecID
    `);
  return result.recordset;
}

async function getTopNode(projectId, specId) {
  const db = await getPool();
  const result = await db.request()
    .input('projectId', sql.Int, projectId)
    .input('specId', sql.Int, specId)
    .query(`
      SELECT et.ItemID as TopItemID, eim.ItemCompanyID as TopPN, eim.ItemDescription as TopDesc
      FROM tblEngTop et
      JOIN tblEngItemMaster eim ON et.ItemID = eim.ItemID
      WHERE et.ProjectID = @projectId AND et.SpecID = @specId
    `);
  return result.recordset[0] || null;
}

async function getBomRows(projectId, specId) {
  const db = await getPool();
  const result = await db.request()
    .input('projectId', sql.Int, projectId)
    .input('specId', sql.Int, specId)
    .query(`
      SELECT
        eps.ChildID,
        child.ItemCompanyID   AS ChildPN,
        child.ItemDescription AS ChildDesc,
        child.Manufacturer    AS Manufacturer,
        cat.CategoryDescription AS Category,
        eps.ParentID,
        parent.ItemCompanyID  AS ParentPN,
        eps.ItemQty,
        eps.ItemHold,
        eps.RequiredDate,
        ISNULL((
          SELECT TOP 1 pod3.PurchasePrice
          FROM tblPurchaseOrderDetails pod3
          WHERE pod3.ProjectID = @projectId AND pod3.ItemID = eps.ChildID AND pod3.PurchasePrice > 0
          ORDER BY pod3.PurchaseDetailID DESC
        ), 0) AS UnitPrice,
        ISNULL((
          SELECT SUM(pod.PurchaseQty)
          FROM tblPurchaseOrderDetails pod
          WHERE pod.ProjectID = @projectId AND pod.ItemID = eps.ChildID
        ), 0) AS POQty,
        ISNULL((
          SELECT SUM(rl.QtyReceived)
          FROM tblReceiverLog rl
          JOIN tblPurchaseOrderDetails pod2 ON rl.PurchaseDetailID = pod2.PurchaseDetailID
          WHERE pod2.ProjectID = @projectId AND pod2.ItemID = eps.ChildID
        ), 0) AS ReceivedQty,
        -- Qty pulled from SDC inventory/stock for this job (no PO). Fulfilled
        -- pulls are physically in the factory, so they count toward "have it"
        -- the same as a PO receipt — otherwise stock parts read as "no PO".
        ISNULL((
          SELECT SUM(ip.PullQty)
          FROM vwCostingInventoryPullsRaw ip
          WHERE ip.ProjectID = @projectId AND ip.ItemID = eps.ChildID AND ip.FulfilledStatus = 1
        ), 0) AS PulledQty
      FROM tblEngProductStructure eps
      JOIN tblEngItemMaster child  ON eps.ChildID  = child.ItemID
      JOIN tblEngItemMaster parent ON eps.ParentID = parent.ItemID
      LEFT JOIN tlkpItemMaster_Categories cat ON child.ItemCategory = cat.ItemCategory
      WHERE eps.ProjectID = @projectId AND eps.SpecID = @specId
      ORDER BY parent.ItemCompanyID, child.ItemCompanyID
    `);
  return result.recordset;
}

// Flat BOM rows → { assemblyIds, childrenMap } (deduped by child+parent pair).
function _buildTree(rows) {
  const seen = new Set();
  const deduped = rows.filter(r => {
    const k = `${r.ChildID}-${r.ParentID}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const assemblyIds = new Set(deduped.map(r => r.ParentID));
  const childrenMap = {};
  deduped.forEach(r => {
    (childrenMap[r.ParentID] = childrenMap[r.ParentID] || []).push(r);
  });
  return { assemblyIds, childrenMap, deduped };
}

// Raw-BOM-row helpers: a part is "in hand" if it's been received on a PO OR
// pulled from SDC inventory/stock. Stock pulls have no PO, so without this a
// part sitting in the factory (pulled from stock) reads as "no PO".
function _pulled(r) { return Number(r.PulledQty) || 0; }
function _inHand(r) { return (Number(r.ReceivedQty) || 0) + _pulled(r); }

function _leafParts(nodeId, childrenMap, assemblyIds, visited = new Set()) {
  if (visited.has(nodeId)) return [];
  visited.add(nodeId);
  const parts = [];
  (childrenMap[nodeId] || []).forEach(child => {
    if (assemblyIds.has(child.ChildID)) parts.push(..._leafParts(child.ChildID, childrenMap, assemblyIds, visited));
    else parts.push(child);
  });
  return parts;
}

function _assemblyStats(nodeId, childrenMap, assemblyIds) {
  // Dedupe leaf parts by ChildID — the same part used in two places counts once.
  const unique = Object.values(
    _leafParts(nodeId, childrenMap, assemblyIds).reduce((acc, p) => { acc[p.ChildID] = acc[p.ChildID] || p; return acc; }, {})
  );
  const total = unique.length;
  const received = unique.filter(p => _inHand(p) >= p.ItemQty).length;
  // "No PO" only when there is genuinely no source: no PO, no stock pull, not in.
  const noPO = unique.filter(p => p.POQty === 0 && _pulled(p) === 0 && _inHand(p) < p.ItemQty && !p.ItemHold).length;
  const ordered = unique.filter(p => _inHand(p) < p.ItemQty && (p.POQty > 0 || _pulled(p) > 0)).length;
  // Material cost = qty × latest PO unit price. In-house parts without a PO
  // price contribute $0, so this reads as "purchased materials" per assembly.
  const cost = unique.reduce((s, p) => s + (Number(p.ItemQty) || 0) * (Number(p.UnitPrice) || 0), 0);
  return { total, received, noPO, ordered, cost: Math.round(cost), pct: total ? Math.round((received / total) * 100) : 0 };
}

function _partJson(child) {
  const pulled = _pulled(child);
  const inHand = _inHand(child);
  // In hand from stock (pulled) with no PO receipt → flag so the UI can label it
  // "in stock" rather than "received".
  const inStock = inHand >= child.ItemQty && (Number(child.ReceivedQty) || 0) < child.ItemQty && pulled > 0;
  return {
    id: child.ChildID,
    pn: child.ChildPN,
    desc: child.ChildDesc,
    manufacturer: child.Manufacturer,
    category: child.Category || null,
    qty: child.ItemQty,
    poQty: child.POQty,
    receivedQty: child.ReceivedQty,
    pulledQty: pulled,
    inStock,
    hold: !!child.ItemHold,
    unitPrice: child.UnitPrice || 0,
    requiredDate: child.RequiredDate ? new Date(child.RequiredDate).toISOString().slice(0, 10) : null,
    status: inHand >= child.ItemQty ? 'received' : (child.POQty > 0 || pulled > 0) ? 'ordered' : 'noPO',
  };
}

function _nestedNode(nodeId, pn, desc, qty, childrenMap, assemblyIds) {
  const isAssembly = assemblyIds.has(nodeId);
  const node = { id: nodeId, pn: pn || '???', desc: desc || '', qty: qty || 1, isAssembly, children: [], parts: [] };
  if (isAssembly) {
    node.stats = _assemblyStats(nodeId, childrenMap, assemblyIds);
    (childrenMap[nodeId] || []).forEach(child => {
      if (assemblyIds.has(child.ChildID)) node.children.push(_nestedNode(child.ChildID, child.ChildPN, child.ChildDesc, child.ItemQty, childrenMap, assemblyIds));
      else node.parts.push(_partJson(child));
    });
  }
  return node;
}

/**
 * AP-invoice date per PO line for a project: PurchaseDetailID → latest APDocDate
 * (ISO). Source of the parts list's "Invoiced" date. A line invoiced in pieces
 * takes its most recent invoice date.
 */
async function getInvoiceDates(projectId) {
  const db = await getPool();
  const r = await db.request()
    .input('projectId', sql.Int, projectId)
    .query(`
      SELECT PurchaseDetailID, MAX(APDocDate) AS InvoicedDate
      FROM vwCostingPurchasedMaterialsInvoicedRaw
      WHERE ProjectID = @projectId AND APDocDate IS NOT NULL
      GROUP BY PurchaseDetailID
    `);
  const m = {};
  for (const row of r.recordset) m[row.PurchaseDetailID] = isoDate(row.InvoicedDate);
  return m;
}

/**
 * Full procurement readiness for one ETO project. Per spec: the top-level
 * assemblies (machines) as nested trees with stats, plus top-level loose
 * parts. Job totals roll up unique leaf parts across all specs.
 */
async function getReadiness(projectId) {
  const [info, specs, poRows, invByDetail] = await Promise.all([
    getProjectInfo(projectId),
    getSpecs(projectId),
    getPoDetailsMulti([projectId]).catch(() => []),
    getInvoiceDates(projectId).catch(() => ({})),
  ]);
  if (!specs || specs.length === 0) return null;

  // ItemID → latest AP-invoice date across that item's PO lines.
  const invByItem = {};
  for (const r of poRows) {
    const d = invByDetail[r.PurchaseDetailID];
    if (d && (!invByItem[r.ItemID] || d > invByItem[r.ItemID])) invByItem[r.ItemID] = d;
  }

  // ItemID → first PO line (PO #, order date, expected date) for the parts list.
  const poIndex = {};
  for (const r of poRows) {
    if (!poIndex[r.ItemID]) {
      poIndex[r.ItemID] = {
        poId: r.PurchaseOrderID,
        supplier: r.Supplier || null,
        orderDate: isoDate(r.PurchaseDate),
        expDate: isoDate(r.DateRevised || r.DateRequired || r.PurchaseDateRevised || r.PurchaseDateRequired),
      };
    }
  }

  const specReports = [];
  const partsList = []; // flat: every leaf-part occurrence with assembly context
  const jobUnique = {}; // ChildID → part (for job-level totals)

  function collectParts(node, specId) {
    for (const p of node.parts) {
      const po = poIndex[p.id] || null;
      // Attach poId to the part in the tree structure (for Assemblies view)
      p.poId = po ? po.poId : null;
      p.supplier = po ? po.supplier : null;
      p.orderDate = po ? po.orderDate : null;
      p.invoicedDate = invByItem[p.id] || null;
      p.expDate = po ? po.expDate : null;
      // Also add to flat partsList (for Parts List view)
      partsList.push({
        ...p,
        specId,
        parentPN: node.pn === '???' ? 'LOOSE' : node.pn,
        parentDesc: node.desc || '',
      });
    }
    node.children.forEach(c => collectParts(c, specId));
  }

  for (const spec of specs) {
    const [topNode, bomRows] = await Promise.all([
      getTopNode(projectId, spec.SpecID),
      getBomRows(projectId, spec.SpecID),
    ]);
    if (!topNode || bomRows.length === 0) continue;

    const { assemblyIds, childrenMap, deduped } = _buildTree(bomRows);
    deduped.forEach(r => { if (!assemblyIds.has(r.ChildID)) jobUnique[r.ChildID] = jobUnique[r.ChildID] || r; });

    const tree = _nestedNode(topNode.TopItemID, topNode.TopPN, topNode.TopDesc, 1, childrenMap, assemblyIds);
    const assemblies = tree.children; // each top-level child of TOP = a machine/assembly
    if (tree.parts.length > 0) {
      const loose = tree.parts;
      const received = loose.filter(p => p.status === 'received').length;
      assemblies.push({
        id: `loose-${spec.SpecID}`, pn: 'Loose Parts',
        desc: 'Individual parts not assigned to an assembly', qty: 1, isAssembly: true,
        stats: {
          total: loose.length, received,
          noPO: loose.filter(p => p.status === 'noPO' && !p.hold).length,
          ordered: loose.filter(p => p.status === 'ordered').length,
          cost: Math.round(loose.reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.unitPrice) || 0), 0)),
          pct: loose.length ? Math.round((received / loose.length) * 100) : 0,
        },
        children: [], parts: loose,
      });
    }
    assemblies.forEach(a => collectParts(a, spec.SpecID));
    specReports.push({ specId: spec.SpecID, specName: spec.SDescription, assemblies });
  }

  const uniqueParts = Object.values(jobUnique);
  const totals = {
    parts: uniqueParts.length,
    received: uniqueParts.filter(p => _inHand(p) >= p.ItemQty).length,
    noPO: uniqueParts.filter(p => p.POQty === 0 && _pulled(p) === 0 && _inHand(p) < p.ItemQty && !p.ItemHold).length,
    ordered: uniqueParts.filter(p => _inHand(p) < p.ItemQty && (p.POQty > 0 || _pulled(p) > 0)).length,
    cost: Math.round(uniqueParts.reduce((s, p) => s + (Number(p.ItemQty) || 0) * (Number(p.UnitPrice) || 0), 0)),
  };
  totals.pct = totals.parts ? Math.round((totals.received / totals.parts) * 100) : 0;

  return {
    job: projectId,
    projectName: info ? info.ProjectName : `Project ${projectId}`,
    totals,
    specs: specReports,
    partsList,
    generatedAt: new Date().toISOString(),
  };
}

/** Distinct ETO project IDs that still have at least one undelivered PO line. */
async function getOpenPoJobs() {
  const db = await getPool();
  const result = await db.request().query(`
    SELECT DISTINCT pod.ProjectID
    FROM tblPurchaseOrderDetails pod
    OUTER APPLY (SELECT SUM(rl.QtyReceived) q FROM tblReceiverLog rl WHERE rl.PurchaseDetailID = pod.PurchaseDetailID) rcv
    WHERE pod.ProjectID IS NOT NULL AND pod.PurchaseQty > ISNULL(rcv.q, 0)
  `);
  return result.recordset.map(r => r.ProjectID);
}

/** Line items on one PO — for the expandable parts view in the tracker. */
async function getPoLines(projectId, poId) {
  const db = await getPool();
  const result = await db.request()
    .input('projectId', sql.Int, projectId)
    .input('poId', sql.Int, poId)
    .query(`
      SELECT
        pod.PurchaseDetailID,
        eim.ItemCompanyID   AS PartNumber,
        eim.ItemDescription AS PartDesc,
        eim.Manufacturer    AS Manufacturer,
        pod.PurchaseQty,
        pod.PurchasePrice,
        pod.DateRequired,
        pod.DateRevised,
        ISNULL((
          SELECT SUM(rl.QtyReceived) FROM tblReceiverLog rl
          WHERE rl.PurchaseDetailID = pod.PurchaseDetailID
        ), 0) AS ReceivedQty,
        (
          SELECT TOP 1 rl2.[Date] FROM tblReceiverLog rl2
          WHERE rl2.PurchaseDetailID = pod.PurchaseDetailID
          ORDER BY rl2.[Date] DESC
        ) AS LastReceivedDate
      FROM tblPurchaseOrderDetails pod
      JOIN tblEngItemMaster eim ON pod.ItemID = eim.ItemID
      WHERE pod.ProjectID = @projectId AND pod.PurchaseOrderID = @poId
        AND eim.ItemCompanyID NOT IN ('Shipping', 'FEE', 'TARIFF')
      ORDER BY eim.ItemCompanyID
    `);
  return result.recordset.map(l => ({
    partNumber: l.PartNumber,
    desc: l.PartDesc,
    manufacturer: l.Manufacturer,
    qty: l.PurchaseQty,
    received: l.ReceivedQty,
    price: l.PurchasePrice,
    dateRequired: isoDate(l.DateRequired),
    dateRevised: isoDate(l.DateRevised),
    lastReceived: isoDate(l.LastReceivedDate),
    status: l.ReceivedQty >= l.PurchaseQty ? 'received' : 'open',
  }));
}

/**
 * Vendor Status for one job — POs grouped by supplier with received progress,
 * mirroring the Build Readiness app's Vendor Status view. Each PO carries its
 * line items so the UI can expand a PO inline. Built from one PO-details query.
 */
async function getVendorStatus(projectId) {
  const rows = await getPoDetailsMulti([projectId]);
  const now = Date.now();
  const byVendor = {};
  for (const r of rows) {
    const vname = r.Supplier || 'Unknown';
    const v = byVendor[vname] || (byVendor[vname] = { name: vname, pos: {} });
    const poKey = String(r.PurchaseOrderID);
    const po = v.pos[poKey] || (v.pos[poKey] = { po: poKey, poDate: isoDate(r.PurchaseDate), lines: [] });
    const due = r.DateRevised || r.DateRequired || r.PurchaseDateRevised || r.PurchaseDateRequired;
    po.lines.push({
      partNumber: r.PartNumber, desc: r.PartDesc, manufacturer: r.Manufacturer,
      qty: r.PurchaseQty, received: r.ReceivedQty, price: r.PurchasePrice,
      ordered: isoDate(r.PurchaseDate), expected: isoDate(due),
      receivedDate: isoDate(r.LastReceivedDate),
      status: r.ReceivedQty >= r.PurchaseQty ? 'received' : 'open',
    });
  }

  const overdue = (l) => l.status === 'open' && l.expected && new Date(l.expected).getTime() < now;
  const vendors = Object.values(byVendor).map(v => {
    const pos = Object.values(v.pos).map(po => {
      const total = po.lines.length;
      const received = po.lines.filter(l => l.status === 'received').length;
      const anyOverdue = po.lines.some(overdue);
      po.itemCount = total;
      po.received = received;
      po.pct = total ? Math.round((received / total) * 100) : 0;
      po.price = po.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
      po.status = received === total ? 'received' : anyOverdue ? 'pastdue' : 'open';
      // Representative dates for the card: when fully received → latest
      // arrival date; otherwise → latest expected (ETA) of the open lines.
      const maxDate = (arr) => arr.filter(Boolean).sort().slice(-1)[0] || null;
      po.receivedDate = maxDate(po.lines.map(l => l.receivedDate));
      po.eta = maxDate(po.lines.filter(l => l.status === 'open').map(l => l.expected));
      return po;
    });
    pos.sort((a, b) => (a.status === 'received' ? 1 : 0) - (b.status === 'received' ? 1 : 0) || Number(a.po) - Number(b.po));
    const itemCount = pos.reduce((s, p) => s + p.itemCount, 0);
    const receivedItems = pos.reduce((s, p) => s + p.received, 0);
    const anyOverdue = pos.some(p => p.status === 'pastdue');
    return {
      name: v.name, poCount: pos.length, itemCount, receivedItems,
      pct: itemCount ? Math.round((receivedItems / itemCount) * 100) : 0,
      status: receivedItems === itemCount ? 'received' : anyOverdue ? 'pastdue' : 'open',
      pos,
    };
  });
  // Incomplete vendors first (past-due, then open), then received; ties by name.
  const rank = { pastdue: 0, open: 1, received: 2 };
  vendors.sort((a, b) => rank[a.status] - rank[b.status] || a.pct - b.pct || a.name.localeCompare(b.name));
  return { job: projectId, vendors, generatedAt: new Date().toISOString() };
}

// ── Vendor PO sync (ETO → scheduler MySQL) ───────────────────────────────────

// Formats in UTC (toISOString), and that is CORRECT here — do not "fix" it to
// local time. This was changed to local Y/M/D on 2026-08-26 and reverted the
// same day, because local time is off by one for every date ETO stores.
//
// ETO keeps these as SQL Server datetimes at midnight — a date, no time-of-day.
// Verified by asking SQL Server to render them itself:
//
//   stored in SQL Server : 2026-09-11 00:00:00
//   driver Date object   : Thu Sep 10 2026 20:00:00 GMT-0400
//   toISOString slice    : 2026-09-11   <- the stored date
//   local Y/M/D          : 2026-09-10   <- a day early
//
// The mssql driver reads a SQL Server datetime as UTC, so midnight comes back
// as 20:00 the PREVIOUS evening in Eastern. That 20:00 is an artifact of the
// conversion, not a real evening timestamp — which is exactly what fooled the
// earlier change. Reading local components then throws the day away.
//
// Same for tblReceiverLog.Date (PO receipts): stored 2026-08-26 00:00:00,
// correct as 2026-08-26, a day early as local. So UTC it is, for every date
// this helper produces — PO date, ETA, delivery, receipt.
function isoDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
}

/**
 * Pull PO lines from ETO, roll them up one-row-per-PO, upsert into vendor_pos.
 *
 * scope 'linked' (default): POs for scheduler projects with a job_number —
 *   inserts everything for those jobs (complete history included).
 * scope 'all': additionally covers every ETO job that has an open PO plus
 *   every job already present in vendor_pos. New rows are only inserted for
 *   OPEN POs (no flooding with years of delivered history); existing rows
 *   always refresh, so previously-synced POs still flip to complete.
 *
 * ETA per PO = latest effective due date across outstanding lines, where
 * effective due = line DateRevised > line DateRequired > header revised >
 * header required. Buyers enter DateRevised when a vendor re-promises, so
 * it's the truthful estimate when present.
 *
 * ETO owns: vendor, po_date, eta, po_price, partial, complete,
 *           delivery_date, completed_on.
 * PMs own (never touched on existing rows): priority, pm, comments,
 *           tracking, ship_date, lead_time, sort_order.
 *
 * Calls are SERIALIZED: the manual "Sync" button and the 30-min cron could
 * otherwise overlap and both SELECT-miss then INSERT the same PO (a duplicate
 * row, since the SELECT-then-write isn't atomic). The chain below guarantees a
 * second sync waits for the first to finish, so each PO is decided once. This
 * is sufficient because the app runs as a single process (in-memory Socket.io
 * presence already depends on that).
 */
let _syncChain = Promise.resolve();
function syncVendorPOs(mysqlPool, scope = 'linked') {
  const run = _syncChain.then(
    () => _doSyncVendorPOs(mysqlPool, scope),
    () => _doSyncVendorPOs(mysqlPool, scope) // run even if the prior sync rejected
  );
  _syncChain = run.catch(() => {}); // keep the chain alive past a failure
  return run;
}

async function _doSyncVendorPOs(mysqlPool, scope = 'linked') {
  const [projects] = await mysqlPool.query(
    `SELECT DISTINCT job_number FROM projects
     WHERE job_number IS NOT NULL AND job_number != ''`
  );
  const linkedIds = new Set(
    projects.map(p => parseInt(String(p.job_number).trim(), 10)).filter(n => Number.isInteger(n) && n > 0)
  );
  const jobSet = new Set(linkedIds);
  if (scope === 'all') {
    (await getOpenPoJobs()).forEach(id => jobSet.add(id));
    const [existingJobs] = await mysqlPool.query(
      `SELECT DISTINCT job FROM vendor_pos WHERE eto_synced = 1 AND job REGEXP '^[0-9]+$'`
    );
    existingJobs.forEach(r => jobSet.add(parseInt(r.job, 10)));
  }
  const jobIds = [...jobSet];
  if (jobIds.length === 0) return { jobs: 0, pos: 0, created: 0, updated: 0, scope };

  const lines = await getPoDetailsMulti(jobIds);

  // Roll line-level rows up to one record per PO
  const byPo = new Map();
  for (const r of lines) {
    const key = `${r.PurchaseOrderID}|${r.ProjectID}`;
    if (!byPo.has(key)) {
      byPo.set(key, {
        po: String(r.PurchaseOrderID),
        job: String(r.ProjectID),
        vendor: r.Supplier || null,
        po_date: isoDate(r.PurchaseDate),
        headerDue: r.PurchaseDateRevised || r.PurchaseDateRequired,
        headerReq: r.PurchaseDateRequired,
        lines: [],
      });
    }
    byPo.get(key).lines.push(r);
  }

  let created = 0, updated = 0;
  for (const agg of byPo.values()) {
    const total = agg.lines.length;
    const fullyRcvd = agg.lines.filter(l => l.ReceivedQty >= l.PurchaseQty).length;
    const complete = total > 0 && fullyRcvd === total ? 1 : 0;
    const partial = !complete && fullyRcvd > 0 ? 1 : 0;
    // ETA = latest effective due date across outstanding lines, else header.
    // Effective due prefers the buyer-entered revised date over the original.
    const dueDates = agg.lines
      .filter(l => complete ? true : l.ReceivedQty < l.PurchaseQty)
      .map(l => l.DateRevised || l.DateRequired || agg.headerDue).filter(Boolean)
      .map(d => new Date(d).getTime()).filter(t => !isNaN(t));
    const eta = dueDates.length ? isoDate(new Date(Math.max(...dueDates))) : isoDate(agg.headerDue);
    // Same rollup ignoring revisions — the original promise. When it differs
    // from eta, the tracker row shows a "slipped from X" marker.
    const origDates = agg.lines
      .filter(l => complete ? true : l.ReceivedQty < l.PurchaseQty)
      .map(l => l.DateRequired || agg.headerReq).filter(Boolean)
      .map(d => new Date(d).getTime()).filter(t => !isNaN(t));
    const etaOriginal = origDates.length ? isoDate(new Date(Math.max(...origDates))) : isoDate(agg.headerReq);
    const poPrice = agg.lines.reduce((s, l) => s + (Number(l.PurchaseQty) || 0) * (Number(l.PurchasePrice) || 0), 0);
    const lastRcvd = agg.lines.map(l => l.LastReceivedDate).filter(Boolean)
      .map(d => new Date(d).getTime()).filter(t => !isNaN(t));
    const deliveryDate = complete && lastRcvd.length ? isoDate(new Date(Math.max(...lastRcvd))) : null;

    const [[existing]] = await mysqlPool.query(
      'SELECT * FROM vendor_pos WHERE po = ? AND job = ? LIMIT 1', [agg.po, agg.job]
    );

    // In 'all' scope, only OPEN POs create new rows — delivered history from
    // unlinked jobs stays out of the tracker. Linked jobs keep full history.
    if (!existing && scope === 'all' && complete && !linkedIds.has(parseInt(agg.job, 10))) continue;

    if (!existing) {
      await mysqlPool.query(
        `INSERT INTO vendor_pos (po, job, vendor, po_date, eta, eta_original, po_price, partial, complete, delivery_date, completed_on, eto_synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [agg.po, agg.job, agg.vendor, agg.po_date, eta, etaOriginal, poPrice ? poPrice.toFixed(2) : null,
         partial, complete, deliveryDate, complete ? deliveryDate : null]
      );
      created++;
    } else {
      await mysqlPool.query(
        `UPDATE vendor_pos SET vendor = ?, po_date = ?, eta = ?, eta_original = ?, po_price = ?,
           partial = ?, complete = ?, delivery_date = ?, completed_on = ?, eto_synced = 1
         WHERE id = ?`,
        [agg.vendor ?? existing.vendor, agg.po_date ?? existing.po_date, eta ?? existing.eta,
         etaOriginal ?? existing.eta_original,
         poPrice ? poPrice.toFixed(2) : existing.po_price,
         partial, complete, deliveryDate ?? existing.delivery_date,
         complete ? (deliveryDate ?? existing.completed_on) : null,
         existing.id]
      );
      updated++;
    }
  }

  return { jobs: jobIds.length, pos: byPo.size, created, updated, scope };
}

// ── Shop Parts ← ETO receiving (2026-08-26) ──────────────────────────────────
//
// Marks a "Parts in Shop" row complete once the vendor PO it is linked to has
// been received in ETO. Read-only against ETO, same as everything else here.
//
// WHY THIS IS OPT-IN, AND WHY THAT IS THE WHOLE DESIGN
//
// Only rows with a non-empty `eto_po` are considered. That is not a
// convenience — it is the correctness mechanism. Measured when this was built:
// 58 of 61 shop parts are FABRICATED in the shop and have no PO in ETO at all
// (1131-CB-040 has zero PO lines because nobody buys it). Only the farmed-out
// minority — outside machining, anodizing — arrive on a PO. A blanket
// "received in ETO -> complete" rule would have to infer which kind each row
// is; requiring a human to name the PO removes the inference entirely.
//
// Keying on (PO, part number) rather than part number alone is the second half.
// Part numbers are reused across orders. Real case: 1147-FB-003 was fully
// received on PO 104448 on 2026-04-21, and a NEW shop_parts row for the same
// part number was created 2026-08-26 for a re-order. A part-number-only match
// would have closed the new row off the four-month-old receipt on the next
// 30-minute tick. Naming the PO makes that impossible.
//
// RULES, all deliberate:
//   * Never un-completes. A person's tick is never reverted by a sync — the
//     only transition this performs is 0 -> 1.
//   * The receipt must not predate the row. Belt-and-braces behind the PO key,
//     for the case where a PM links an older PO by mistake.
//   * Sums qty across lines. One shop part regularly spans several PO lines
//     (1147-FB-003 is 2 lines of qty 1 against shop qty 2); per-line matching
//     would never reach complete.
//   * A job that is not a single integer is SKIPPED, not guessed. Job values
//     like "1127 / 1139" and "800074 - SP" exist; parseInt("1127 / 1139")
//     silently yields 1127 and drops the other job, which is worse than not
//     matching at all.
//   * Records completed_source ('ETO PO 104448'), so the shop can always see
//     which rows closed themselves.
// `opts.dryRun` reports exactly what a real pass WOULD do and writes nothing —
// including no cache refresh. Use it before turning the auto-complete loose on a
// new batch of linked rows, and to sanity-check a PO number a PM just entered.
async function syncShopPartReceipts(mysqlPool, opts = {}) {
  const dryRun = !!opts.dryRun;
  const [rows] = await mysqlPool.query(
    `SELECT id, job, part_no, qty, part_complete, eto_po, created_at
     FROM shop_parts
     WHERE eto_po IS NOT NULL AND eto_po != ''`
  );
  const out = { linked: rows.length, matched: 0, completed: 0, skipped: 0, unmatched: 0, dryRun, detail: [] };
  if (rows.length === 0) return out;

  // Only rows whose job is a single clean ETO ProjectID can be looked up.
  const jobIds = new Set();
  const usable = [];
  for (const r of rows) {
    const job = String(r.job ?? '').trim();
    if (!/^\d+$/.test(job) || !r.part_no) { out.skipped++; continue; }
    jobIds.add(parseInt(job, 10));
    usable.push(r);
  }
  if (usable.length === 0) return out;

  const lines = await getPoDetailsMulti([...jobIds]);

  // Index PO lines by job|po|partno so each shop row is one lookup.
  const norm = (v) => String(v ?? '').trim().toUpperCase();
  const byKey = new Map();
  for (const l of lines) {
    const k = `${norm(l.ProjectID)}|${norm(l.PurchaseOrderID)}|${norm(l.PartNumber)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(l);
  }

  for (const r of usable) {
    const hits = byKey.get(`${norm(r.job)}|${norm(r.eto_po)}|${norm(r.part_no)}`);
    if (!hits || hits.length === 0) {
      // Linked to a PO that has no line for this part number. Left visible in
      // the UI as "not found on that PO" rather than silently ignored — it
      // usually means a typo in the PO number.
      out.unmatched++;
      out.detail.push({ id: r.id, part_no: r.part_no, po: r.eto_po, result: 'not on that PO' });
      if (dryRun) continue;
      await mysqlPool.query(
        `UPDATE shop_parts SET eto_received_qty = NULL, eto_po_qty = NULL,
           eto_received_on = NULL, eto_hold_reason = NULL, eto_synced_at = NOW() WHERE id = ?`, [r.id]
      );
      continue;
    }
    out.matched++;

    const poQty    = hits.reduce((s, l) => s + (Number(l.PurchaseQty) || 0), 0);
    const rcvdQty  = hits.reduce((s, l) => s + (Number(l.ReceivedQty) || 0), 0);
    const rcvdMs   = hits.map(l => l.LastReceivedDate).filter(Boolean)
      .map(d => new Date(d).getTime()).filter(t => !isNaN(t));
    const rcvdOn   = rcvdMs.length ? isoDate(new Date(Math.max(...rcvdMs))) : null;

    // Target = the shop's own qty when set, else what the PO ordered. The shop
    // qty is what the page shows and what the PM cares about.
    const target = Number(r.qty) > 0 ? Number(r.qty) : poQty;
    const fully  = target > 0 && rcvdQty >= target;

    // The receipt must postdate the row. See header: guards a mistyped older PO.
    const rowMs  = r.created_at ? new Date(r.created_at).getTime() : null;
    const fresh  = !rowMs || !rcvdMs.length || Math.max(...rcvdMs) >= rowMs;

    if (fully && fresh && !r.part_complete) {
      out.completed++;
      out.detail.push({ id: r.id, part_no: r.part_no, po: r.eto_po,
        result: 'AUTO-COMPLETE', received: `${rcvdQty}/${target}`, on: rcvdOn });
      if (dryRun) continue;
      await mysqlPool.query(
        `UPDATE shop_parts SET eto_received_qty = ?, eto_po_qty = ?, eto_received_on = ?,
           eto_hold_reason = NULL, eto_synced_at = NOW(), part_complete = 1,
           completed_on = ?, completed_source = ?
         WHERE id = ?`,
        [rcvdQty, poQty, rcvdOn, rcvdOn, `ETO PO ${r.eto_po}`, r.id]
      );
    } else {
      // Refresh the cache only. Note part_complete is untouched here — a row a
      // person already ticked stays ticked even if ETO shows nothing received.
      //
      // The hold is PERSISTED rather than left for the UI to infer from
      // "fully received but still open". Inferring it would misread two other
      // states as held: the moment after someone un-ticks a legitimately
      // received part, and any row mid-pass before this sync has run. Storing
      // the reason means the badge shows a hold only when the sync actually
      // declined to complete the row, and it doubles as the explanation text.
      const hold = (!r.part_complete && fully && !fresh) ? 'receipt predates part' : null;
      out.detail.push({ id: r.id, part_no: r.part_no, po: r.eto_po,
        result: r.part_complete ? 'already complete' : (hold ? `HELD: ${hold}` : 'open'),
        received: `${rcvdQty}/${target}`, on: rcvdOn });
      if (dryRun) continue;
      await mysqlPool.query(
        `UPDATE shop_parts SET eto_received_qty = ?, eto_po_qty = ?, eto_received_on = ?,
           eto_hold_reason = ?, eto_synced_at = NOW() WHERE id = ?`,
        [rcvdQty, poQty, rcvdOn, hold, r.id]
      );
    }
  }
  return out;
}

// ── Manufacturing: in-house tasks (2026-08-26) ───────────────────────────────
//
// Total ETO's own "In House Tasks" grid (Manufacturing menu), read straight
// from the view ETO built for it. This is the authoritative list of what the
// shop has to MAKE, as opposed to shop_parts which is a hand-kept list.
//
// Filters, each matching what ETO's own grid does:
//   InHouse = 1        — outsourced process lines (the "… PO" processes:
//                        Anodizing, Grinding PO, Steel Plate PO …) are somebody
//                        else's problem and belong on the vendor PO page.
//   ClosedJob = 0      — no archaeology.
//   RemainingQty > 0   — the actual "still needs making" test. Verified against
//                        Pat's screenshot: 1162-10-016 DOVETAIL SLIDE has
//                        RemainingQty 0 and is absent from his grid, while every
//                        row he does show has RemainingQty > 0.
//
// COLUMNS DELIBERATELY NOT SELECTED. Pat's grid shows Actual Hours, Required
// Hours, Extended and Total Costs. Measured 2026-08-26 across all 119 in-house
// detail rows ever written: EstimateHours, TotalHours, SetupHours and
// QuantityOrdered are populated on ZERO of them, so those four columns are
// structurally empty and always render 0. Showing them would imply the data is
// broken rather than simply unused. If the shop starts logging hours, add
// d.TotalHours / d.EstimateHours here and the UI can pick them up.
//
// What IS populated and worth having: QuantityIssued (107/119),
// QuantityReceived (96/119), LastWorkedOnDate (96/119), and on the header
// StartDate (217/229), Quantity (225/229) and OwnerEmployeeID (229/229).
// FinalRequiredDate only 100/229 — which is exactly why the Scheduler's build
// dates matter: it can supply the due date ETO is missing on over half of them.
//
// Owner is the process schedule's OWNER (who raised it — 10 of the 11 live rows
// are one engineer), NOT the machinist doing the work. ETO has no "assigned
// machinist" on these rows, so do not relabel this as an assignee.
async function getInHouseTasks() {
  const db = await getPool();
  const result = await db.request().query(`
    SELECT
      v.ProjectID,
      v.SpecID,
      -- The row's own primary key. ETO legitimately holds several process
      -- schedule lines for the same part on the same job, so ProjectID+ItemID
      -- does NOT identify a row; the caller needs this to key/trace one.
      v.ProcessScheduleDetailID,
      v.ProcessScheduleID,
      v.ProcessNumber,
      v.Sequence,
      v.ItemID,
      v.ItemCompanyID   AS PartNumber,
      i.ItemDescription AS PartDesc,
      v.ProcessName,
      h.Quantity,
      d.QuantityIssued,
      d.QuantityReceived,
      c.RemainingQty,
      h.StartDate,
      h.FinalRequiredDate,
      d.LastWorkedOnDate,
      c.HasActivePunchIns,
      e.EmpFirstName + ' ' + e.EmpLastName AS Owner
    FROM vwProcessScheduleDetailInHouse v
    JOIN tblProcessScheduleDetail d  ON d.ProcessScheduleDetailID = v.ProcessScheduleDetailID
    JOIN tblProcessScheduleHeader h  ON h.ProcessScheduleID       = v.ProcessScheduleID
    LEFT JOIN vwProcessScheduleDetailComputed c ON c.ProcessScheduleDetailID = v.ProcessScheduleDetailID
    LEFT JOIN tblEngItemMaster i     ON i.ItemID     = v.ItemID
    LEFT JOIN tblEmployee e          ON e.EmployeeID = h.OwnerEmployeeID
    WHERE v.InHouse = 1
      AND v.ClosedJob = 0
      AND ISNULL(c.RemainingQty, 0) > 0
    ORDER BY v.ProjectID, v.ProcessNumber, v.Sequence
  `);
  return result.recordset;
}

/**
 * Open purchase-order lines where WE are the supplier — the SECOND kind of
 * in-house work, alongside getInHouseTasks' process schedules.
 *
 * A PO raised against "Steven Douglas Corp." is not a purchase. It is the shop
 * being asked to make something, booked as a PO rather than as a process
 * schedule. Pat's team works both ways, so a manufacturing queue built only on
 * process schedules shows a fraction of what is actually owed: measured
 * 2026-08-26, the in-house process-schedule queue held 11 parts while there
 * were 41 open SDC-PO parts, overlapping on exactly 1. Forty parts the shop
 * owes were invisible.
 *
 * These rows are also the better-dated half. routes/manufacturing.js exists
 * largely because FinalRequiredDate is set on under half of active process
 * schedules; every sampled SDC PO line carried a DateRequired. Process
 * schedules bring progress detail, SDC POs bring firm dates.
 *
 * ── Identifying "us" ────────────────────────────────────────────────────────
 * tblCompany has no own-company flag (checked: no Own, Internal or Self column),
 * so this matches on the name, which is the business rule as stated — "any PO
 * with Steven Douglas Corp is made in house". Today that resolves to exactly
 * one row, CompanyID 1, 'Steven Douglas Corp.'. A LIKE rather than an equality
 * so the trailing punctuation cannot break it, and a subquery rather than a
 * hardcoded 1 so a second SDC entity would be picked up instead of silently
 * dropped.
 *
 * ── What is deliberately filtered ──────────────────────────────────────────
 *   vwProjects   — closed/archived jobs are excluded from that view, so this is
 *                  the PO-side equivalent of the process-schedule query's
 *                  `ClosedJob = 0`. All 47 open lines were on active jobs when
 *                  this was written, so it changes nothing today; it is here so
 *                  a reopened decade-old job cannot flood the shop's queue.
 *   Shipping/FEE/TARIFF — the same pseudo-item exclusion every other PO query
 *                  in the SDC apps uses. One open line matched.
 *   Received in full — nothing left to make.
 *
 * NOT filtered: service lines with no job-prefixed part number (e.g. a bare
 * 'Welding' line). That is still our team's labour and still owed to the job.
 */
async function getSdcPoTasks() {
  const db = await getPool();
  const result = await db.request().query(`
    SELECT
      pod.ProjectID,
      pod.SpecID,
      -- The PO line's primary key. Job 1162 carries eight separate WELDING
      -- lines (PurchaseDetailID 35914-35920 on PO 106157 plus 36874 on
      -- 106337), all ItemID 1, qty 1, same required date. They are eight real
      -- lines, not a duplication bug — verified against the raw tables — and
      -- without this key they are indistinguishable to everything downstream.
      pod.PurchaseDetailID,
      pod.ItemID,
      poh.PurchaseOrderID,
      eim.ItemCompanyID   AS PartNumber,
      eim.ItemDescription AS PartDesc,
      pod.PurchaseQty     AS Quantity,
      ISNULL(r.QtyReceived, 0) AS QuantityReceived,
      poh.PurchaseDate,
      pod.DateRequired,
      poh.PurchaseDateRequired,
      r.LastReceivedDate
    FROM tblPurchaseOrderDetails pod
    JOIN tblPurchaseOrderHeader poh ON pod.PurchaseOrderID = poh.PurchaseOrderID
    JOIN tblEngItemMaster eim       ON pod.ItemID          = eim.ItemID
    JOIN vwProjects p               ON p.ProjectID         = pod.ProjectID
    OUTER APPLY (
      SELECT SUM(rl.QtyReceived) AS QtyReceived, MAX(rl.[Date]) AS LastReceivedDate
      FROM tblReceiverLog rl
      WHERE rl.PurchaseDetailID = pod.PurchaseDetailID
    ) r
    WHERE poh.PurchaseSupplierID IN (
            SELECT CompanyID FROM tblCompany WHERE CName LIKE 'Steven Douglas%')
      AND eim.ItemCompanyID NOT IN ('Shipping', 'FEE', 'TARIFF')
      AND ISNULL(r.QtyReceived, 0) < pod.PurchaseQty
    ORDER BY pod.ProjectID, poh.PurchaseOrderID
  `);
  return result.recordset;
}

module.exports = {
  CONFIGURED,
  ping,
  getProjectInfo,
  getProjectCosting,
  getPartCost,
  getPoDetailsMulti,
  getOpenPoJobs,
  getPoLines,
  getReadiness,
  getVendorStatus,
  syncVendorPOs,
  syncShopPartReceipts,
  getInHouseTasks,
  getSdcPoTasks,
};
