'use strict';
require('dotenv').config();
const jwt = require('jsonwebtoken');

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const JWT_SECRET   = process.env.JWT_SECRET || 'sdc-dev-secret-change-in-production';
const JWT_EXPIRES  = '7d';

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

// Global auth middleware.
// When AUTH_ENABLED=false: stamps req.authUser with a passthrough admin identity so
// all role checks pass, and existing req.user (from X-User header) is preserved.
// When AUTH_ENABLED=true: validates Bearer token, returns 401 on failure.
// Paths that are always public regardless of AUTH_ENABLED
// /api/auth/me is intentionally NOT listed here — it must validate the token
// so callers with no/expired token get 401, and valid callers get their user identity.
const PUBLIC_PATHS = new Set(['/health', '/api/auth/login', '/api/auth/register']);

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  if (!AUTH_ENABLED) {
    // Passthrough — set a synthetic authUser so role checks work
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
  req.user     = payload.name; // keep req.user in sync for existing logHistory calls
  next();
}

// Role guard middleware factory. minRole is 'viewer' | 'editor' | 'admin'.
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
