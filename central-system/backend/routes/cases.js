'use strict';

/**
 * routes/cases.js  (Task 3.3)
 *
 * Mounted at /api/v1/cases. Implements the "Central API" case endpoints from
 * docs/api-contracts.md:
 *
 *   POST /api/v1/cases                -> 201 { caseId, receivedAt, status, duplicate, fromSummary }
 *                                        200 same body when the capture was already ingested
 *   POST /api/v1/cases/summary        -> 201 | 200 { caseId, receivedAt, status, duplicate }
 *   GET  /api/v1/cases/:caseId/status -> 200 { caseId, status }
 *   GET  /api/v1/cases/:caseId        -> 200 full case detail
 *
 *   POST /api/v1/cases/:caseId/review -> 200 { reviewId, referralId, smsStatus }
 *   POST /api/v1/cases/:caseId/claim  -> 200 claim | 409 held by another reviewer
 *   GET  /api/v1/cases/:caseId/reviews -> 200 [ review history, newest first ]
 *
 * ── Who may call what (backend plan §A.7 / §A.12) ───────────────────────────
 *   PHC device key (X-PHC-Api-Key):  POST /, all /:captureRef/chunks routes
 *   PHC key OR any logged-in user:   GET /:caseId/status
 *   ophthalmologist or admin:        GET /:caseId, GET /:caseId/reviews
 *   ophthalmologist only:            POST /:caseId/claim, POST /:caseId/review
 *
 * ── CONTRACT GAP worth resolving before Task 3.4 ────────────────────────────
 * cases.patient_id is a foreign key to patients, so a patient must exist
 * centrally before any case referencing them can be stored. But there is no
 * central patient-creation endpoint in api-contracts.md, and POST /cases
 * carries no demographics — so as written, nothing can ever create the central
 * patient row, and every POST /cases for a new patient would fail.
 *
 * Handled here by accepting OPTIONAL patientName / patientAge /
 * patientContactNumber fields and registering the patient when they are
 * present. That is additive rather than a change to any documented shape, and
 * it keeps the sync manager buildable. contact_number in particular is not
 * bookkeeping — Task 3.6 sends the referral SMS to it, so a patient who
 * arrives without one cannot be told their result.
 *
 * api-contracts.md should be updated to record these three fields.
 */

const express = require('express');
const multer  = require('multer');

const ingestion = require('../services/ingestionService');
const gradingQueue = require('../services/gradingQueue');
const { handleConfirmedReferral } = require('../services/referralNotificationService');
const pool = require('../db/pgClient');
const cfg  = require('../services/authConfig');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { requirePhcApiKey, requireUserOrPhc } = require('../middleware/requirePhcApiKey');
const { logAccess } = require('../services/accessLog');
const datasetCollector = require('../services/datasetCollector');

const router = express.Router();

const anyUser         = [requireAuth, requireRole('ophthalmologist', 'district_admin')];
const ophthalmologist = [requireAuth, requireRole('ophthalmologist')];

/**
 * pinPhc(req, res) -- when the request carries a PHC key, the case belongs to
 * THAT site. A body naming a different phcId is refused rather than silently
 * rewritten: it means a PHC is configured with another site's id (or key), and
 * attributing its cases anywhere would corrupt the per-site camera probation
 * and silent-PHC checks. Returns false when it has already sent a response.
 */
function pinPhc(req, res) {
  if (!req.phc) return true;
  const claimed = req.body && req.body.phcId;
  if (claimed && claimed !== req.phc.phcId) {
    res.status(403).json({
      error: 'phc_mismatch',
      message: `This API key belongs to PHC ${req.phc.phcId}, but the request names ${claimed}.`,
    });
    return false;
  }
  if (req.body) req.body.phcId = req.phc.phcId;
  return true;
}

// memoryStorage: ingestionService owns the media layout and names the file
// after the case_id the database generates, which is not known until the row is
// inserted. Letting multer write first would leave an orphan under a different
// name that nothing cleans up.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error(`Expected an image, got ${file.mimetype}`),
                     { code: 'NOT_AN_IMAGE' }));
  },
});

// Postgres rejects a malformed UUID with a 22P02 error rather than returning no
// rows, which would surface as a 500 on what is really a bad request. Checking
// the shape first turns those into a clean 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = (res, caseId) => res.status(404).json({
  error: 'case_not_found', message: `No case with id ${caseId}`,
});

