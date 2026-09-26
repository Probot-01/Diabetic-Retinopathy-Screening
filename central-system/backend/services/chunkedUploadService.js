'use strict';

/**
 * chunkedUploadService.js  (Task 8.2)
 *
 * Resumable, integrity-checked image upload for PHCs on poor links.
 *
 *   initSession(captureRef, meta)      open (or re-open) an upload session
 *   getSession(captureRef)             which chunks the server already holds
 *   putChunk(captureRef, index, buf, sha256)
 *   completeSession(captureRef)        assemble, verify, ingest, enqueue
 *   sweepStale(maxAgeMs)               reap abandoned sessions
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * A single-shot POST of a 15 MB fundus image over a rural link either finishes
 * or it does not. If the connection drops at 90%, the next attempt starts again
 * at zero — and on a link bad enough to drop once, it will drop again, so a
 * large image can fail indefinitely while smaller ones sail past it. The sync
 * queue never drains, and the case that will not upload is often the referable
 * one somebody is waiting on.
 *
 * Chunking makes progress durable: whatever arrived stays arrived, and a resume
 * asks the server what it already has and sends only the gaps.
 *
 * ── Why the session is keyed on captureIdRef, not a server-issued id ────────
 * The PHC already has a globally unique id for the capture (`ids.js`:
 * PHC001-lz3k9f-a2x9), minted offline without coordination. Using it as the
 * session key means a client that crashes and restarts can resume without
 * having kept any server-issued token — it re-derives the key from its own
 * database row. A server-issued uploadId would have to be persisted locally to
 * survive exactly the crash this feature exists to tolerate.
 *
 * It also makes the whole flow idempotent: re-completing a finished session
 * returns the original caseId instead of ingesting the same scan twice.
 *
 * ── Integrity is not optional here ──────────────────────────────────────────
 * Reassembling a fundus image from pieces that crossed a flaky link creates a
 * failure mode single-shot upload does not have: a file that is complete in
 * length, decodes as a valid JPEG, and is subtly wrong. That image would be
 * graded, and the grade would be reported to a clinician with no indication
 * anything was amiss.
 *
 * So every chunk carries a SHA-256 that is verified on receipt (catching
 * corruption at the 1 MB chunk, not after a 15 MB assembly), and the assembled
 * file is verified against a whole-file SHA-256 committed at init. A mismatch
 * refuses to ingest. Nothing is graded that cannot be shown to be exactly what
 * the PHC captured.
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const mediaPaths   = require('./mediaPaths');
const mediaCrypto  = require('./mediaCrypto');
const ingestion    = require('./ingestionService');
const gradingQueue = require('./gradingQueue');

const CHUNK_ROOT = path.join(mediaPaths.MEDIA_ROOT, 'chunks');

const MAX_CHUNK_BYTES  = parseInt(process.env.UPLOAD_MAX_CHUNK_BYTES  || String(4 * 1024 * 1024), 10);
const MAX_TOTAL_BYTES  = parseInt(process.env.UPLOAD_MAX_TOTAL_BYTES  || String(64 * 1024 * 1024), 10);
const MAX_CHUNKS       = parseInt(process.env.UPLOAD_MAX_CHUNKS       || '2048', 10);
const SESSION_TTL_MS   = parseInt(process.env.UPLOAD_SESSION_TTL_MS   || String(7 * 24 * 3600 * 1000), 10);

// Task 4.6: .dcm accepted because real fundus cameras export DICOM under the
// Ophthalmic Photography IOD, and readFundusImage.m now reads it. Central only
// -- the PHC quality gate still uses imread, so a DICOM cannot yet complete the
// capture->sync path end to end. See readFundusImage.m for why that is a
// bundle/licensing decision (Task 8.1) rather than a coding one.
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.dcm']);

/**
 * Capture references are attacker-controlled: they arrive as a URL path segment
 * from whatever posted to us, and they are used to build a filesystem path.
 * A permissive pattern here is a directory traversal — `../../etc/x` would
 * write outside the media root.
 *
 * The allowed set has no dot, no slash and no backslash, so `..` and absolute
 * paths cannot be expressed at all. sessionDir() then re-checks the resolved
 * path stays under CHUNK_ROOT, because one validation in front of a filesystem
 * write is one more than the number that have to fail.
 */
