'use strict';
// SDC Tools centralized login — the entry point the Electron shell calls
// once, right after its own Azure AD (MSAL) login succeeds, to turn "this
// person signed into Microsoft" into "this person is signed into every SDC
// Tools app." Scheduler acts as the suite's identity broker because it
// already has the only real users/roles table and the only working
// cross-app SSO precedent (see lib/etcSso.js, routes/auth.js's /api/auth/sso).
//
// Two different outputs for two different situations, both minted here:
//   - schedulerToken: a completely normal Scheduler JWT via the EXISTING
//     signToken() — Scheduler's own requireAuth/requireRole need no changes
//     at all, this is issued exactly like a password login would issue one.
//   - sdcSession: a new shared token (lib/sdcSession.js) for the 4 apps that
//     have never had a login of their own (Assemblies Library, Build
//     Readiness Report, State Logic Builder, Calendar) — each carries a
//     small shared verification middleware (sdcSessionAuth.js) instead.
//
// Mounted PUBLIC (before the global requireAuth guard in server.js) for the
// same reason /api/auth/sso is: this endpoint IS the authentication step.
const { Router } = require('express');
const { verifyEntraIdToken, ENTRA_CONFIGURED } = require('../lib/entraVerify');
const { mintSdcSession, SDC_SESSION_CONFIGURED } = require('../lib/sdcSession');
const { isCompanyEmail } = require('../lib/companyEmail');
const { nameFromEmail } = require('../lib/nameFromEmail');

// Apps with no role concept of their own — any verified company account gets
// access. Narrower than today (today: anyone who can reach the LAN port),
// never broader. See PROJECT plan: real per-user roles for these only make
// sense once/if one of them grows a users table of its own.
//
// Keys match the shell's own tile IDs (shell/src/App.jsx's SKELETON_APPS),
// NOT each app's PM2 process name — 'readiness' here is Build Readiness
// Report (PM2 name sdc-readiness), so the shell can filter tiles straight
// off this object without a second translation table.
const FLAT_ACCESS_APPS = ['assemblies', 'readiness', 'statelogic'];

function _randomAvatarColor() {
  const colors = ['#1574c4', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#dc2626', '#9333ea', '#0d9488'];
  return colors[Math.floor(Math.random() * colors.length)];
}

module.exports = function createRouter({ pool, io, signToken, bcrypt }) {
  const router = Router();

  router.post('/api/auth/entra-exchange', async (req, res) => {
    if (!ENTRA_CONFIGURED) {
      return res.status(503).json({ error: 'Central SSO is not configured on this server (AZURE_TENANT_ID / AZURE_CLIENT_ID missing).' });
    }
    if (!SDC_SESSION_CONFIGURED) {
      return res.status(503).json({ error: 'Central SSO is not configured on this server (SDC_SESSION_SECRET missing).' });
    }

    const idToken = (req.body && req.body.idToken ? String(req.body.idToken) : '').slice(0, 8192);
    if (!idToken) return res.status(400).json({ error: 'idToken is required.' });

    let claims;
    try {
      claims = await verifyEntraIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired Microsoft sign-in.', detail: e.message });
    }

    const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Microsoft token did not include an email address.' });
    if (!isCompanyEmail(email)) {
      return res.status(403).json({ error: `${email} is not an @sdcautomation.com account.`, code: 'NOT_COMPANY_ACCOUNT' });
    }
    const name = String(claims.name || nameFromEmail(email));

    try {
      // ── Scheduler's own account — same auto-provision shape as the
      // existing etc-planner SSO hand-off in routes/auth.js, just triggered
      // by a verified Microsoft identity instead of an HMAC assertion.
      const [rows] = await pool.query('SELECT * FROM users WHERE LOWER(TRIM(email)) = ?', [email]);
      let user = rows[0] || null;
      if (!user) {
        const randomHash = await bcrypt.hash(require('crypto').randomBytes(32).toString('hex'), 12);
        const [ins] = await pool.query(
          `INSERT INTO users (email, name, password_hash, role, avatar_color) VALUES (?, ?, ?, 'viewer', ?)`,
          [email, name, randomHash, _randomAvatarColor()],
        );
        const [newRows] = await pool.query('SELECT * FROM users WHERE id = ?', [ins.insertId]);
        user = newRows[0];
        io.emit('users:updated');
      }
      if (!user.active) {
        return res.status(403).json({ error: 'This account is disabled. Ask an admin to re-enable it.', code: 'ACCOUNT_DISABLED' });
      }
      await pool.query('UPDATE users SET last_login = ? WHERE id = ?',
        [new Date().toISOString().slice(0, 19).replace('T', ' '), user.id]);

      // ── Calendar's role — read from sdc_app_roles (seeded from Calendar's
      // own users table by a one-time backfill script when Calendar is cut
      // over; defaults a brand-new person to the lowest tier in the meantime,
      // the same "unknown = least privilege" call the Scheduler SSO hand-off
      // above already makes).
      const [calRows] = await pool.query(
        'SELECT role_value FROM sdc_app_roles WHERE LOWER(TRIM(email)) = ? AND app = ?',
        [email, 'calendar'],
      );
      const calendarRole = calRows[0] ? calRows[0].role_value : 'employee';

      const apps = { scheduler: user.role, calendar: calendarRole };
      for (const app of FLAT_ACCESS_APPS) apps[app] = true;

      const schedulerToken = signToken(user);
      const sdcSession = mintSdcSession({ email: user.email, name: user.name, apps });

      res.json({
        schedulerToken,
        sdcSession,
        user: { email: user.email, name: user.name },
        apps,
      });
    } catch (e) {
      res.status(500).json({ error: 'Central sign-in failed: ' + e.message });
    }
  });

  return router;
};
