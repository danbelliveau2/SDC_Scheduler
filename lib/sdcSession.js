'use strict';
// The ONE session token shared by the 4 SDC Tools apps that have no JWT of
// their own (Assemblies Library, Build Readiness Report, State Logic
// Builder, Calendar). Minted here — Scheduler acts as the suite's identity
// broker, see routes/ssoCentral.js — after the shell's Entra ID login is
// verified, and checked independently by each of those apps' own copy of
// sdcSessionAuth.js using the same shared secret.
//
// Deliberately separate from this app's OWN signToken/verifyToken in
// lib/auth.js: Scheduler already has a real JWT + role system and keeps
// using it unchanged (see routes/ssoCentral.js — it mints a normal Scheduler
// token via the existing signToken(), same as any other login). This module
// exists only for the apps that never had a token format of their own.
const jwt = require('jsonwebtoken');

const SDC_SESSION_SECRET = process.env.SDC_SESSION_SECRET || '';
const SDC_SESSION_EXPIRES = process.env.SDC_SESSION_EXPIRES || '12h';
const SDC_SESSION_CONFIGURED = Boolean(SDC_SESSION_SECRET);

if (!SDC_SESSION_CONFIGURED) {
  console.warn('[sdcSession] SDC_SESSION_SECRET is not set — the central SSO exchange endpoint will refuse to mint tokens until it is.');
}

// apps: e.g. { assemblies: true, brr: true, statelogic: true, calendar: 'manager' }
// — a flag for apps with no role concept, a role string for apps that have one.
function mintSdcSession({ email, name, apps }) {
  if (!SDC_SESSION_CONFIGURED) throw new Error('SDC_SESSION_SECRET not configured.');
  return jwt.sign({ email, name, apps: apps || {} }, SDC_SESSION_SECRET, { expiresIn: SDC_SESSION_EXPIRES });
}

function verifySdcSession(token) {
  if (!SDC_SESSION_CONFIGURED || !token) return null;
  try { return jwt.verify(token, SDC_SESSION_SECRET); }
  catch { return null; }
}

module.exports = { mintSdcSession, verifySdcSession, SDC_SESSION_CONFIGURED };