// ── POST /api/v1/cases ───────────────────────────────────────────────────────
router.post('/', requirePhcApiKey, upload.single('image'), async (req, res, next) => {
  if (!pinPhc(req, res)) return;
  let caseId;
  try {
    const result = await ingestion.ingestCase({ ...req.body, imageFile: req.file });
    caseId = result.caseId;

    // §C: a retried upload of a capture central already has. Nothing was
    // stored; answer 200 with the existing case so the PHC marks it synced and
    // stops retrying, and do NOT grade the same scan a second time.
    if (result.duplicate) return res.status(200).json(result);

    // Task 8.3: hand grading to the queue and return. This used to be an
    // `await processCase(caseId)` right here, which held the PHC's upload
    // connection open for the whole MATLAB run — tens of seconds, over the bad
    // link this system is built for.
    //
    // The response is unchanged: still 201 { caseId, receivedAt }. What changed
    // is that the case is now 'processing' when it arrives rather than already
    // 'graded', so a client must poll GET /cases/:caseId/status instead of
    // assuming the POST returning means the answer is ready.
    //
    // enqueue() is deliberately NOT awaited beyond its synchronous bookkeeping,
    // and it cannot reject for grading reasons — a grading failure is recorded
    // against the case as status 'error', not returned to a PHC that has
    // already handed over the image and moved on.
    gradingQueue.enqueue(caseId);

    res.status(201).json(result);
  } catch (err) {
    if (err.code === 'patient_not_found') {
      return res.status(404).json({ error: err.code, message: err.message });
    }
    if (err.status === 400 || err.code === 'invalid_json') {
      return res.status(400).json({ error: err.code || 'bad_request', message: err.message });
    }
    next(err);
  }
});

// ── POST /api/v1/cases/summary  (design doc §10.1, backend plan §C.3) ────────
// A lightweight packet -- the same JSON fields as POST /cases minus the image
// -- sent ahead of the image when the link is too thin to move it yet. Creates
// the case as 'awaiting_image'; the later full upload (POST /cases or the
// chunk group, same captureIdRef) fills in that row and starts grading.
// 201 when it created the case, 200 when the capture was already known.
router.post('/summary', requirePhcApiKey, async (req, res, next) => {
  if (!pinPhc(req, res)) return;
  try {
    const result = await ingestion.ingestSummary(req.body || {});
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    if (err.code === 'patient_not_found') {
      return res.status(404).json({ error: err.code, message: err.message });
    }
    if (err.status === 400 || err.code === 'invalid_json') {
      return res.status(400).json({ error: err.code || 'bad_request', message: err.message });
    }
    next(err);
  }
});

// ── Chunked / resumable upload (Task 8.2) ────────────────────────────────────
//
//   POST /api/v1/cases/:captureRef/chunks/init      open or resume a session
//   GET  /api/v1/cases/:captureRef/chunks           what the server already has
//   POST /api/v1/cases/:captureRef/chunks/:index    send one chunk
//   POST /api/v1/cases/:captureRef/chunks/complete  assemble, verify, ingest
//
// For large images on links too poor to finish a single-shot POST. The small
// case stays on POST /cases — chunking a 400 KB image is four extra round trips
// to save nothing, and round trips are the expensive thing on these links.
//
// :captureRef is the PHC's own capture id, so a client that crashed can resume
// without having kept a server-issued token. See chunkedUploadService.js.
//
// ROUTE ORDER IS LOAD-BEARING: '/chunks/init' and '/chunks/complete' are
// declared before '/chunks/:index', because Express matches in declaration
// order and ':index' would otherwise swallow the literal words 'init' and
// 'complete' and try to parse them as chunk numbers.

const chunked = require('../services/chunkedUploadService');

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: chunked.MAX_CHUNK_BYTES },
});

// A chunk is a slice of a file, not a file: it has no image mimetype and will
// not decode on its own, so the image fileFilter used on POST /cases must not
// be applied here. Integrity is enforced by the per-chunk SHA-256 instead, and
// the assembled whole is checked against the declared hash before it is
// allowed anywhere near ingestion.

function sendUploadError(res, err, next) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  return next(err);
}

