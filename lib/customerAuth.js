'use strict';
/**
 * customerAuth.js — session auth for the customer-facing portal
 * (portal.sdcautomation.com), completely separate from staff auth
 * (lib/auth.js). A customer session must never be mistakable for a staff
 * one: different secret, different claim shape, its own middleware, and it
 * sets req.customerName — never req.authUser.
 *
 * No cookie-parser dependency: this repo is an npm workspace of the parent
 * sdc-tools monorepo (see docs/SERVICE_MODULE.md's multer note) where a new
 * dependency means committing the PARENT's lockfile too, so a hand-rolled
 * single-cookie reader/writer is simpler than pulling in a package for it.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');

const DEV_SECRET = 'sdc-customer-dev-secret-change-in-production';
const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET || DEV_SECRET;
const CUSTOMER_JWT_EXPIRES = process.env.CUSTOMER_JWT_EXPIRES || '14d';
const COOKIE_NAME = 'sdc_customer_session';

if (CUSTOMER_JWT_SECRET === DEV_SECRET) {
  console.warn(
    '[customerAuth] CUSTOMER_JWT_SECRET is not set — using an insecure ' +
    'shared default. Set a strong, stable CUSTOMER_JWT_SECRET in .env ' +
    'before any real customer account is created (a forgeable secret means ' +
    'anyone can mint a session for any customer).'
  );
}

function signCustomerToken(account) {
  return jwt.sign(
    { customerAccountId: account.id, customerName: account.customer_name, username: account.username },
    CUSTOMER_JWT_SECRET,
    { expiresIn: CUSTOMER_JWT_EXPIRES }
  );
}

function verifyCustomerToken(token) {
  try { return jwt.verify(token, CUSTOMER_JWT_SECRET); }
  catch { return null; }
}

// Minimal cookie-header parser — just splits "a=b; c=d" pairs. Values are
// URI-decoded; nothing here needs to survive a raw ';' or '=' in the value.
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  });
  return out;
}

function setCustomerSessionCookie(res, token) {
  const maxAgeSec = 14 * 24 * 60 * 60; // matches CUSTOMER_JWT_EXPIRES default; cookie outliving the JWT is harmless, the JWT itself still expires
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCustomerSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

// Sets req.customerName / req.customerAccountId — deliberately NOT
// req.authUser, so this can never be confused with a staff session by any
// code that checks that field (see lib/auth.js's requireAuth).
function requireCustomerAuth(req, res, next) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Please log in.', code: 'CUSTOMER_AUTH_REQUIRED' });
  }
  const payload = verifyCustomerToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Session expired. Please log in again.', code: 'CUSTOMER_TOKEN_EXPIRED' });
  }
  req.customerName = payload.customerName;
  req.customerAccountId = payload.customerAccountId;
  next();
}

module.exports = {
  signCustomerToken,
  verifyCustomerToken,
  parseCookies,
  setCustomerSessionCookie,
  clearCustomerSessionCookie,
  requireCustomerAuth,
  COOKIE_NAME,
};
