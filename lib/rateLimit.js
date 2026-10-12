'use strict';
// Simple in-memory per-key limiter on FAILED attempts for public,
// unauthenticated endpoints (customer portal login). Not a security control on
// its own — a brute-force speed-bump. Extracted here so new public endpoints
// don't reimplement it; the service module's own copy is left as-is rather than
// migrated, to avoid touching an already-shipped, working feature.
function createFailureLimiter({ windowMs = 15 * 60 * 1000, maxEntries = 5000 } = {}) {
  const fails = new Map(); // key -> number[] (ms timestamps of FAILED attempts)
  const recent = (key) => {
    const now = Date.now();
    const arr = (fails.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length) fails.set(key, arr); else fails.delete(key);
    return arr;
  };
  return {
    // True once `max` failures have landed inside the window.
    blocked(key, max) { return recent(key).length >= max; },
    // A wrong password. Only these count: a person who signs in correctly,
    // signs out and back in again is not an attacker.
    fail(key) {
      const arr = recent(key); arr.push(Date.now()); fails.set(key, arr);
      if (fails.size > maxEntries) fails.clear(); // crude bound, same as the service module's copy
    },
    // A correct sign-in wipes the slate.
    clear(key) { fails.delete(key); },
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

module.exports = { createFailureLimiter, clientIp };
