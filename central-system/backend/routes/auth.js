'use strict';

/**
 * routes/auth.js -- browser login for ophthalmologists and district admins
 * (backend plan §A.1, design doc §5.6 / §11.1).
 *
 * Mounted at /api/v1/auth.
 *
 *   POST /api/v1/auth/login   { email, password }
 *     200 { user: { userId, name, email, role }, csrfToken, expiresAt }
 *         + Set-Cookie: ns_session=<JWT>; HttpOnly; Secure; SameSite=...
 *     400 { error: 'invalid_field' }          email/password missing
 *     401 { error: 'invalid_credentials' }    SAME body for unknown email and
 *                                             wrong password, by design
 *     429 { error: 'too_many_attempts' }
 *
 *   GET  /api/v1/auth/me
 *     200 same body as login -- so a page reload can recover the user and the
 *         csrfToken, which the frontend cannot read from the httpOnly cookie
 *     401 { error: 'unauthenticated' }
 *
 *   POST /api/v1/auth/logout  -> 204, clears the cookie
 *
 * FRONTEND NOTE: every fetch must use `credentials: 'include'`, and every
 * POST/PATCH/DELETE must send `X-CSRF-Token: <csrfToken>`. <img src> needs
 * nothing extra -- the browser attaches the cookie itself.
 */

const express = require('express');
const bcrypt  = require('bcryptjs');

const pool = require('../db/pgClient');
const cfg  = require('../services/authConfig');
const { issueSession } = require('../services/authTokens');
const { readSession }  = require('../middleware/requireAuth');

const router = express.Router();

// Compared against when the email is unknown, so a miss costs the same bcrypt
// time as a wrong password and response timing does not reveal which emails
// have accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// ── Brute-force brake ─────────────────────────────────────────────────────────
// In-memory, per (ip, email): enough for a single-node demo server. Counts
// FAILURES only and resets on success.
const WINDOW_MS       = 15 * 60 * 1000;
const MAX_FAILURES    = 10;    // per (ip, email)
const MAX_PER_IP      = 50;    // per ip, across every email it tries
const failures = new Map();    // key -> { count, first }

// Two keys per attempt. The (ip, email) counter stops password guessing
// against one account; the ip-only counter stops the same client walking a
// list of emails, which the first counter alone never notices.
function attemptKeys(req, email) { return [`${req.ip}|${email}`, `ip|${req.ip}`]; }

function fresh(f) { return f && Date.now() - f.first <= WINDOW_MS; }

function isLockedOut(keys) {
  prune();
  const [byEmail, byIp] = keys.map((k) => failures.get(k));
  return (fresh(byEmail) && byEmail.count >= MAX_FAILURES)
      || (fresh(byIp) && byIp.count >= MAX_PER_IP);
}

function recordFailure(keys) {
  for (const k of keys) {
    const f = failures.get(k);
    if (!fresh(f)) failures.set(k, { count: 1, first: Date.now() });
    else f.count += 1;
  }
}

// Without this the map keeps one entry per email ever tried -- unbounded
// memory from anyone posting random addresses at the login route.
let lastPrune = 0;
function prune() {
  const now = Date.now();
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  for (const [k, f] of failures) if (now - f.first > WINDOW_MS) failures.delete(k);
}

function userBody(u, session) {
  return {
    user: { userId: u.user_id, name: u.name, email: u.email, role: u.role },
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  };
}

router.post('/login', async (req, res, next) => {
  const email    = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!email || !password) {
    return res.status(400).json({
      error: 'invalid_field', message: 'email and password are both required.',
    });
  }

  const keys = attemptKeys(req, email);
  if (isLockedOut(keys)) {
    return res.status(429).json({
      error: 'too_many_attempts',
      message: 'Too many failed logins. Wait 15 minutes and try again.',
    });
  }

  try {
    const { rows } = await pool.query(
      `SELECT user_id, email, name, role, password_hash, is_active
       FROM users WHERE lower(email) = $1`, [email]);
    // A deactivated account is treated exactly like a wrong password: same
    // status, same body, same bcrypt cost. Saying "this account is disabled"
    // would confirm the address exists.
    const user = rows[0] && rows[0].is_active ? rows[0] : undefined;

    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      recordFailure(keys);
      return res.status(401).json({
        error: 'invalid_credentials', message: 'Email or password is incorrect.',
      });
    }

    for (const k of keys) failures.delete(k);
    const session = issueSession(user);
    res.cookie(cfg.SESSION_COOKIE, session.token, cfg.cookieOptions);
    res.json(userBody(user, session));
  } catch (err) { next(err); }
});

router.get('/me', async (req, res, next) => {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ error: 'unauthenticated', message: 'Not logged in.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT user_id, email, name, role FROM users
       WHERE user_id = $1 AND is_active`, [session.userId]);
    if (!rows.length) {
      // The account was deleted after the session was issued.
      res.clearCookie(cfg.SESSION_COOKIE, { ...cfg.cookieOptions, maxAge: undefined });
      return res.status(401).json({ error: 'unauthenticated', message: 'Account is no longer active.' });
    }
    res.json(userBody(rows[0], {
      csrfToken: session.csrf,
      expiresAt: new Date(session.exp * 1000).toISOString(),
    }));
  } catch (err) { next(err); }
});

// No CSRF check here on purpose: the worst a forged logout can do is log the
// user out, and requiring the token would strand a user whose page lost it.
router.post('/logout', (req, res) => {
  res.clearCookie(cfg.SESSION_COOKIE, { ...cfg.cookieOptions, maxAge: undefined });
  res.status(204).end();
});

module.exports = router;
