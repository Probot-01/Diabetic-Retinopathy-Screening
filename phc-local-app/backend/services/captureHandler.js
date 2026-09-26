'use strict';

/**
 * captureHandler.js  (Task 3.1)
 *
 * Takes a freshly captured fundus image, stores it, runs the local quality
 * gate over it, and records the outcome.
 *
 *   handleCapture(patientId, imageFile, cameraDeviceId)
 *     -> { captureId, patientId, qualityStatus, qualityReason, retakeCount, capturedAt }
 *
 * The returned object is EXACTLY the POST /captures response body from
 * api-contracts.md -- camelCase, ISO 8601 UTC timestamp, string IDs. The route
 * in Task 3.2 should be able to `res.status(201).json(await handleCapture(...))`
 * with no reshaping in between.
 *
 * ORDER OF OPERATIONS, and why
 *   1. write the image to disk
 *   2. INSERT the capture row with quality_status = 'pending'
 *   3. run the quality gate (slow -- spawns MATLAB)
 *   4. UPDATE the row with the real status/reason, and -- atomically with it --
 *      enqueue the capture for sync if it passed
 *
 * The row is inserted BEFORE the gate runs so that a MATLAB crash, a timeout,
 * or the technician closing the laptop mid-check cannot lose the capture. The
 * image is already on disk and the row already points at it, so the case can be
 * re-gated later instead of asking the patient to sit back down.
 *
 * 'pending' is therefore a real, persisted state -- but it is an INTERNAL one.
 * api-contracts.md's qualityStatus enum is only pass/retake/borderline, so a
 * 'pending' row is never returned over HTTP: if the gate fails, this function
 * throws and the row stays 'pending' for later repair.
 */

const fs   = require('fs');
const path = require('path');

const db                 = require('../db/localDb');
const { runQualityGate } = require('./qualityGateClient');
const { generateLocalId } = require('./ids');

// Captured images live outside the DB; the row stores a path. Git-ignored --
// these are patient fundus photographs.
// LOCAL_STORAGE_DIR: tests point this at a scratch directory.
const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR || path.resolve(__dirname, '..', 'storage');

fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Formats MATLAB's imread can open. Anything else is rejected up front rather
// than failing several seconds later inside the quality gate with a MATLAB
// stack trace the technician cannot act on.
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp']);

/**
 * resolveImageInput(imageFile)
 *
 * Normalises the several shapes an image can arrive in to { buffer, ext }.
 *
 * Accepted:
 *   - string                     a path on disk (how Task 3.1's DoD calls this)
 *   - Buffer                     raw bytes
 *   - { buffer, originalname }   multer memoryStorage
 *   - { path, originalname }     multer diskStorage
 *
 * Task 3.1's Definition of Done exercises this with a plain path, while Task
 * 3.2 will hand it a multer file object. Supporting both means the DoD tests
 * the same code path the route will use, rather than a variant of it.
 */
function resolveImageInput(imageFile) {
  if (!imageFile) {
    throw new Error('handleCapture: imageFile is required');
  }

  let buffer;
  let sourceName;

  if (typeof imageFile === 'string') {
    if (!fs.existsSync(imageFile)) {
      throw new Error(`handleCapture: image not found at ${imageFile}`);
    }
    buffer     = fs.readFileSync(imageFile);
    sourceName = imageFile;
  } else if (Buffer.isBuffer(imageFile)) {
    buffer     = imageFile;
    sourceName = '.jpg';                 // raw bytes carry no filename
  } else if (imageFile.buffer) {
    buffer     = imageFile.buffer;
    sourceName = imageFile.originalname || '.jpg';
  } else if (imageFile.path) {
    buffer     = fs.readFileSync(imageFile.path);
    sourceName = imageFile.originalname || imageFile.path;
  } else {
    throw new Error(
      'handleCapture: imageFile must be a path, a Buffer, or a multer file object');
  }

  // Preserve the original extension rather than forcing .jpg as the task text
  // suggests: the stored bytes are never transcoded, so a PNG saved as .jpg
  // would be a file whose extension lies about its contents. imread dispatches
  // on content, but everything else (viewers, the central upload) reads the
  // extension.
  let ext = path.extname(sourceName).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    if (ext) {
      throw new Error(
        `handleCapture: unsupported image type '${ext}'. Supported: ${[...ALLOWED_EXT].join(', ')}`);
    }
    ext = '.jpg';
  }

  return { buffer, ext };
}

/**
 * countPriorRetakes(patientId, nowIso)
 *
 * How many captures for this patient already failed the gate TODAY.
 *
 * Scoped to the current UTC day deliberately. retakeCount answers "which
 * attempt is this, in this sitting" -- the technician is retaking because the
 * patient is still in the chair. A patient screened again six months later
 * starts a fresh sitting and should not inherit a count from the last visit.
 *
 * captured_at is an ISO 8601 UTC string in a fixed format, so a lexicographic
 * >= comparison against the start of the day is equivalent to a date
 * comparison, and lets SQLite use the index rather than parsing every row.
 */
function countPriorRetakes(patientId, nowIso) {
  const startOfDay = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
  const { n } = db.prepare(`
    SELECT COUNT(*) AS n FROM captures
    WHERE patient_id = ? AND quality_status = 'retake' AND captured_at >= ?
  `).get(patientId, startOfDay);
  return n;
}

