'use strict';
// Phase 3 (Auth) — JWT-based login + role guards. Ported from Abhi's
// feature/smartsheet-architecture branch.
//
// AUTH_ENABLED env flag controls whether the middleware actually gates the
// API. When false (default), every request gets a synthetic admin authUser
// so the existing app keeps working without anyone signed in. Flip to true
// after running `node create-admin.js` to create the first admin.
//
// Roles: viewer < editor < admin. requireRole('editor') is the typical
// guard for write endpoints; settings/admin endpoints use 'admin'.
require('dotenv').config();
const jwt = require('jsonwebtoken');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const DEV_SECRET   = 'sdc-dev-secret-change-in-production';
const JWT_SECRET   = process.env.JWT_SECRET || DEV_SECRET;
// Sessions last 30 days by default (was 7d — short expiry caused frequent
// "session expired" surprises). Override with JWT_EXPIRES in .env.
const JWT_EXPIRES  = process.env.JWT_EXPIRES || '30d';

// Fail loudly if auth is on but the signing secret is missing or left at the
// shipped dev default. A weak/shared secret means tokens are forgeable, and a
// secret that silently changes between restarts logs *everyone* out at once.
if (AUTH_ENABLED && (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEV_SECRET)) {
  throw new Error(
    '[auth] AUTH_ENABLED=true but JWT_SECRET is missing or set to the dev default. ' +
    'Set a strong, stable JWT_SECRET in .env before enabling auth (otherwise tokens are ' +
    'forgeable and every restart can invalidate sessions).'
  );
}

// Role hierarchy: higher index = more permissions
const ROLE_LEVELS = { viewer: 0, editor: 1, admin: 2 };

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role, avatar_color: user.avatar_color },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// Paths that are always public regardless of AUTH_ENABLED. /api/auth/me is
// intentionally NOT in here — it must validate the token so callers with no
// or expired token get 401, and valid callers get their user identity back.
const PUBLIC_PATHS = new Set(['/health', '/api/auth/login', '/api/auth/register']);

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  if (!AUTH_ENABLED) {
    // Passthrough — synthetic authUser so role checks pass. Existing
    // req.user (from X-User header) is preserved for logHistory attribution.
    req.authUser = {
      id: 0,
      email: 'local@sdc',
      name: req.user || 'anonymous',
      role: 'admin',
    };
    return next();
  }

  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please log in.', code: 'AUTH_REQUIRED' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' });
  }

  req.authUser = payload;
  req.user     = payload.name; // keep req.user in sync for logHistory
  next();
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (!AUTH_ENABLED) return next();
    const userLevel = ROLE_LEVELS[req.authUser?.role] ?? -1;
    const minLevel  = ROLE_LEVELS[minRole] ?? 99;
    if (userLevel < minLevel) {
      return res.status(403).json({
        error: `Requires ${minRole} role or higher. Your role: ${req.authUser?.role || 'none'}.`,
        code: 'FORBIDDEN',
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, signToken, verifyToken, AUTH_ENABLED };
