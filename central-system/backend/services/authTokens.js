'use strict';

/**
 * authTokens.js -- session JWTs and the CSRF token bound to them.
 *
 * The session travels as an httpOnly cookie (§A.1), so page script cannot read
 * or leak it, and <img> requests for fundus / Grad-CAM media carry it
 * automatically -- a Bearer header cannot be attached to an <img>.
 *
 * CSRF (§A.2): a cookie is sent by the browser on ANY request to this origin,
 * including one a hostile page triggers. So every state-changing request must
 * also carry X-CSRF-Token, and it must equal the `csrf` claim INSIDE the signed
 * JWT. The frontend gets that value from the login (or /auth/me) response body;
 * a cross-site attacker can make the browser send the cookie but cannot read
 * the response, so cannot learn the token. Because the token is inside the
 * signed session, nothing needs to be stored server-side.
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const cfg    = require('./authConfig');

function issueSession(user) {
  const csrf = crypto.randomBytes(24).toString('base64url');
  const token = jwt.sign(
    { userId: user.user_id, role: user.role, csrf },
    cfg.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: `${cfg.JWT_TTL_HOURS}h` },
  );
  const expiresAt = new Date(Date.now() + cfg.JWT_TTL_HOURS * 3600 * 1000).toISOString();
  return { token, csrfToken: csrf, expiresAt };
}

/** Returns { userId, role, csrf, exp } or null. Never throws. */
function verifySession(token) {
  if (!token) return null;
  try {
    const p = jwt.verify(token, cfg.JWT_SECRET, { algorithms: ['HS256'] });
    if (!p.userId || !cfg.ROLES.includes(p.role) || !p.csrf) return null;
    return p;
  } catch {
    return null;
  }
}

/** Constant-time string comparison; false on any length mismatch. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** SHA-256 hex of a PHC API key -- what phc_sites.api_key_hash stores. */
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

module.exports = { issueSession, verifySession, safeEqual, hashApiKey };
