/**
 * Locally generated IDs -- docs/id-format-spec.md, the Expo port of
 * phc-local-app/backend/services/ids.js. Must stay identical to it. Used for
 * BOTH patient and capture IDs:
 *
 *   {PHC_CODE}-{monotonic Date.now() base36}-{8 chars, CSPRNG, no modulo bias}
 *
 * The timestamp never repeats within this app process, so two IDs minted on
 * this phone cannot collide; the 8-character suffix separates this phone from
 * the PHC's desktop, which shares the PHC code. (The suffix was 4 characters
 * before 2026-09-24; those IDs stay valid -- see LOCAL_ID_RE.)
 *
 * A capture ID is central's idempotency key: mint it once when the capture is
 * taken, store it, never regenerate it on retry.
 */
import * as Crypto from 'expo-crypto';
import { getConfig } from '../config';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LIMIT = Math.floor(256 / ALPHABET.length) * ALPHABET.length; // 252
export const SUFFIX_LENGTH = 8;

function randomSuffix(n = SUFFIX_LENGTH): string {
  let out = '';
  while (out.length < n) {
    for (const byte of Crypto.getRandomBytes(n * 2)) {
      if (byte >= LIMIT) continue; // reject: avoids modulo bias
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out;
}

let lastMs = 0;

/** Date.now(), but strictly increasing within this process. */
function monotonicNow(): number {
  const now = Date.now();
  lastMs = now > lastMs ? now : lastMs + 1;
  return lastMs;
}

export function generateLocalId(phcCode = getConfig().phcCode): string {
  return `${phcCode}-${monotonicNow().toString(36)}-${randomSuffix(SUFFIX_LENGTH)}`;
}

/** Accepts current (8-char) and pre-2026-09-24 (4-char) suffixes. */
export const LOCAL_ID_RE = /^[A-Za-z0-9]+-[0-9a-z]+-(?:[0-9a-z]{8}|[0-9a-z]{4})$/;