router.post('/:captureRef/chunks/init', requirePhcApiKey, async (req, res, next) => {
  try {
    if (!pinPhc(req, res)) return;
    res.status(201).json(await chunked.initSession(req.params.captureRef, req.body || {}));
  } catch (err) { sendUploadError(res, err, next); }
});

router.post('/:captureRef/chunks/complete', requirePhcApiKey, async (req, res, next) => {
  try {
    const result = await chunked.completeSession(req.params.captureRef);
    // 200 rather than 201 on a duplicate: the second call created nothing. The
    // caseId is still returned so a client that lost our first response can
    // reconcile without re-uploading.
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) { sendUploadError(res, err, next); }
});

router.get('/:captureRef/chunks', requirePhcApiKey, (req, res, next) => {
  try {
    const session = chunked.getSession(req.params.captureRef);
    if (!session) {
      return res.status(404).json({
        error: 'session_not_found',
        message: `No upload session for ${req.params.captureRef}.`,
      });
    }
    res.json(session);
  } catch (err) { sendUploadError(res, err, next); }
});

router.post('/:captureRef/chunks/:index', requirePhcApiKey, chunkUpload.single('chunk'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'empty_chunk', message: "Send the chunk bytes as the 'chunk' field.",
      });
    }
    const result = await chunked.putChunk(
      req.params.captureRef, req.params.index, req.file.buffer,
      req.body?.sha256 || req.get('x-chunk-sha256'));
    res.json(result);
  } catch (err) { sendUploadError(res, err, next); }
});

// ── GET /api/v1/cases/:caseId/status ─────────────────────────────────────────
// Declared before /:caseId so the literal '/status' suffix is matched by this
// route rather than being swallowed as part of the id parameter.
router.get('/:caseId/status', requireUserOrPhc, async (req, res, next) => {
  // requireUserOrPhc lets a logged-in user of ANY role through; this endpoint
  // exposes nothing but a status word, so no narrower role check is needed.
  const { caseId } = req.params;
  if (!UUID_RE.test(caseId)) return notFound(res, caseId);
  try {
    const status = await ingestion.getCaseStatus(caseId);
    if (!status) return notFound(res, caseId);
    res.json(status);
  } catch (err) { next(err); }
});

// ── GET /api/v1/cases/:caseId ────────────────────────────────────────────────
router.get('/:caseId', anyUser, async (req, res, next) => {
  const { caseId } = req.params;
  if (!UUID_RE.test(caseId)) return notFound(res, caseId);
  try {
    const detail = await ingestion.getCaseDetail(caseId);
    if (!detail) return notFound(res, caseId);
    await logAccess(req.user?.userId, 'view_case', 'case', caseId);
    res.json(detail);
  } catch (err) { next(err); }
});

// ── POST /api/v1/cases/:caseId/review  (Task 3.5) ────────────────────────────
const DECISIONS = ['confirm', 'override'];
const OVERRIDE_CATEGORIES = ['artifact_misread', 'lesion_missed',
                             'wrong_severity', 'image_quality_issue'];

