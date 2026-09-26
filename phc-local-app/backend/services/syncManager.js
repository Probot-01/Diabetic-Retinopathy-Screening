'use strict';

/**
 * syncManager.js  (Task 3.4)
 *
 * Drains the local sync queue to the central server, opportunistically.
 *
 *   start(opts)   begin the polling loop; returns a handle with .stop()
 *   syncOnce()    run exactly one cycle (exported so tests can drive it
 *                 deterministically instead of sleeping past an interval)
 *   isOnline()    one heartbeat against the central /health endpoint
 *
 * ── The design constraint that shapes everything here ───────────────────────
 * This runs at a rural PHC with unreliable or absent connectivity (design doc
 * §1.4). Being offline is the NORMAL case, not an error case. So:
 *
 *   - a failed cycle must never throw out of the loop, or one bad night takes
 *     the local backend down and the technician cannot capture at all;
 *   - a heartbeat precedes every attempt, so a dead network costs one fast
 *     failed request rather than one slow multipart upload per queued case;
 *   - nothing is deleted on success. The queue row flips to 'synced' and stays,
 *     because it is the audit trail of what left this building.
 *
 * ── Chunked upload (Task 8.2) ───────────────────────────────────────────────
 * Images above CHUNK_THRESHOLD_BYTES go up in pieces against the central
 * /chunks endpoints, so a dropped connection costs one chunk instead of the
 * whole transfer. Smaller ones keep the single-shot POST: chunking a 400 KB
 * image spends four extra round trips to save nothing, and on these links round
 * trips are the expensive part.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const db        = require('../db/localDb');
const syncState = require('./syncState');

// Where central is. No built-in default: a PHC that silently synced to
// localhost:5000 because nobody configured it would look "offline" forever with
// nothing saying why. Unset -> every cycle is skipped and start() says so loudly;
// capture keeps working, as it must offline. CENTRAL_URL is the old name, still
// read so an existing .env keeps working.
if (!process.env.CENTRAL_API_URL && process.env.CENTRAL_URL) {
  console.warn('[syncManager] CENTRAL_URL is deprecated; rename it to CENTRAL_API_URL.');
}
const CENTRAL_URL   = (process.env.CENTRAL_API_URL || process.env.CENTRAL_URL || '').replace(/\/+$/, '');
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MS || '10000', 10);
const HEALTH_TIMEOUT = parseInt(process.env.SYNC_HEALTH_TIMEOUT_MS || '3000', 10);
const UPLOAD_TIMEOUT = parseInt(process.env.SYNC_UPLOAD_TIMEOUT_MS || '600000', 10);

// Above this, upload in chunks (Task 8.2). 2 MB is roughly where a single-shot
// POST stops reliably completing on the slowest tier in design doc §7 — below
// it the extra round trips cost more than they save.
const CHUNK_THRESHOLD = parseInt(process.env.SYNC_CHUNK_THRESHOLD_BYTES || String(2 * 1024 * 1024), 10);

// Each chunk is its own request with its own timeout, so this is the real unit
// of "work lost when the link drops". Small enough that a drop is cheap, large
// enough that a 15 MB image is not 60 round trips.
const CHUNK_SIZE = parseInt(process.env.SYNC_CHUNK_BYTES || String(1024 * 1024), 10);

const CHUNK_TIMEOUT = parseInt(process.env.SYNC_CHUNK_TIMEOUT_MS || '120000', 10);

// The central phc_sites UUID for this site. Set per deployment. When unset, the
// case is still accepted centrally but lands with phc_id NULL, which shows up
// on the admin dashboard as an unattributed bucket rather than under this PHC's
// name -- correct, but not useful. Configure it.
const PHC_ID = process.env.PHC_ID || null;

// This site's central API key (backend plan §A.12), issued once by
// scripts/provisionPhcKey.js on the central side. Sent on every ingestion
// request. Optional until central sets PHC_AUTH_ENABLED=true -- after that, a
// PHC without it cannot sync at all, so set it when the site is provisioned.
const PHC_API_KEY = process.env.PHC_API_KEY || null;

/** Request headers for central ingestion calls: the API key, when configured. */
function centralHeaders(extra = {}) {
  return PHC_API_KEY ? { ...extra, 'x-phc-api-key': PHC_API_KEY } : extra;
}

let timer   = null;
let running = false;   // guards against a slow cycle overlapping the next tick

/**
 * isOnline()
 *
 * A cheap GET /health, with its own short timeout.
 *
 * The timeout matters more than it looks: without one, a network that accepts
 * connections but never answers (a captive portal, a half-open link — both
 * common on rural mobile data) leaves this hanging indefinitely and the queue
 * never drains, with nothing in the logs to say why.
 */
