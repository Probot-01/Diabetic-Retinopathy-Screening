'use strict';

/**
 * datasetCollector.js — turn each review into a labelled training example.
 *
 * When an ophthalmologist decides a case, a human has just labelled a real
 * fundus photograph. recordLabel() captures that, inside the same transaction
 * as the review itself: a label written afterwards, best-effort, is a label
 * that silently goes missing whenever the second write fails, and nothing
 * downstream would ever notice a gap in a training corpus.
 *
 * ── WHAT COUNTS AS A LABEL ──────────────────────────────────────────────────
 * Both decisions do.
 *
 *   override  the reviewer says the grade is X. Label = X. This is the signal
 *             `corrections` was already recording.
 *   confirm   the reviewer says the model's grade is right. Label = the model
 *             grade. Just as much a human judgement, and normally the majority
 *             of reviews — a corpus of overrides alone is a corpus of the
 *             model's mistakes, which trains a model that has only ever seen
 *             its own failures.
 *
 * A confirm whose model grade is unknown is NOT recorded. There is no label to
 * record: "the reviewer agreed with something we cannot name" is not data.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * It does not copy the image anywhere. The bytes already live under
 * media/cases/<caseId>/, and a second copy per review is duplicated patient
 * imagery that must then be secured, backed up and deleted in two places.
 * scripts/exportTrainingSet.js materialises a corpus when someone actually
 * wants one, and stamps the rows it used.
 *
 * It does not decide whether a label may be used for training. It records the
 * consent that existed at labelling time and lets the exporter enforce it —
 * one place to reason about, and the record stays truthful even for rows the
 * export refuses.
 */

const crypto = require('crypto');
const fs = require('fs');

/** SHA-256 of the file, or null when it cannot be read. */
function hashFile(filePath) {
  if (!filePath) return null;
  try {
    // Of the PLAINTEXT image: the hash identifies the photograph, not how it
    // happens to be stored (media may be encrypted at rest, mediaCrypto.js).
    return crypto.createHash('sha256').update(require('./mediaCrypto').readFile(filePath)).digest('hex');
  } catch {
    // A missing or unreadable image is not a reason to fail the review — the
    // clinical record matters more than the training row. Null hash means
    // "unverifiable", and the exporter skips it rather than guessing.
    return null;
  }
}

/**
 * recordLabel(client, { caseId, reviewId, decision, correctedGrade, reviewerId })
 *
 * `client` is the SAME pg client running the review's transaction. Returns the
 * inserted row, or null when there is nothing labellable.
 */
async function recordLabel(client, { caseId, reviewId, decision, correctedGrade, reviewerId }) {
  const { rows } = await client.query(`
    SELECT c.image_path,
           c.eye_laterality_detected, c.eye_laterality_reported,
           g.dr_grade_cnn, g.conformal_tier,
           p.consent_given_at
      FROM cases c
      JOIN patients p ON p.patient_id = c.patient_id
      LEFT JOIN grading_results g ON g.case_id = c.case_id
     WHERE c.case_id = $1
  `, [caseId]);
  if (!rows.length) return null;
  const r = rows[0];

  const modelGrade = Number.isInteger(r.dr_grade_cnn) ? r.dr_grade_cnn : null;
  const labelGrade = decision === 'override'
    ? (Number.isInteger(correctedGrade) ? correctedGrade : null)
    : modelGrade;

  // No grade, no label. An override without correctedGrade is rejected by the
  // route before it gets here; a confirm on an ungraded case cannot happen
  // either (409 case_not_graded). This is the belt for both braces.
  if (!Number.isInteger(labelGrade)) return null;

  const inserted = await client.query(`
    INSERT INTO dataset_labels
      (case_id, review_id, label_grade, label_source, model_grade, conformal_tier,
       image_path, image_sha256, eye_laterality, consent_given_at, reviewer_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (review_id) DO NOTHING
    RETURNING label_id, label_grade, label_source
  `, [
    caseId, reviewId, labelGrade,
    decision === 'override' ? 'override' : 'confirm',
    modelGrade, r.conformal_tier || null,
    r.image_path || null, hashFile(r.image_path),
    r.eye_laterality_detected || r.eye_laterality_reported || null,
    r.consent_given_at || null,
    reviewerId || null,
  ]);

  return inserted.rows[0] || null;
}

module.exports = { recordLabel, hashFile };
