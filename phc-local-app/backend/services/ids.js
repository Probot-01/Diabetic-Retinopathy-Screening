'use strict';

/**
 * ids.js
 *
 * Locally-generated ID format, in one place. Spec: docs/id-format-spec.md.
 *
 *     {PHC_CODE}-{base36 timestamp}-{8 random alphanumeric}
 *     e.g.  PHC001-mtuss3yg-a2x9k7qp
 *
 * IDs are ALWAYS strings, never numbers. The same generator is ported to the
 * Expo app (phc-local-app/mobile/netrasetu/lib/ids.ts) and must stay identical.
 *
 * Why this shape:
 *   - The PHC prefix makes IDs unique across sites without coordination:
 *     PHCs mint IDs offline and cannot ask a central server for one.
 *   - The base36 timestamp keeps IDs roughly sortable by creation time.
 *   - The timestamp is MONOTONIC within this process: if the clock has not
 *     moved since the last ID (or moved backwards), the previous value + 1 ms
 *     is used. Two IDs minted by one process can therefore never collide,
 *     however fast they are minted (bulk import, scripted tests).
 *   - The 8-character random suffix separates IDs minted in the same
 *     millisecond by DIFFERENT devices of one PHC -- the desktop and the phone
 *     share a PHC code. 36^8 = 2.8e12 values per millisecond.
 *
 * History: the suffix was 4 characters until 2026-09-24. At 36^4 = 1.7M values
 * per millisecond, a batch minting a few hundred IDs in one millisecond
 * collided (~1% at 200/ms, measured). IDs minted before then keep their
 * 4-character suffix and remain valid everywhere; see LOCAL_ID_RE.
 */

const crypto = require('crypto');

// Which PHC this install belongs to. Set PHC_CODE per deployment; the default
// only suits a single-site demo, and two sites both running the default would
// share a namespace.
const PHC_CODE = process.env.PHC_CODE || 'PHC001';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SUFFIX_LENGTH = 8;

/** Accepts current (8-char) and pre-2026-09-24 (4-char) suffixes. */
const LOCAL_ID_RE = /^[A-Za-z0-9]+-[0-9a-z]+-(?:[0-9a-z]{8}|[0-9a-z]{4})$/;

/**
 * randomSuffix(n)
 *
 * n random lowercase-alphanumeric characters from crypto.randomBytes, with
 * rejection sampling: bytes >= 252 (the largest multiple of 36 in a byte) are
 * discarded rather than taken modulo 36, which would favour 'a'-'d' and raise
 * the collision rate this suffix exists to keep down.
 */
function randomSuffix(n = SUFFIX_LENGTH) {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = '';
  while (out.length < n) {
    for (const byte of crypto.randomBytes(n * 2)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out;
}

let lastMs = 0;

/** Date.now(), but strictly increasing within this process. */
function monotonicNow() {
  const now = Date.now();
  lastMs = now > lastMs ? now : lastMs + 1;
  return lastMs;
}

/**
 * generateLocalId([phcCode])
 *
 * @param {string} [phcCode] — override the configured PHC code.
 * @returns {string} e.g. 'PHC001-mtuss3yg-a2x9k7qp'
 */
function generateLocalId(phcCode = PHC_CODE) {
  return `${phcCode}-${monotonicNow().toString(36)}-${randomSuffix(SUFFIX_LENGTH)}`;
}

module.exports = { generateLocalId, PHC_CODE, LOCAL_ID_RE, SUFFIX_LENGTH };