async function isOnline() {
  if (!CENTRAL_URL) return false;
  try {
    // /health is public; the key rides along anyway so EVERY call this PHC
    // makes to central is identifiable as coming from it.
    const res = await fetch(`${CENTRAL_URL}/health`, {
      headers: centralHeaders(),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Everything the central ingestion endpoint needs for one capture. */
function loadCaseBundle(captureId) {
  const capture = db.prepare('SELECT * FROM captures WHERE capture_id = ?').get(captureId);
  if (!capture) return null;

  const patient = db.prepare('SELECT * FROM patients WHERE patient_id = ?')
                    .get(capture.patient_id);

  const questionnaire = db.prepare(
    'SELECT * FROM questionnaire_responses WHERE capture_id = ? ORDER BY recorded_at DESC LIMIT 1'
  ).get(captureId);

  const metadata = db.prepare(
    'SELECT * FROM capture_metadata_responses WHERE capture_id = ? ORDER BY recorded_at DESC LIMIT 1'
  ).get(captureId);

  return { capture, patient, questionnaire, metadata };
}

/**
 * buildFormData(bundle)
 *
 * Assembles the multipart body for POST /api/v1/cases.
 *
 * The patient demographics are included because cases.patient_id is a foreign
 * key centrally and there is no separate patient-sync endpoint — without them
 * the very first case for a patient is rejected with patient_not_found. See the
 * note on that endpoint in api-contracts.md.
 */
function buildCaseFields({ capture, patient, questionnaire, metadata }) {
  const fields = {
    patientId:      capture.patient_id,
    captureIdRef:   capture.capture_id,
    cameraDeviceId: capture.camera_device_id || 'unknown',
    // The capture time, NOT the sync time. A case queued overnight must not be
    // dated to the moment the network came back.
    capturedAt:     capture.captured_at,
  };

  if (PHC_ID) fields.phcId = PHC_ID;

  if (patient) {
    fields.patientName          = patient.name;
    fields.patientAge           = String(patient.age);
    fields.patientContactNumber = patient.contact_number;
    // §9.7 verbal consent, timestamped at registration. Absent for patients
    // registered before the field existed; central stores NULL for those.
    if (patient.consent_given_at) fields.consentGivenAt = patient.consent_given_at;
  }

  // Local columns are TEXT holding JSON; central expects JSON strings it will
  // parse. Re-parse and re-stringify rather than forwarding the stored text
  // blind, so a corrupt row fails here with a clear error instead of being
  // stored centrally as unusable JSONB.
  if (questionnaire) {
    fields.questionnaireData = JSON.stringify({
      riskFactors: JSON.parse(questionnaire.risk_factor_fields),
      symptoms:    JSON.parse(questionnaire.symptom_fields),
      language:    questionnaire.language,
    });
  }
  if (metadata) {
    fields.captureMetadata = JSON.stringify({
      cameraDeviceReported:  metadata.camera_device_reported,
      pupilStatus:           metadata.pupil_status,
      lightingEnvironment:   metadata.lighting_environment,
      observedIssues:        JSON.parse(metadata.observed_issues),
      workerUsabilityRating: metadata.worker_usability_rating,
      // §10.4. null for captures recorded before the field was stored.
      eyeLaterality:         metadata.eye_laterality ?? null,
    });
  }

  // The quality gate's sub-scores, steering Task 2.8's adaptive enhancement
  // centrally. Forwarded as a JSON string like the questionnaires; absent for
  // captures taken before this column existed, which the central side treats as
  // "no scores" and falls back to the default chain.
  if (capture.quality_scores) {
    fields.qualityScores = capture.quality_scores;
  }

  // Lets the central server keep phc_sites.pending_count current, which is what
  // the admin PHC Health screen reads. Counted BEFORE this upload succeeds, so
  // it is the depth at the moment contact was made.
  fields.pendingCount = String(countPending());

  return fields;
}

function imageMime(imagePath) {
  const ext = path.extname(imagePath).toLowerCase() || '.jpg';
  return ext === '.png' ? 'image/png'
       : (ext === '.tif' || ext === '.tiff') ? 'image/tiff'
       : 'image/jpeg';
}

function buildFormData(bundle) {
  const form = new FormData();
  for (const [k, v] of Object.entries(buildCaseFields(bundle))) form.append(k, v);

  const imagePath = bundle.capture.image_path;
  const buf = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase() || '.jpg';
  form.append('image', new Blob([buf], { type: imageMime(imagePath) }), `image${ext}`);

  return form;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * uploadChunked(bundle)
 *
 * Init → ask what is already there → send only the gaps → complete.
 *
 * The "ask what is already there" step is the whole point. A resumed upload
 * after a dropped link re-sends the missing chunks, not the file; a site that
 * got to 90% overnight finishes in a minute the next morning instead of
 * starting again and very likely dropping again.
 *
 * Nothing here is stored locally between attempts: the chunk boundaries are a
 * pure function of the file and CHUNK_SIZE, and the session key is the capture
 * id the row already has. So a crash mid-upload loses no resume state, which is
 * exactly the crash this has to survive.
 */
async function uploadChunked({ capture, patient, questionnaire, metadata }) {
  const bundle = { capture, patient, questionnaire, metadata };
  const imagePath = capture.image_path;
  const buf = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase() || '.jpg';
  const totalChunks = Math.ceil(buf.length / CHUNK_SIZE);
  const captureRef = capture.capture_id;

  const base = `${CENTRAL_URL}/api/v1/cases/${encodeURIComponent(captureRef)}/chunks`;

  const initRes = await fetch(`${base}/init`, {
    method: 'POST',
    headers: centralHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      ...buildCaseFields(bundle),
      totalChunks,
      totalBytes: buf.length,
      sha256: sha256(buf),
      filename: `image${ext}`,
    }),
    signal: AbortSignal.timeout(CHUNK_TIMEOUT),
  });
  if (!initRes.ok) {
    throw new Error(`chunk init returned ${initRes.status}: ${(await initRes.text()).slice(0, 200)}`);
  }
  const session = await initRes.json();

  // Central has already assembled and ingested this capture — a previous run
  // completed and we never saw the response. Treat it as success rather than
  // uploading a second copy of the same scan.
  if (session.alreadyIngested) {
    return { caseId: session.caseId, resumedDuplicate: true };
  }

  const missing = session.missing ?? [...Array(totalChunks).keys()];
  if (session.resumed && missing.length < totalChunks) {
    console.log(`[syncManager] resuming ${captureRef}: `
      + `${totalChunks - missing.length}/${totalChunks} chunks already there`);
  }

  for (const i of missing) {
    const slice = buf.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, buf.length));
    const form = new FormData();
    form.append('sha256', sha256(slice));
    form.append('chunk', new Blob([slice], { type: 'application/octet-stream' }), `${i}.part`);

    const res = await fetch(`${base}/${i}`, {
      method: 'POST', headers: centralHeaders(), body: form,
      signal: AbortSignal.timeout(CHUNK_TIMEOUT),
    });
    if (!res.ok) {
      // Thrown, so the case stays 'pending' and the next cycle resumes from
      // whatever did land. Chunks already accepted are not re-sent.
      throw new Error(`chunk ${i}/${totalChunks} returned ${res.status}: `
        + `${(await res.text()).slice(0, 200)}`);
    }
  }

  const doneRes = await fetch(`${base}/complete`, {
    method: 'POST', headers: centralHeaders(), signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
  });
  if (!doneRes.ok) {
    throw new Error(`chunk complete returned ${doneRes.status}: `
      + `${(await doneRes.text()).slice(0, 200)}`);
  }
  return doneRes.json();
}

function countPending() {
  return db.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'pending'").get().n;
}

/**
 * syncOnce()
 *
 * One full cycle: heartbeat, then drain what is pending.
 *
 * @returns {Promise<{online, attempted, synced, failed}>}
 */
async function syncOnce() {
  const nowIso = new Date().toISOString();

  const online = await isOnline();
  syncState.recordAttempt(online, nowIso);

  if (!online) {
    // Offline is the expected state, not an error — log nothing per cycle or a
    // week disconnected fills the disk with identical lines.
    return { online: false, attempted: 0, synced: 0, failed: 0 };
  }

  // High priority first (design doc §9.2): referable/uncertain cases go before
  // confident-negative ones when bandwidth is scarce. Oldest first within a
  // priority so a backlog drains in the order it was captured.
  // Upload ownership (docs/peer-sync-protocol.md): a capture replicated from a
  // paired phone is uploaded by that phone. This PC takes it over only once
  // the phone has been silent longer than PEER_TAKEOVER_MS. A double upload
  // would be harmless (central deduplicates on the capture ID) but wasteful.
  const { ownsUpload } = require('./peerSync');
  const pending = db.prepare(`
    SELECT q.queue_id, q.capture_id, q.priority, q.owner_device
    FROM sync_queue q
    JOIN captures c ON c.capture_id = q.capture_id
    WHERE q.status = 'pending'
    ORDER BY CASE q.priority WHEN 'high' THEN 0 ELSE 1 END, c.captured_at ASC
  `).all().filter((r) => ownsUpload(r.owner_device));

  let synced = 0, failed = 0;

  for (const row of pending) {
    // Stamp the attempt before trying, so a crash mid-upload still leaves
    // evidence that this row was reached.
    db.prepare('UPDATE sync_queue SET last_attempt_at = ? WHERE queue_id = ?')
      .run(new Date().toISOString(), row.queue_id);

    try {
      const bundle = loadCaseBundle(row.capture_id);
      if (!bundle) throw new Error(`capture ${row.capture_id} missing`);
      if (!fs.existsSync(bundle.capture.image_path)) {
        throw new Error(`image missing at ${bundle.capture.image_path}`);
      }

      // Task 8.2: chunk the big ones, post the small ones whole.
      const bytes = fs.statSync(bundle.capture.image_path).size;
      let caseId;
      let status = 'processing';

      if (bytes > CHUNK_THRESHOLD) {
        ({ caseId } = await uploadChunked(bundle));
      } else {
        const res = await fetch(`${CENTRAL_URL}/api/v1/cases`, {
          method: 'POST',
          headers: centralHeaders(),
          body: buildFormData(bundle),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`central returned ${res.status}: ${body.slice(0, 200)}`);
        }
        const body = await res.json();
        caseId = body.caseId;
        if (body.status) status = body.status;
      }

      // The central case id and status are kept so a paired phone learns this
      // capture is done (docs/peer-sync-protocol.md) and does not upload it too.
      db.prepare(`UPDATE sync_queue SET status = 'synced', central_case_id = ?, central_status = ?, updated_at = ?
                  WHERE queue_id = ?`)
        .run(caseId ?? null, status, new Date().toISOString(), row.queue_id);
      synced++;
      console.log(`[syncManager] ${row.capture_id} -> case ${caseId}`
        + `${bytes > CHUNK_THRESHOLD ? ` (chunked, ${(bytes / 1048576).toFixed(1)} MB)` : ''}`);
    } catch (err) {
      // Left 'pending' on purpose, with last_attempt_at recorded. The next
      // cycle retries it. Nothing is dropped and nothing is marked failed —
      // there is no state in this system for "gave up on a patient's scan".
      failed++;
      console.warn(`[syncManager] ${row.capture_id} failed, staying pending: ${err.message}`);
    }
  }

  return { online: true, attempted: pending.length, synced, failed };
}

/**
 * start(opts)
 *
 * @param {object} [opts]
 * @param {number} [opts.intervalMs]
 * @returns {{stop: function}}
 */
function start({ intervalMs = SYNC_INTERVAL } = {}) {
  if (timer) return { stop };

  const tick = async () => {
    // Skip if the previous cycle is still going. Without this, a slow upload
    // over poor bandwidth would have overlapping cycles picking up the same
    // pending rows and uploading the same case repeatedly.
    if (running) return;
    running = true;
    try {
      await syncOnce();
    } catch (err) {
      // Belt and braces: syncOnce already handles per-case failure, so reaching
      // here means something unexpected. Swallow it — an offline-first local
      // app must keep accepting captures no matter what the network is doing.
      console.error('[syncManager] cycle error:', err.message);
    } finally {
      running = false;
    }
  };

  if (!CENTRAL_URL) {
    console.error('[syncManager] CENTRAL_API_URL is not set -- NOTHING WILL SYNC. '
      + 'Captures are kept in the local queue until it is set and the backend restarted.');
    return { stop };
  }

  timer = setInterval(tick, intervalMs);
  // Do not hold the process open just for the sync loop.
  if (timer.unref) timer.unref();

  console.log(`[syncManager] polling ${CENTRAL_URL} every ${intervalMs}ms`
    + `${PHC_ID ? '' : ' (PHC_ID unset — cases will sync without a PHC attribution)'}`
    + `${PHC_API_KEY ? '' : ' (PHC_API_KEY unset — sync will fail once central enforces PHC keys)'}`);

  tick();   // one immediate pass, so startup does not wait a full interval
  return { stop };
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  start, stop, syncOnce, isOnline, countPending,
  // Exported for Task 8.2's verification: the chunked path needs to be drivable
  // against a live central server without going through the whole poll cycle.
  uploadChunked, CHUNK_THRESHOLD, CHUNK_SIZE,
};