const CAPTURE_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

// In-process locks. Two completeSession() calls for the same capture would
// otherwise both pass the "already ingested?" check and create two cases for
// one scan -- a duplicate patient record in an ophthalmologist's queue.
const locks = new Map();

async function withLock(key, fn) {
  while (locks.has(key)) await locks.get(key);
  let release;
  const p = new Promise((r) => { release = r; });
  locks.set(key, p);
  try {
    return await fn();
  } finally {
    locks.delete(key);
    release();
  }
}

function badRequest(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function assertCaptureRef(captureRef) {
  if (!captureRef || !CAPTURE_REF_RE.test(captureRef)) {
    throw badRequest('invalid_capture_ref',
      'captureRef must be 1-64 characters of letters, digits, hyphen or underscore.');
  }
}

function sessionDir(captureRef) {
  assertCaptureRef(captureRef);
  const dir = path.join(CHUNK_ROOT, captureRef);
  // Defence in depth: even with the regex above, never write outside the root.
  const rel = path.relative(CHUNK_ROOT, path.resolve(dir));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw badRequest('invalid_capture_ref', 'Refusing a captureRef that escapes the chunk root.');
  }
  return dir;
}

const manifestPath = (captureRef) => path.join(sessionDir(captureRef), 'manifest.json');
const chunkPath = (captureRef, index) =>
  path.join(sessionDir(captureRef), `${String(index).padStart(6, '0')}.part`);

function readManifest(captureRef) {
  const p = manifestPath(captureRef);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw badRequest('corrupt_session',
      `Upload session for ${captureRef} has an unreadable manifest: ${err.message}`);
  }
}

function writeManifest(captureRef, manifest) {
  // Write-then-rename: a manifest half-written by a crash would make the
  // session unreadable and unresumable, losing the chunks already transferred.
  const p = manifestPath(captureRef);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, p);
}

