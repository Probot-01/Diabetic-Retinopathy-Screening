'use strict';

/**
 * Password hashing for technician accounts -- scrypt from Node's crypto
 * (no native add-on to install on a PHC PC). Stored as
 *
 *     scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
 *
 * so the cost can be raised later without invalidating existing hashes.
 * Verification is constant-time.
 */
const crypto = require('crypto');

const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Compared against when the username does not exist, so a wrong username and
// a wrong password take the same time (no account enumeration by timing).
const DUMMY_HASH = hashPassword('not-a-real-password');

module.exports = { hashPassword, verifyPassword, DUMMY_HASH };
