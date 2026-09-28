'use strict';
// Simple in-memory per-key sliding-window rate limiter for public,
// unauthenticated endpoints. Not a security control on its own — a spam
// speed-bump, same spirit as the one already inline in routes/service.js.
// Extracted here so new public endpoints (customer portal login) don't
// reimplement it; the service module's own copy is left as-is rather than
// migrated, to avoid touching an already-shipped, working feature.
function createRateLimiter({ windowMs = 60 * 60 * 1000, maxEntries = 5000 } = {}) {
  const hits = new Map(); // key -> number[] (ms timestamps)
  return function rateLimited(key, max) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return true; }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > maxEntries) hits.clear(); // crude bound, same as the service module's copy
    return false;
  };
}

// Precedence matches routes/service.js's clientIp(): Cloudflare's header
// first (real client through the tunnel), then the nearest proxy hop, then
// the raw socket address.
function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf.slice(0, 64);
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1].slice(0, 64);
  return (req.ip || 'unknown').slice(0, 64);
}

module.exports = { createRateLimiter, clientIp };