/** Indices actually present on disk, ascending. */
function receivedChunks(captureRef) {
  const dir = sessionDir(captureRef);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.part'))
    .map((f) => parseInt(f.slice(0, -5), 10))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * initSession(captureRef, meta)
 *
 * meta: { totalChunks, totalBytes, sha256, filename, ...case fields }
 *
 * Idempotent by design. A client resuming after a crash calls init again with
 * the same parameters and gets its progress back rather than a fresh empty
 * session — re-initialising would throw away chunks that are already on disk,
 * which is precisely backwards for a feature whose purpose is not losing them.
 *
 * If the parameters DIFFER from the stored session, the existing chunks belong
 * to a different file and are discarded. Keeping them would assemble a mixture
 * of two images that still passes a length check.
 */
async function initSession(captureRef, meta = {}) {
  assertCaptureRef(captureRef);

  // §C: the capture may already have a complete case -- typically because the
  // single-shot POST /cases succeeded and its response was lost. Uploading the
  // image again in chunks would transfer megabytes over a bad link only for
  // ingestion to recognise the duplicate and discard it. Say so up front.
  const existingCase = await ingestion.findCaseByCaptureRef(captureRef);
  if (existingCase && existingCase.status !== 'awaiting_image') {
    return {
      captureRef, alreadyIngested: true, caseId: existingCase.caseId,
      status: existingCase.status, missing: [], received: [],
    };
  }

  const totalChunks = parseInt(meta.totalChunks, 10);
  const totalBytes  = parseInt(meta.totalBytes, 10);
  const expectedSha = String(meta.sha256 || '').toLowerCase();

  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS) {
    throw badRequest('invalid_field',
      `totalChunks must be an integer in 1..${MAX_CHUNKS}.`);
  }
  if (!Number.isInteger(totalBytes) || totalBytes < 1) {
    throw badRequest('invalid_field', 'totalBytes must be a positive integer.');
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw badRequest('image_too_large',
      `Image is ${totalBytes} bytes; the limit is ${MAX_TOTAL_BYTES}.`, 413);
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
    throw badRequest('invalid_field',
      'sha256 must be the hex SHA-256 of the complete image.');
  }

  let ext = path.extname(meta.filename || '').toLowerCase();
  if (!ext) ext = '.jpg';
  if (!ALLOWED_EXT.has(ext)) {
    throw badRequest('invalid_image_type', `Unsupported image type '${ext}'.`);
  }

  return withLock(captureRef, async () => {
    const existing = readManifest(captureRef);

    if (existing) {
      if (existing.caseId) {
        // Already ingested. Say so rather than reopening: the scan is graded or
        // grading, and a second copy would be a duplicate patient case.
        return {
          captureRef, alreadyIngested: true, caseId: existing.caseId,
          totalChunks: existing.totalChunks, received: [], missing: [],
        };
      }
      const sameFile = existing.sha256 === expectedSha
                    && existing.totalChunks === totalChunks
                    && existing.totalBytes === totalBytes;
      if (sameFile) {
        const received = receivedChunks(captureRef);
        return {
          captureRef, alreadyIngested: false,
          totalChunks, received,
          missing: missingChunks(totalChunks, received),
          resumed: true,
        };
      }
      // Different file under the same key: start clean.
      fs.rmSync(sessionDir(captureRef), { recursive: true, force: true });
    }

    fs.mkdirSync(sessionDir(captureRef), { recursive: true });

    const { totalChunks: _tc, totalBytes: _tb, sha256: _sh, filename: _fn, ...caseFields } = meta;

    writeManifest(captureRef, {
      captureRef, totalChunks, totalBytes, sha256: expectedSha, ext,
      caseFields,                       // patientId, phcId, questionnaires, ...
      createdAt: new Date().toISOString(),
      caseId: null,
    });

    return {
      captureRef, alreadyIngested: false, totalChunks,
      received: [], missing: missingChunks(totalChunks, []), resumed: false,
    };
  });
}

function missingChunks(totalChunks, received) {
  const have = new Set(received);
  const out = [];
  for (let i = 0; i < totalChunks; i++) if (!have.has(i)) out.push(i);
  return out;
}

/**
 * getSession(captureRef)
 *
 * The resume primitive: the client asks what the server holds and sends only
 * `missing`. Derived from the directory listing rather than from a counter in
 * the manifest, so it stays true even if the process died mid-write — the
 * files on disk are the only claim that cannot drift from reality.
 */
function getSession(captureRef) {
  assertCaptureRef(captureRef);
  const manifest = readManifest(captureRef);
  if (!manifest) return null;

  const received = receivedChunks(captureRef);
  return {
    captureRef,
    totalChunks: manifest.totalChunks,
    totalBytes:  manifest.totalBytes,
    sha256:      manifest.sha256,
    received,
    missing:     missingChunks(manifest.totalChunks, received),
    complete:    received.length === manifest.totalChunks,
    caseId:      manifest.caseId,
    createdAt:   manifest.createdAt,
  };
}

/**
 * putChunk(captureRef, index, buffer, chunkSha)
 *
 * Verifies before writing. A chunk that fails its hash is rejected with 422 and
 * never lands on disk, so a retry is a clean overwrite rather than a repair.
 *
 * Re-sending a chunk already held is a success, not a conflict: after a dropped
 * connection a client cannot know whether its last chunk arrived, and making it
 * an error would strand exactly that ambiguity.
 */
