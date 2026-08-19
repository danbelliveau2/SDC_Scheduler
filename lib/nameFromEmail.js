'use strict';

// A placeholder display name for a Scheduler account auto-provisioned via the Reports
// SSO hand-off, where only an email is asserted — never a full name (see routes/auth.js's
// POST /api/auth/sso; the token payload is {e, x, n}). Mirrors
// sdc-etc-planner/src/lib/name-from-email.ts exactly, so a person auto-provisioned in
// either direction gets the same kind of placeholder. Splits the local part on the
// separators people actually use in a work email and title-cases each piece; falls back
// to title-casing the whole local part when there's nothing to split on. Good enough
// until the person (or an admin) sets a real one.
function nameFromEmail(email) {
  const local = String(email).trim().split('@')[0] || '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const title = (s) => (s.length > 0 ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
  return (parts.length > 0 ? parts : [local]).map(title).join(' ').trim() || 'New User';
}

module.exports = { nameFromEmail };
