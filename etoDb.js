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
 * Full procurement readiness for one ETO project. Per spec: the top-level
 * assemblies (machines) as nested trees with stats, plus top-level loose
 * parts. Job totals roll up unique leaf parts across all specs.
 */
async function getReadiness(projectId) {
  const [info, specs, poRows] = await Promise.all([
    getProjectInfo(projectId),
    getSpecs(projectId),
    getPoDetailsMulti([projectId]).catch(() => []),
  ]);
  if (!specs || specs.length === 0) return null;

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
      partsList.push({
        ...p,
        specId,
        parentPN: node.pn === '???' ? 'LOOSE' : node.pn,
        parentDesc: node.desc || '',
        poId: po ? po.poId : null,
        supplier: po ? po.supplier : null,
        orderDate: po ? po.orderDate : null,
        expDate: po ? po.expDate : null,
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
};