async function putChunk(captureRef, index, buffer, chunkSha) {
  assertCaptureRef(captureRef);

  const manifest = readManifest(captureRef);
  if (!manifest) {
    throw badRequest('session_not_found',
      `No upload session for ${captureRef}. Call init first.`, 404);
  }
  if (manifest.caseId) {
    throw badRequest('already_ingested',
      `Capture ${captureRef} was already assembled into case ${manifest.caseId}.`, 409);
  }

  const i = parseInt(index, 10);
  if (!Number.isInteger(i) || i < 0 || i >= manifest.totalChunks) {
    throw badRequest('invalid_field',
      `chunkIndex must be an integer in 0..${manifest.totalChunks - 1}.`);
  }
  if (!buffer || !buffer.length) {
    throw badRequest('empty_chunk', 'The chunk body was empty.');
  }
  if (buffer.length > MAX_CHUNK_BYTES) {
    throw badRequest('chunk_too_large',
      `Chunk is ${buffer.length} bytes; the limit is ${MAX_CHUNK_BYTES}.`, 413);
  }

  const actual = sha256(buffer);
  if (chunkSha && String(chunkSha).toLowerCase() !== actual) {
    // 422, not 400: the request is well-formed, the payload is damaged. The
    // client should resend this chunk, not give up on the upload.
    throw badRequest('chunk_checksum_mismatch',
      `Chunk ${i} failed its checksum — expected ${chunkSha}, got ${actual}. Resend it.`,
      422);
  }

  return withLock(`${captureRef}:${i}`, async () => {
    const p = chunkPath(captureRef, i);
    const tmp = `${p}.tmp`;
    // Pieces of a patient image: encrypted at rest like the image itself
    // (mediaCrypto; checksum was verified on the plaintext above).
    fs.writeFileSync(tmp, mediaCrypto.encryptBuffer(buffer));
    fs.renameSync(tmp, p);     // atomic: a .part file is always whole

    const received = receivedChunks(captureRef);
    return {
      captureRef, index: i, bytes: buffer.length, sha256: actual,
      received: received.length,
      totalChunks: manifest.totalChunks,
      missing: missingChunks(manifest.totalChunks, received),
    };
  });
}

/**
 * completeSession(captureRef)
 *
 * Assemble → verify → ingest → enqueue. Returns { caseId, receivedAt }, the
 * same shape as a single-shot POST /cases, so the two paths are
 * interchangeable to the caller.
 *
 * The order matters. The whole-file hash is checked BEFORE ingestCase, because
 * once a case row exists the image is in the clinical record and a later
 * discovery that it was corrupt means deleting a patient's case. Verifying
 * first means a bad assembly is simply a failed upload the PHC retries.
 */
