'use strict';

const COMPANY_DOMAIN = '@sdcautomation.com';

// Shared-account project (2026-08-13): self-registration is company-only on both this
// app and Reports (src/lib/company-email.ts there), and the same check gates
// auto-provisioning via the SSO hand-off in routes/auth.js — so the two apps' account
// bases only ever grow in step. Case-insensitive; doesn't otherwise validate the address.
function isCompanyEmail(email) {
  return String(email).trim().toLowerCase().endsWith(COMPANY_DOMAIN);
}

module.exports = { isCompanyEmail };