router.post('/:caseId/review', ophthalmologist, async (req, res, next) => {
  const { caseId } = req.params;
  const {
    decision, overrideReasonCategory, overrideReasonText, reviewDurationSeconds,
    correctedGrade,
  } = req.body || {};

  // Who reviewed comes from the session, never from the body, once someone is
  // logged in -- a client-supplied id is exactly the unverifiable attribution
  // the build audit flagged. The body field survives only for AUTH_ENABLED=false
  // with no one logged in, so the existing frontend keeps working meanwhile.
  const reviewerId = req.user?.userId || req.body?.ophthalmologistId || null;

  if (!UUID_RE.test(caseId)) return notFound(res, caseId);

  if (correctedGrade !== undefined && correctedGrade !== null &&
      !(Number.isInteger(correctedGrade) && correctedGrade >= 0 && correctedGrade <= 4)) {
    return res.status(400).json({
      error: 'invalid_field', message: 'correctedGrade must be an integer 0-4.',
    });
  }

  if (!DECISIONS.includes(decision)) {
    return res.status(400).json({
      error: 'invalid_field',
      message: `decision must be one of: ${DECISIONS.join(', ')}.`,
    });
  }

  // A confirm carries no reason; an override must carry one of the four
  // categories. The database enforces this too (override_requires_category),
  // but a CHECK violation surfaces as a 500 — catching it here gives the
  // reviewer an actionable 400 instead.
  if (decision === 'confirm' && overrideReasonCategory) {
    return res.status(400).json({
      error: 'invalid_field',
      message: "overrideReasonCategory must be null when decision is 'confirm'.",
    });
  }
  if (decision === 'override' && !OVERRIDE_CATEGORIES.includes(overrideReasonCategory)) {
    return res.status(400).json({
      error: 'invalid_field',
      message: `overrideReasonCategory must be one of: ${OVERRIDE_CATEGORIES.join(', ')}.`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const exists = await client.query('SELECT 1 FROM cases WHERE case_id = $1', [caseId]);
    if (!exists.rows.length) {
      await client.query('ROLLBACK');
      return notFound(res, caseId);
    }

    // FOR UPDATE: a concurrent claim on this case waits for this review to land
    // rather than interleaving with the checks below.
    const graded = await client.query(`
      SELECT branch_agreement, claimed_by, claimed_at,
             claimed_at > now() - make_interval(mins => $2) AS claim_live
      FROM grading_results WHERE case_id = $1 FOR UPDATE
    `, [caseId, cfg.CLAIM_TTL_MINUTES]);
    const g = graded.rows[0];

    // No grading result means there is nothing to confirm or override: the case
    // is still processing, awaiting its image, or failed. Recording a review
    // against it would produce an audited clinical decision about a grade that
    // does not exist -- and, on a referable-looking override, an SMS for it.
    if (!g) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'case_not_graded',
        message: 'This case has no grading result yet, so there is nothing to review.',
      });
    }

    // §10.8: a live claim by SOMEONE ELSE blocks this decision. Only checkable
    // when the reviewer is known, i.e. someone is logged in.
    if (g.claimed_by && g.claim_live && req.user && g.claimed_by !== req.user.userId) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'case_claimed',
        message: 'Another reviewer holds this case. Claim it first once their claim expires.',
        claimedBy: g.claimed_by,
        claimedAt: g.claimed_at.toISOString(),
      });
    }

    // §10.9: when the branches disagree there is no single model grade to
    // "confirm", so the only way forward is an explicit grade. Enforced here,
    // not only by hiding the button, so no client can skip it.
    if (g.branch_agreement === false) {
      if (decision === 'confirm' || !Number.isInteger(correctedGrade)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'explicit_grade_required',
          message: 'Branch A and Branch B disagree on this case. Submit an override ' +
                   'with correctedGrade (0-4); a plain confirm is not accepted.',
        });
      }
    }

    const inserted = await client.query(`
      INSERT INTO ophthalmologist_reviews
        (case_id, ophthalmologist_id, decision,
         override_reason_category, override_reason_text, review_duration_seconds,
         corrected_grade)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING review_id
    `, [caseId, reviewerId, decision,
        decision === 'override' ? overrideReasonCategory : null,
        overrideReasonText || null,
        Number.isInteger(reviewDurationSeconds) ? reviewDurationSeconds : null,
        decision === 'override' && Number.isInteger(correctedGrade) ? correctedGrade : null]);

    const reviewId = inserted.rows[0].review_id;

    // An override is a labelled correction: the ophthalmologist has told us the
    // model was wrong AND why. That is the training signal the continual
    // learning loop consumes (design doc §6.11), so it is recorded in the same
    // transaction as the review — a review whose correction row failed to write
    // would be silently lost from retraining, and nothing downstream would ever
    // notice the gap.
    if (decision === 'override') {
      await client.query(
        'INSERT INTO corrections (case_id, review_id) VALUES ($1, $2)', [caseId, reviewId]);
    }

    // The retraining corpus. Every review labels a real image -- an override
    // says the grade is X, a confirm says the model's grade was right, and both
    // are a human's judgement on that photograph. Written in THIS transaction
    // for the same reason `corrections` is: a label recorded afterwards and
    // best-effort is a label that vanishes whenever the second write fails,
    // leaving a hole in the corpus that nothing downstream can see.
    //
    // `corrections` stays as it is. It is the design doc's §6.11 record of
    // which corrections fed which model version, and this table answers a
    // different question -- what is the labelled image set.
    await datasetCollector.recordLabel(client, {
      caseId, reviewId, decision, reviewerId,
      correctedGrade: Number.isInteger(correctedGrade) ? correctedGrade : undefined,
    });

    await client.query('COMMIT');

    await logAccess(req.user?.userId, 'submit_review', 'case', caseId);

    // ── Task 3.6: referral + patient SMS ──────────────────────────────────
    // AFTER the commit, never inside the transaction. An SMS cannot be rolled
    // back, so it must not be sent from a transaction that might still abort —
    // that would tell a patient to seek care for a review that was never
    // recorded.
    //
    // Failures here do NOT fail the request. The review is already committed
    // and is the clinical record; returning 500 would tell the ophthalmologist
    // their decision was lost when it was not, and they would enter it twice.
    let referral = null;
    try {
      referral = await handleConfirmedReferral(caseId, {
        // Only meaningful on an override — see the note in the service. The
        // contract has no field for it yet; accepted here when supplied.
        correctedGrade: Number.isInteger(req.body?.correctedGrade)
          ? req.body.correctedGrade : undefined,
      });
    } catch (err) {
      console.error(`[cases] referral handling failed for ${caseId}:`, err.message);
    }

    // referralId is surfaced so the reviewer's UI can confirm a referral was
    // raised; smsStatus is deliberately explicit rather than a boolean, because
    // "not configured" and "failed" are very different from "not referable".
    res.json({
      reviewId,
      referralId: referral?.referralId ?? null,
      smsStatus:  referral?.sms?.status ?? null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ── POST /api/v1/cases/:caseId/claim  (backend plan §B.2, design doc §10.8) ──
//
// Opening a case for review claims it. The whole lock is ONE conditional UPDATE:
// it succeeds only if nobody holds the case, the caller already does, or the
// holder's claim has gone stale (CLAIM_TTL_MINUTES, default 30 -- without an
// expiry a reviewer who closes the tab would lock the case forever). Zero rows
// back means someone else holds it, and the reply says who, so the UI can show
// it and disable the decision controls.
//
//   200 { caseId, claimedBy: { userId, name }, claimedAt, expiresAt }
//   409 { error: 'case_claimed', message, caseId, claimedBy, claimedAt, expiresAt }
//   409 { error: 'case_not_graded' }   nothing to review yet
//   404 case_not_found
//   401 when no one is logged in -- a claim with no claimant means nothing, so
//       this endpoint needs a session even while AUTH_ENABLED=false.
router.post('/:caseId/claim', ophthalmologist, async (req, res, next) => {
  const { caseId } = req.params;
  if (!UUID_RE.test(caseId)) return notFound(res, caseId);
  if (!req.user) {
    return res.status(401).json({
      error: 'unauthenticated', message: 'Log in to claim a case for review.',
    });
  }

  const shape = (row) => ({
    caseId,
    claimedBy: { userId: row.claimed_by, name: row.claimant_name ?? null },
    claimedAt: row.claimed_at.toISOString(),
    expiresAt: new Date(row.claimed_at.getTime() + cfg.CLAIM_TTL_MINUTES * 60000).toISOString(),
  });

  try {
    const { rows } = await pool.query(`
      UPDATE grading_results g
      SET claimed_by = $2, claimed_at = now()
      WHERE g.case_id = $1
        AND (g.claimed_by IS NULL
             OR g.claimed_by = $2
             OR g.claimed_at <= now() - make_interval(mins => $3))
      RETURNING g.claimed_by, g.claimed_at,
                (SELECT name FROM users WHERE user_id = g.claimed_by) AS claimant_name
    `, [caseId, req.user.userId, cfg.CLAIM_TTL_MINUTES]);

    if (rows.length) {
      await logAccess(req.user.userId, 'claim_case', 'case', caseId);
      return res.json(shape(rows[0]));
    }

    const held = await pool.query(`
      SELECT g.claimed_by, g.claimed_at, u.name AS claimant_name
      FROM grading_results g LEFT JOIN users u ON u.user_id = g.claimed_by
      WHERE g.case_id = $1
    `, [caseId]);
    if (!held.rows.length) {
      const exists = await pool.query('SELECT 1 FROM cases WHERE case_id = $1', [caseId]);
      if (!exists.rows.length) return notFound(res, caseId);
      return res.status(409).json({
        error: 'case_not_graded', message: 'This case has not been graded yet.',
      });
    }
    return res.status(409).json({
      error: 'case_claimed',
      message: `${held.rows[0].claimant_name || 'Another reviewer'} is reviewing this case.`,
      ...shape(held.rows[0]),
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/cases/:caseId/report  (backend plan §O) ─────────────────────
// The clinical-rationale PDF. Generated on first request and cached; a case
// re-graded since is regenerated automatically; ?regenerate=1 forces it.
//   200 { reportUrl: '/media/cases/<id>/report.pdf', generatedAt, cached }
//   409 case_not_graded | 404 case_not_found | 502 report_generation_failed
// The PDF itself is fetched from /media, which requires a session.
const caseReport = require('../services/caseReport');
router.get('/:caseId/report', anyUser, async (req, res, next) => {
  const { caseId } = req.params;
  if (!UUID_RE.test(caseId)) return notFound(res, caseId);
  try {
    const out = await caseReport.getOrCreateReport(caseId, {
      force: req.query.regenerate === '1' || req.query.regenerate === 'true',
    });
    if (!out) return notFound(res, caseId);
    if (out.error === 'case_not_graded') {
      return res.status(409).json({
        error: 'case_not_graded', message: 'A report can only be generated once the case is graded.',
      });
    }
    await logAccess(req.user?.userId, 'view_report', 'case', caseId);
    res.json(out);
  } catch (err) {
    // The full MATLAB error (paths, stack, licence text) goes to the server
    // log; the reviewer gets a short statement. A raw MATLAB dump on a
    // clinician's screen is neither actionable for them nor safe to expose.
    console.error(`[cases] report for ${caseId} failed:`, err.message);
    res.status(502).json({
      error: 'report_generation_failed',
      message: 'The evidence report could not be generated on the server. '
        + 'The grade and evidence on this screen are unaffected; an administrator can find the cause in the server log.',
    });
  }
});

// ── GET /api/v1/cases/:caseId/reviews  (backend plan §B.3) ──────────────────
//
// Review history, newest first. reviewer is null for reviews recorded before
// login existed, when ophthalmologist_id was a free-text client value that may
// not match any user -- the raw value is still returned as ophthalmologistId.
router.get('/:caseId/reviews', anyUser, async (req, res, next) => {
  const { caseId } = req.params;
  if (!UUID_RE.test(caseId)) return notFound(res, caseId);
  try {
    const exists = await pool.query('SELECT 1 FROM cases WHERE case_id = $1', [caseId]);
    if (!exists.rows.length) return notFound(res, caseId);

    const { rows } = await pool.query(`
      SELECT r.review_id, r.decision, r.override_reason_category, r.override_reason_text,
             r.corrected_grade, r.review_duration_seconds, r.reviewed_at,
             r.ophthalmologist_id, u.user_id, u.name AS reviewer_name
      FROM ophthalmologist_reviews r
      LEFT JOIN users u ON u.user_id::text = r.ophthalmologist_id
      WHERE r.case_id = $1
      ORDER BY r.reviewed_at DESC
    `, [caseId]);

    await logAccess(req.user?.userId, 'view_reviews', 'case', caseId);

    res.json(rows.map((r) => ({
      reviewId:               r.review_id,
      decision:               r.decision,
      overrideReasonCategory: r.override_reason_category ?? null,
      overrideReasonText:     r.override_reason_text ?? null,
      correctedGrade:         r.corrected_grade ?? null,
      reviewDurationSeconds:  r.review_duration_seconds ?? null,
      reviewedAt:             r.reviewed_at.toISOString(),
      reviewer:               r.user_id ? { userId: r.user_id, name: r.reviewer_name } : null,
      ophthalmologistId:      r.ophthalmologist_id ?? null,
    })));
  } catch (err) { next(err); }
});

// ── Upload errors ────────────────────────────────────────────────────────────
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig ? 'image_too_large' : 'upload_failed',
      message: tooBig ? 'Image exceeds the 25 MB limit.' : err.message,
    });
  }
  if (err && err.code === 'NOT_AN_IMAGE') {
    return res.status(400).json({ error: 'invalid_image_type', message: err.message });
  }
  next(err);
});

module.exports = router;