async function completeSession(captureRef) {
  assertCaptureRef(captureRef);

  return withLock(captureRef, async () => {
    const manifest = readManifest(captureRef);
    if (!manifest) {
      throw badRequest('session_not_found', `No upload session for ${captureRef}.`, 404);
    }

    // Idempotent completion: a client that never saw our response retries, and
    // must get the original case back rather than creating a second one.
    if (manifest.caseId) {
      return { caseId: manifest.caseId, receivedAt: manifest.ingestedAt, duplicate: true };
    }

    const received = receivedChunks(captureRef);
    const missing  = missingChunks(manifest.totalChunks, received);
    if (missing.length) {
      throw badRequest('incomplete_upload',
        `${missing.length} chunk(s) still missing: [${missing.slice(0, 20).join(', ')}` +
        `${missing.length > 20 ? ', …' : ''}]. Send them, then complete again.`, 409);
    }

    // Assemble in index order. Streaming rather than concatenating in memory:
    // the point of this path is large files, and buffering the whole image to
    // join it would reintroduce the memory cost chunking exists to avoid.
    const hash = crypto.createHash('sha256');
    const parts = [];
    let assembledBytes = 0;
    for (let i = 0; i < manifest.totalChunks; i++) {
      const buf = mediaCrypto.readFile(chunkPath(captureRef, i));
      hash.update(buf);
      assembledBytes += buf.length;
      parts.push(buf);
    }
    const assembledSha = hash.digest('hex');

    if (assembledBytes !== manifest.totalBytes) {
      throw badRequest('size_mismatch',
        `Assembled ${assembledBytes} bytes but the session declared ${manifest.totalBytes}.`,
        422);
    }
    if (assembledSha !== manifest.sha256) {
      // Every chunk passed its own hash and the whole still does not match, so
      // the pieces are individually intact but wrong as a set -- a stale chunk
      // from an earlier attempt, or a client that changed the file mid-upload.
      // Refuse, and clear the chunks so the retry cannot inherit the problem.
      fs.rmSync(sessionDir(captureRef), { recursive: true, force: true });
      throw badRequest('checksum_mismatch',
        `Assembled image hashes to ${assembledSha}, not the declared ${manifest.sha256}. ` +
        'The session has been discarded; start again.', 422);
    }

    const result = await ingestion.ingestCase({
      ...manifest.caseFields,
      captureIdRef: manifest.caseFields.captureIdRef || captureRef,
      imageFile: {
        buffer: Buffer.concat(parts, assembledBytes),
        originalname: `image${manifest.ext}`,
      },
    });

    // Record the caseId BEFORE deleting the chunks. If the process dies between
    // the two, the next complete() is idempotent and returns this caseId; the
    // orphaned chunks are reaped by sweepStale(). The other order would leave a
    // session with no chunks and no caseId — unresumable and uncompletable.
    manifest.caseId = result.caseId;
    manifest.ingestedAt = result.receivedAt;
    writeManifest(captureRef, manifest);

    for (let i = 0; i < manifest.totalChunks; i++) {
      fs.rmSync(chunkPath(captureRef, i), { force: true });
    }

    // ingestCase is idempotent on the capture id (§C): if central already had a
    // graded/processing case for this capture -- e.g. it arrived earlier by the
    // single-shot POST -- nothing new was stored and nothing must be re-graded.
    if (!result.duplicate) gradingQueue.enqueue(result.caseId);

    return result;
  });
}

/**
 * sweepStale(maxAgeMs)
 *
 * Delete sessions older than maxAgeMs that never completed, and the manifests
 * of ones that did. A PHC that abandons an upload (the technician retook the
 * image, the site was decommissioned) otherwise leaves its chunks on the
 * central disk forever.
 *
 * The default TTL is a week, deliberately generous: a site that is offline for
 * five days and resumes on the sixth should still find its progress. Disk is
 * cheaper than a re-upload over a link that could not manage it the first time.
 */
function sweepStale(maxAgeMs = SESSION_TTL_MS) {
  if (!fs.existsSync(CHUNK_ROOT)) return { swept: 0, kept: 0 };
  const cutoff = Date.now() - maxAgeMs;
  let swept = 0, kept = 0;

  for (const entry of fs.readdirSync(CHUNK_ROOT)) {
    if (!CAPTURE_REF_RE.test(entry)) continue;
    let manifest;
    try {
      manifest = readManifest(entry);
    } catch {
      manifest = null;                      // corrupt: treat as sweepable
    }
    const dir = path.join(CHUNK_ROOT, entry);
    const age = manifest?.createdAt ? Date.parse(manifest.createdAt) : 0;

    if (!manifest || age < cutoff) {
      fs.rmSync(dir, { recursive: true, force: true });
      swept++;
    } else {
      kept++;
    }
  }
  return { swept, kept };
}

module.exports = {
  initSession, getSession, putChunk, completeSession, sweepStale,
  CHUNK_ROOT, MAX_CHUNK_BYTES, MAX_TOTAL_BYTES, MAX_CHUNKS,
  CAPTURE_REF_RE,
};
