'use strict';

/**
 * routes/phc.js
 *
 * Mounted at /api/v1/phc.
 *
 *   GET /api/v1/phc/:phcId/sync-status
 *     -> 200 { phcId, phcName, lastSyncAt, pendingCount }
 *
 *   GET /api/v1/phc/cases/:captureRef/report   (PHC key) -> 200 graded result
 *   GET /api/v1/phc/cases/:captureRef/gradcam  (PHC key) -> 200 image/png
 *
 * Backs the admin interface's "PHC Health" screen (design doc §5.3): which
 * sites are keeping up and which are silently falling behind.
 *
 * ── Read lastSyncAt and pendingCount together ───────────────────────────────
 * pendingCount is a number the PHC last REPORTED, not one this server computes.
 * The sync queue lives in that PHC's local SQLite and central has no view into
 * it. So the count is only true as of lastSyncAt — and the site whose backlog
 * is genuinely growing is exactly the offline one whose number is frozen at
 * whatever it was when it last made contact.
 *
 * That inverts the obvious reading: a PHC reporting pendingCount 0 with a
 * lastSyncAt three days old is a much bigger problem than one reporting 40
 * from a minute ago. Anything built on this endpoint should surface the
 * staleness, not just the count.
 */

const fs = require('fs');
const express = require('express');
const analytics = require('../services/analyticsAggregator');
const ingestion = require('../services/ingestionService');
const pool = require('../db/pgClient');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { requirePhcApiKey } = require('../middleware/requirePhcApiKey');
const { logAccess } = require('../services/accessLog');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPTURE_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * findOwnCase(req, res) -- the case a PHC submitted under :captureRef, or null
 * after sending a 404.
 *
 * A case belonging to another site is reported as NOT FOUND, not 403: a 403
 * would confirm to one PHC that another site has a capture with that id.
 * With PHC_AUTH_ENABLED=false and no key, req.phc is unset and the lookup is
 * unscoped -- the same leniency POST /cases has in that mode.
 */
async function findOwnCase(req, res) {
  const { captureRef } = req.params;
  const notFound = () => res.status(404).json({
    error: 'case_not_found', message: `No case for capture ${captureRef}`,
  });
  if (!CAPTURE_REF_RE.test(captureRef)) { notFound(); return null; }

  const { rows } = await pool.query(`
    SELECT c.case_id, c.phc_id, e.gradcam_path
    FROM cases c
    LEFT JOIN explainability_outputs e ON e.case_id = c.case_id
    WHERE c.capture_id_ref = $1
  `, [captureRef]);
  const row = rows[0];
  if (!row || (req.phc && row.phc_id && row.phc_id !== req.phc.phcId)) {
    notFound();
    return null;
  }
  return row;
}

// ── GET /api/v1/phc/cases/:captureRef/report ────────────────────────────────
// The graded result, for the PHC front-end that submitted the capture (mobile
// app "full report"). Keyed on the PHC's own capture id, which is the only id
// an offline-first client is guaranteed to hold.
//
// Deliberately narrower than GET /api/v1/cases/:caseId: no questionnaire, no
// urgency score (a queue-ordering hint for reviewers, not something to show a
// technician), no patient reference, no claim state. The PHC already has the
// patient's identity; this adds only what central computed, plus whether an
// ophthalmologist has confirmed it -- the AI grade is advisory until then
// (design doc §1.5), and the client must be able to say so.
router.get('/cases/:captureRef/report', requirePhcApiKey, async (req, res, next) => {
  try {
    const own = await findOwnCase(req, res);
    if (!own) return;

    const d = await ingestion.getCaseDetail(own.case_id);
    if (!d) {
      return res.status(404).json({
        error: 'case_not_found', message: `No case for capture ${req.params.captureRef}`,
      });
    }

    const review = (await pool.query(`
      SELECT decision, corrected_grade, reviewed_at
      FROM ophthalmologist_reviews
      WHERE case_id = $1
      ORDER BY reviewed_at DESC
      LIMIT 1
    `, [own.case_id])).rows[0];

    const graded = (await pool.query(
      'SELECT graded_at FROM grading_results WHERE case_id = $1', [own.case_id])).rows[0];

    res.json({
      captureRef:        req.params.captureRef,
      caseId:            d.caseId,
      status:            d.status,
      failureCode:       d.failureCode,
      gradedAt:          graded && graded.graded_at ? graded.graded_at.toISOString() : null,
      modelVersion:      d.modelVersion,
      drGradeCnn:        d.drGradeCnn,
      drGradeRuleEngine: d.drGradeRuleEngine,
      branchAgreement:   d.branchAgreement,
      confidenceScore:   d.confidenceScore,
      uncertaintyScore:  d.uncertaintyScore,
      conformalTier:     d.conformalTier,
      tierReason:        d.tierReason,
      lesionCounts:      d.lesionCounts,
      nvSuspicionScore:  d.nvSuspicionScore,
      evidenceSummaryText: d.evidenceSummaryText,
      eyeLaterality:     d.eyeLaterality,
      eyeLateralityMismatch: d.eyeLateralityMismatch,
      foveaUnreliable:   d.foveaUnreliable,
      gradCamAvailable:  !!(own.gradcam_path && fs.existsSync(own.gradcam_path)),
      review: review
        ? {
          decision:       review.decision,
          correctedGrade: review.corrected_grade ?? null,
          reviewedAt:     review.reviewed_at.toISOString(),
        }
        : null,
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/phc/cases/:captureRef/gradcam ───────────────────────────────
// The GradCAM overlay PNG for the report above. /media requires a user
// session, which a PHC device never has, so the image is served here under
// the same own-case check instead.
router.get('/cases/:captureRef/gradcam', requirePhcApiKey, async (req, res, next) => {
  try {
    const own = await findOwnCase(req, res);
    if (!own) return;
    if (!own.gradcam_path || !fs.existsSync(own.gradcam_path)) {
      return res.status(404).json({
        error: 'gradcam_not_available', message: 'No GradCAM overlay exists for this case.',
      });
    }
    // Decrypted here: media may be encrypted at rest (services/mediaCrypto.js).
    res.type('png').send(require('../services/mediaCrypto').readFile(own.gradcam_path));
  } catch (err) { next(err); }
});

// Backs the admin's PHC Health screen, so district_admin only.
router.get('/:phcId/sync-status', requireAuth, requireRole('district_admin'), async (req, res, next) => {
  const { phcId } = req.params;
  if (!UUID_RE.test(phcId)) {
    return res.status(404).json({
      error: 'phc_not_found', message: `No PHC site with id ${phcId}`,
    });
  }
  try {
    const status = await analytics.getPhcSyncStatus(phcId);
    if (!status) {
      return res.status(404).json({
        error: 'phc_not_found', message: `No PHC site with id ${phcId}`,
      });
    }
    await logAccess(req.user?.userId, 'view_phc_sync_status', 'phc_site', phcId);
    res.json(status);
  } catch (err) { next(err); }
});

module.exports = router;
