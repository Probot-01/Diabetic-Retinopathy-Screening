'use strict';

/**
 * syncReadiness.js -- which sync_queue rows are actually READY to upload.
 *
 * A capture is queued the moment it clears the quality gate (captureHandler),
 * but at that moment the technician has not yet filled in the patient
 * questionnaire or the capture-metadata questionnaire. Design doc §8.1 step 4
 * sends "image + patient data + both questionnaires" together. Uploading on the
 * gate alone raced the technician's form time: the sync loop (10 s) usually won,
 * central stored and GRADED the case with questionnaire_data and
 * capture_metadata NULL, and the answers recorded a minute later were never
 * sent because the row was already 'synced'. That is a silent loss of exactly
 * the data the "no skip" rule exists to guarantee.
 *
 * So a row is ready only when BOTH answer sets exist for its capture. Until then
 * it stays 'pending' in the queue (the image is safe on disk) and counts as
 * "awaiting forms", not as "pending upload".
 *
 * Shared by the sync loop, GET /sync/status and GET /captures so the three can
 * never disagree about what "pending" means.
 */

const db = require('../db/localDb');

/** SQL predicate over a sync_queue row aliased `q`: both questionnaires recorded. */
const FORMS_COMPLETE_SQL = `
  EXISTS (SELECT 1 FROM questionnaire_responses qr WHERE qr.capture_id = q.capture_id)
  AND EXISTS (SELECT 1 FROM capture_metadata_responses cm WHERE cm.capture_id = q.capture_id)`;

/** Rows waiting to be uploaded: pending AND their forms are complete. */
function countPending() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM sync_queue q
    WHERE q.status = 'pending' AND ${FORMS_COMPLETE_SQL}`).get().n;
}

/** Passed-the-gate captures still waiting for a questionnaire (not uploadable yet). */
function countAwaitingForms() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM sync_queue q
    WHERE q.status = 'pending' AND NOT (${FORMS_COMPLETE_SQL})`).get().n;
}

module.exports = { FORMS_COMPLETE_SQL, countPending, countAwaitingForms };
