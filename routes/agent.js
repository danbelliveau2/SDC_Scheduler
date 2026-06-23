'use strict';
const { Router } = require('express');

module.exports = function createRouter(deps) {
  const { pool, requireRole, agent, etoDb } = deps;
  const router = Router();

  router.get('/api/agent/status', async (_req, res) => {
    try { res.json(await agent.status()); }
    catch (e) { res.status(503).json({ reachable: false, error: e.message }); }
  });

  router.post('/api/agent/ask', requireRole('viewer'), async (req, res) => {
    const question = (req.body && req.body.question || '').toString();
    const context = req.body && req.body.context ? String(req.body.context) : '';
    const history = (req.body && Array.isArray(req.body.history)) ? req.body.history : [];
    if (!question.trim()) return res.status(400).json({ error: 'question required' });
    try { res.json(await agent.ask({ pool, etoDb, question, context, history })); }
    catch (e) { console.error('[agent] ask failed:', e.message); res.status(503).json({ error: e.message }); }
  });

  // Streaming variant — Server-Sent Events. Forwards text deltas + tool events
  // so the UI renders the answer as it's generated. Same read-only guarantees.
  router.post('/api/agent/ask-stream', requireRole('viewer'), async (req, res) => {
    const question = (req.body && req.body.question || '').toString();
    const context = req.body && req.body.context ? String(req.body.context) : '';
    const history = (req.body && Array.isArray(req.body.history)) ? req.body.history : [];
    if (!question.trim()) return res.status(400).json({ error: 'question required' });
    // Write directly to the raw socket — Express's res.write goes through several
    // middleware layers (compression, etag, etc.) that buffer on Windows/Node 25
    // and silently break SSE. Raw socket writes flush immediately.
    const sock = res.socket || (req.socket || (req.connection));
    sock.setNoDelay && sock.setNoDelay(true);
    sock.write(
      'HTTP/1.1 200 OK\r\n' +
      'Content-Type: text/event-stream\r\n' +
      'Cache-Control: no-cache, no-transform\r\n' +
      'X-Accel-Buffering: no\r\n' +
      'Connection: keep-alive\r\n' +
      '\r\n'
    );
    const send = (obj) => { try { sock.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };
    let aborted = false;
    req.on('close', () => { aborted = true; });
    try {
      await agent.askStream({ pool, etoDb, question, context, history, onEvent: (ev) => { if (!aborted) send(ev); } });
    } catch (e) {
      send({ type: 'error', error: e.message });
    } finally {
      try { sock.write('data: {"type":"close"}\n\n'); } catch (_) {}
      try { sock.end(); } catch (_) {}
    }
  });

  return router;
};