/**
 * provisionalPriority(qualityStatus)
 *
 * Which captures the sync manager should send first when bandwidth is scarce.
 *
 * The design doc wants referable/uncertain cases prioritised over
 * confident-negative ones (§9.2) -- but referable-ness is a central grading
 * result, and this runs before the image has left the building. So the value
 * written here is explicitly PROVISIONAL, "until a first central pass
 * classifies it" (§4.3).
 *
 * 'borderline' is the only uncertainty signal available locally: the gate found
 * no single hard failure but the composite score was still below par, so the
 * image is the kind that most benefits from central enhancement and a human
 * look. That earns 'high'. A clean pass starts 'low'.
 *
 * This is a heuristic standing in for a real signal, not a validated ranking.
 * Task 3.4 should update the row once the central classification comes back.
 */
function provisionalPriority(qualityStatus) {
  return qualityStatus === 'borderline' ? 'high' : 'low';
}

/**
 * handleCapture(patientId, imageFile, cameraDeviceId)
 *
 * @param {string} patientId       — an existing patients.patient_id
 * @param {string|Buffer|object} imageFile — see resolveImageInput
 * @param {string} [cameraDeviceId] — a key in cameraPresets.json, or 'unknown'
 * @returns {Promise<{captureId,patientId,qualityStatus,qualityReason,retakeCount,capturedAt}>}
 */
async function handleCapture(patientId, imageFile, cameraDeviceId = 'unknown') {
  if (!patientId) {
    throw new Error('handleCapture: patientId is required');
  }

  // Check the patient up front. localDb.js enables foreign_keys, so a bad
  // patientId would fail at INSERT anyway -- but as an opaque SQLITE_CONSTRAINT
  // error, after the image has already been written to disk. Task 3.2 maps this
  // message to a 404 patient_not_found.
  const patient = db
    .prepare('SELECT patient_id FROM patients WHERE patient_id = ?')
    .get(patientId);
  if (!patient) {
    throw new Error(`handleCapture: patient_not_found (${patientId})`);
  }

  const { buffer, ext } = resolveImageInput(imageFile);

  const captureId  = generateLocalId();
  const capturedAt = new Date().toISOString();
  const imagePath  = path.join(STORAGE_DIR, `${captureId}${ext}`);

  // ── 1. Persist the image ───────────────────────────────────────────────────
  fs.writeFileSync(imagePath, buffer);

  // ── 2. Record the capture before the slow part ─────────────────────────────
  const retakeCount = countPriorRetakes(patientId, capturedAt);

  db.prepare(`
    INSERT INTO captures
      (capture_id, patient_id, camera_device_id, image_path,
       quality_status, quality_reason, retake_count, captured_at)
    VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)
  `).run(captureId, patientId, cameraDeviceId, imagePath, retakeCount, capturedAt);

  // ── 3. Quality gate (spawns MATLAB; seconds, not milliseconds) ─────────────
  let gate;
  try {
    gate = await runQualityGate(imagePath, cameraDeviceId);
  } catch (err) {
    // Leave the row 'pending'. The image is on disk and the row points at it,
    // so this capture can be re-gated without recalling the patient.
    console.error(`[captureHandler] quality gate failed for ${captureId}:`, err.message);
    throw new Error(`quality_gate_failed: ${err.message}`);
  }

  // ── 4. Record the verdict, and enqueue for sync ────────────────────────────
  // Both writes in one transaction. A capture that passed the gate but has no
  // sync_queue row would never reach the central server and nothing would ever
  // notice -- it would just look like a case the ophthalmologist never got to.
  const commit = db.transaction(() => {
    // qualityGateClient already normalises MATLAB's empty-matrix reason to null.
    // quality_scores is stored, not just logged. The six sub-scores say WHICH
    // dimension of an image is weak, and Task 2.8's adaptive enhancement runs
    // centrally -- so discarding them here means the central pipeline can only
    // apply one fixed chain to every image, which is what "adaptive" was
    // supposed to stop.
    db.prepare(`
      UPDATE captures SET quality_status = ?, quality_reason = ?, quality_scores = ?,
                          quality_engine = ?
      WHERE capture_id = ?
    `).run(gate.status, gate.reason,
           gate.scores ? JSON.stringify(gate.scores) : null,
           gate.engine ? JSON.stringify(gate.engine) : null,
           captureId);

    // Only pass/borderline get queued. A 'retake' is not a case -- the
    // technician is about to shoot it again (design doc §8.1 loops back to
    // step 1), so uploading it would spend scarce rural bandwidth on an image
    // that is already being replaced.
    if (gate.status === 'pass' || gate.status === 'borderline') {
      db.prepare(`
        INSERT INTO sync_queue
          (queue_id, capture_id, status, priority, chunks_sent, chunks_total, last_attempt_at)
        VALUES (?, ?, 'pending', ?, 0, 1, NULL)
      `).run(generateLocalId(), captureId, provisionalPriority(gate.status));
    }
  });
  commit();

  // Sub-scores are for logging only -- api-contracts.md does not expose them,
  // and they are not part of the response below.
  console.log(`[captureHandler] ${captureId}: ${gate.status}`
    + `${gate.reason ? ` (${gate.reason})` : ''}`
    + ` scores=${JSON.stringify(gate.scores)}`);

  return {
    captureId,
    patientId,
    qualityStatus: gate.status,
    qualityReason: gate.reason,
    retakeCount,
    capturedAt,
  };
}

module.exports = { handleCapture, STORAGE_DIR };
