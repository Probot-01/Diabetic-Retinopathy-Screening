'use strict';

/**
 * authConfig.js -- every auth-related setting, read and validated in one place.
 *
 * Backend plan §A. Two independent switches, because they gate two different
 * kinds of client and roll out on different schedules:
 *
 *   AUTH_ENABLED=true        browser users (ophthalmologist / district_admin)
 *                            must hold a valid session cookie. Default OFF, so
 *                            the web frontends keep working while their login
 *                            screens are built (§A.8). Login itself works with
 *                            the flag off, so that work can be tested for real.
 *
 *   PHC_AUTH_ENABLED=true    PHC apps must send a valid X-PHC-Api-Key on the
 *                            ingestion routes. Default OFF, because every PHC
 *                            has to be provisioned a key (scripts/
 *                            provisionPhcKey.js) and have it in its local config
 *                            first -- flipping this before then stops all sync.
 *
 * Other settings:
 *   JWT_SECRET               required when AUTH_ENABLED=true (boot fails without
 *                            it). With auth off, a random per-process secret is
 *                            used so login can still be exercised -- sessions
 *                            then die on restart, which is fine for development.
 *   JWT_TTL_HOURS            session lifetime, default 12 (§A.10: 12-24h, no
 *                            refresh tokens).
 *   COOKIE_SECURE            default true. Browsers treat http://localhost as a
 *                            secure context, so Secure cookies still work on a
 *                            local demo; set false only for a plain-http host
 *                            that is not localhost (and then get TLS, §A.14).
 *   COOKIE_SAMESITE          lax (default) | strict | none. Must be `none` when
 *                            the frontend is on a different SITE from this
 *                            backend (e.g. *.vercel.app -> localhost), or the
 *                            browser never sends the cookie. `none` forces
 *                            Secure.
 *   CLAIM_TTL_MINUTES        how long a review claim holds before another
 *                            reviewer may take the case over (§10.8), default 30.
 */

const crypto = require('crypto');

const flag = (name, dflt = false) => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

const AUTH_ENABLED     = flag('AUTH_ENABLED');
const PHC_AUTH_ENABLED = flag('PHC_AUTH_ENABLED');

let JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  if (AUTH_ENABLED) {
    throw new Error('AUTH_ENABLED=true but JWT_SECRET is not set. Refusing to start ' +
      'with a guessable or per-process session key. Set JWT_SECRET in .env -- see ' +
      '.env.example for a one-line generator.');
  }
  JWT_SECRET = crypto.randomBytes(48).toString('base64url');
}
if (AUTH_ENABLED && JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters.');
}

const JWT_TTL_HOURS = Number(process.env.JWT_TTL_HOURS || 12);
if (!(JWT_TTL_HOURS > 0 && JWT_TTL_HOURS <= 24)) {
  throw new Error(`JWT_TTL_HOURS must be in (0, 24], got ${process.env.JWT_TTL_HOURS}.`);
}

const SAMESITE = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
if (!['lax', 'strict', 'none'].includes(SAMESITE)) {
  throw new Error(`COOKIE_SAMESITE must be lax, strict or none, got ${SAMESITE}.`);
}
// SameSite=None without Secure is rejected by every current browser.
const COOKIE_SECURE = SAMESITE === 'none' ? true : flag('COOKIE_SECURE', true);

const CLAIM_TTL_MINUTES = Number(process.env.CLAIM_TTL_MINUTES || 30);
if (!(CLAIM_TTL_MINUTES > 0)) {
  throw new Error(`CLAIM_TTL_MINUTES must be positive, got ${process.env.CLAIM_TTL_MINUTES}.`);
}

module.exports = {
  AUTH_ENABLED,
  PHC_AUTH_ENABLED,
  JWT_SECRET,
  JWT_TTL_HOURS,
  CLAIM_TTL_MINUTES,
  SESSION_COOKIE: 'ns_session',
  CSRF_HEADER: 'x-csrf-token',
  PHC_KEY_HEADER: 'x-phc-api-key',
  cookieOptions: {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: SAMESITE,
    path: '/',
    maxAge: JWT_TTL_HOURS * 3600 * 1000,
  },
  ROLES: ['ophthalmologist', 'district_admin'],
};
