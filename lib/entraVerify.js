'use strict';
// Verifies a Microsoft Entra ID (Azure AD) ID token from the SDC Tools shell's
// own MSAL login, so this app can trust "who the shell says is logged in"
// without ever seeing a password. Same trust-boundary shape as lib/etcSso.js
// (verify an external signer's token before trusting its claims), but the
// signer here is Microsoft, not another SDC app — verification uses Entra's
// published JWKS (asymmetric, rotating keys, fetched over HTTPS and cached)
// instead of a shared HMAC secret.
//
// AZURE_TENANT_ID / AZURE_CLIENT_ID must match the SAME values already
// configured in the shell's own .env (shell/.env) — the shell requests the ID
// token from that app registration, so this only verifies successfully
// against that same tenant + audience.
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const TENANT_ID = process.env.AZURE_TENANT_ID || '';
const CLIENT_ID = process.env.AZURE_CLIENT_ID || '';
const ENTRA_CONFIGURED = Boolean(TENANT_ID && CLIENT_ID);

const jwks = ENTRA_CONFIGURED
  ? jwksClient({
      jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
      cache: true,
      cacheMaxAge: 24 * 60 * 60 * 1000,
      rateLimit: true,
    })
  : null;

function getSigningKey(header, callback) {
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

// Resolves to the verified claims (oid, email/preferred_username, name, tid)
// or rejects. Callers must still check the email domain themselves (see
// isCompanyEmail in routes/ssoCentral.js) — a valid signature only proves
// Microsoft issued the token for our app registration, not that the account
// is one we want to auto-provision.
function verifyEntraIdToken(idToken) {
  return new Promise((resolve, reject) => {
    if (!ENTRA_CONFIGURED) {
      return reject(new Error('AZURE_TENANT_ID / AZURE_CLIENT_ID not configured on this server — cannot verify Entra ID tokens.'));
    }
    if (!idToken || typeof idToken !== 'string') {
      return reject(new Error('Missing ID token.'));
    }
    jwt.verify(
      idToken,
      getSigningKey,
      {
        audience: CLIENT_ID,
        issuer: [
          `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
          `https://sts.windows.net/${TENANT_ID}/`,
        ],
        algorithms: ['RS256'],
      },
      (err, decoded) => (err ? reject(err) : resolve(decoded)),
    );
  });
}

module.exports = { verifyEntraIdToken, ENTRA_CONFIGURED };
