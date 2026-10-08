'use strict';

/**
 * Technician sessions for the PHC local backend (design doc §11.1: "a real
 * authentication endpoint, checked against a stored credential hash, in every
 * application").
 *
 * Opaque bearer tokens (Authorization: Bearer <token>), used by both PHC
 * front-ends: the desktop web app and the phone. Bearer rather than cookie
 * because the phone is not a browser, and a header token is not sent by the
 * browser on its own, so CSRF does not apply. Only the token's SHA-256 is
 * stored.
 *
 * LOCAL_AUTH_ENABLED (default false, like central's AUTH_ENABLED until every
 * front-end sends a token):
 *   false -> requests without a token pass, unattributed; a token that is
 *            present but invalid or expired is still REJECTED, so a broken
 *            client fails loudly now rather than on the day it is enforced;
 *   true  -> every protected route needs a valid session.
 */
const crypto = require('crypto');
const db = require('../db/localDb');
const { verifyPassword, DUMMY_HASH } = require('./passwords');

const flag = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const LOCAL_AUTH_ENABLED = flag(process.env.LOCAL_AUTH_ENABLED);
const SESSION_HOURS = Number(process.env.LOCAL_SESSION_HOURS || 12);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();

function publicUser(u) {
  return { userId: u.user_id, username: u.username, name: u.name, role: u.role };
}

/** Checks credentials; returns the technician row or null. Constant work either way. */
function authenticate(username, password) {
  const u = db.prepare('SELECT * FROM technicians WHERE username = ? AND is_active = 1')
    .get(String(username || '').trim().toLowerCase());
  const ok = verifyPassword(String(password || ''), u ? u.password_hash : DUMMY_HASH);
  return u && ok ? u : null;
}

function issueSession(user, deviceId = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at, last_seen_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sha256(token), user.user_id, deviceId, nowIso(), expiresAt, nowIso());
  return { token, expiresAt, user: publicUser(user) };
}

/** Returns { user, session } for a live token, or null. */
function readSession(token) {
  if (!token) return null;
  const s = db.prepare(`
    SELECT s.*, t.username, t.name, t.role, t.is_active
    FROM sessions s JOIN technicians t ON t.user_id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!s || !s.is_active || s.expires_at <= nowIso()) return null;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), s.token_hash);
  return { user: { user_id: s.user_id, username: s.username, name: s.name, role: s.role }, deviceId: s.device_id };
}

function revokeSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function bearer(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

/** Records a read or write of patient data (design doc §11.1, audit logging). */
function logAccess(req, action, entityType = null, entityId = null) {
  try {
    db.prepare(`INSERT INTO access_log (at, user_id, device_id, action, entity_type, entity_id)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(nowIso(), req.user?.user_id ?? null, req.peerDevice?.device_id ?? req.sessionDeviceId ?? null,
        action, entityType, entityId);
  } catch (err) {
    console.error('[localAuth] access_log write failed:', err.message);
  }
}

module.exports = {
  LOCAL_AUTH_ENABLED, SESSION_HOURS,
  authenticate, issueSession, readSession, revokeSession, bearer, publicUser, logAccess,
};
