'use strict';
const { Router } = require('express');

// NOTE: `rank` is a reserved word in MySQL 8 — backtick every dynamic column.
// `eto_po` is the opt-in link to a Total ETO purchase order. When set, the ETO
// sync (etoDb.syncShopPartReceipts, on the 30-min ETO cron) fills the read-only
// eto_received_* cache and can auto-tick part_complete once the PO is received.
// The eto_received_*/eto_synced_at/completed_source columns are deliberately NOT
// in this list: they are owned by the sync, not editable by a client.
const SHOP_PART_FIELDS = ['rank', 'job', 'qty', 'part_no', 'description', 'shop_release', 'new_mod', 'location', 'out_for_finishing', 'priority', 'comments', 'engineer', 'pm', 'added_to_bom', 'part_complete', 'sort_order', 'eto_po'];
const _shopBool = (f) => f === 'added_to_bom' || f === 'part_complete';
const _bt = (c) => `\`${c}\``; // backtick a column name

module.exports = function createRouter(deps) {
  const { pool, io, requireRole } = deps;
  const router = Router();

  router.get('/api/shop-parts', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM shop_parts ORDER BY sort_order, `rank`, id');
      res.json(rows);
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  router.post('/api/shop-parts', requireRole('editor'), async (req, res) => {
    try {
      const b = req.body || {};
      const cols = [], vals = [];
      for (const f of SHOP_PART_FIELDS) {
        if (f in b) { cols.push(f); vals.push(_shopBool(f) ? (b[f] ? 1 : 0) : b[f]); }
      }
      if (!cols.includes('sort_order')) {
        const [[m]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM shop_parts');
        cols.push('sort_order'); vals.push(m.m + 1);
      }
      const [result] = await pool.query(`INSERT INTO shop_parts (${cols.map(_bt).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
      const [[row]] = await pool.query('SELECT * FROM shop_parts WHERE id = ?', [result.insertId]);
      res.json(row);
      io.emit('shop_parts:updated');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/api/shop-parts/:id', requireRole('editor'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT * FROM shop_parts WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'not found' });
      const updates = {};
      for (const f of SHOP_PART_FIELDS) {
        if (f in req.body) updates[f] = _shopBool(f) ? (req.body[f] ? 1 : 0) : req.body[f];
      }
      if (Object.keys(updates).length === 0) return res.json(existing);
      if ('part_complete' in updates) {
        if (updates.part_complete && !existing.part_complete) {
          updates.completed_on = new Date().toISOString();
          // A person ticking the box owns the completion. NULL completed_source
          // means "closed by a human" — that is what every row predating the ETO
          // link has, and it must overwrite any stale 'ETO PO …' attribution.
          updates.completed_source = null;
        } else if (!updates.part_complete) {
          updates.completed_on = null;
          updates.completed_source = null;
        }
      }
      // Re-pointing a row at a different PO invalidates the cached answer. Clear
      // it rather than leave the previous PO's received qty on screen until the
      // next sync tick, which would read as though the new PO were received.
      if ('eto_po' in updates && String(updates.eto_po ?? '') !== String(existing.eto_po ?? '')) {
        updates.eto_received_qty = null;
        updates.eto_po_qty = null;
        updates.eto_received_on = null;
        updates.eto_synced_at = null;
      }
      const setClause = Object.keys(updates).map(k => `${_bt(k)} = ?`).join(', ');
      await pool.query(`UPDATE shop_parts SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
      const [[row]] = await pool.query('SELECT * FROM shop_parts WHERE id = ?', [id]);
      res.json(row);
      io.emit('shop_parts:updated');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/shop-parts/:id', requireRole('editor'), async (req, res) => {
    try {
      await pool.query('DELETE FROM shop_parts WHERE id = ?', [Number(req.params.id)]);
      res.json({ ok: true });
      io.emit('shop_parts:updated');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/shop-parts/reorder', requireRole('editor'), async (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array of ids' });
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      try {
        for (let idx = 0; idx < order.length; idx++) {
          await conn.query('UPDATE shop_parts SET sort_order = ? WHERE id = ?', [idx, order[idx]]);
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        conn.release();
        return res.status(500).json({ error: err.message });
      }
      conn.release();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
