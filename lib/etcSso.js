'use strict';
// Outbound half of the Scheduler ↔ ETC Planner SSO hand-off — the mirror of
// the ETC Planner's own scheduler-sso.ts, which already mints tokens THIS
// app verifies in routes/auth.js's POST /api/auth/sso. This is the other
// direction: a short-lived signed assertion of WHO is currently logged into
// THIS app, so a link out to the Planner doesn't stop at its login form.
//
// Reuses SCHEDULER_SHARED_TOKEN — the secret the two apps already share for
// their server-to-server calls — rather than a new one to keep in sync. Wire
// format matches the Planner's exactly (HMAC-SHA256 over a "sso:v1:"-prefixed
// payload, same {e,x,n} claims, same 60s TTL), so its existing
// verifySchedulerSsoToken() accepts one of these with zero changes on that
// side.
const crypto = require('crypto');

const TTL_SECONDS = 60;
const DOMAIN = 'sso:v1'; // separates these tokens from any other use of the secret

function secret() {
  const s = process.env.SCHEDULER_SHARED_TOKEN || '';
  return s.length > 0 ? s : null;
}

function sign(payload, key) {
  return crypto.createHmac('sha256', key).update(DOMAIN + ':' + payload).digest('base64url');
}

// Returns null when the shared secret isn't configured — callers then link
// to the ETC Planner exactly as before, so a missing secret degrades to
// "sign in again", never a broken link.
function mintEtcSsoToken(email) {
  const key = secret();
  if (!key || !email) return null;
  const payload = Buffer.from(JSON.stringify({
    e: String(email).trim().toLowerCase(),
    x: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    n: crypto.randomBytes(9).toString('base64url'),
  })).toString('base64url');
  return payload + '.' + sign(payload, key);
}

module.exports = { mintEtcSsoToken };
