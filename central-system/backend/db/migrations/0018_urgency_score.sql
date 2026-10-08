-- Up Migration
-- =============================================================================
-- 0018  Triage urgency score -- a QUEUE ORDERING HINT, and nothing more
--
-- grading/calculateUrgencyScore.m produces a 1-100 urgency from the DR grade
-- plus age, years diabetic and HbA1c. Read that file's header before using
-- any of these columns: THE MODEL IS TRAINED ON SYNTHETIC DATA. The forest
-- learns a formula that file invents, so the score is a re-expression of an
-- assumption in the vocabulary of a trained model. It has never been
-- validated against a patient outcome.
--
-- That makes it legitimate for ordering a review queue -- explicit and
-- inspectable beats an unwritten instinct -- and illegitimate as a clinical
-- claim. It must never reach the referral decision, the conformal tier, or
-- the patient SMS.
--
-- ── WHY urgency_inputs IS NOT OPTIONAL BOOKKEEPING ─────────────────────────
-- The PHC questionnaire collects glycemicControl as 'good'/'moderate'/'poor'
-- and yearsSinceDiagnosis as buckets, while the function wants a float HbA1c
-- and an integer year count. A score built from a bucket midpoint is far
-- coarser than one built from a lab value, and six months later nothing
-- distinguishes them unless the inputs were stored WITH their provenance.
-- So urgency_inputs records each value and whether it was measured or
-- assumed. Without it a score cannot be explained or reproduced.
--
-- ── NULL MEANS NOT COMPUTED ────────────────────────────────────────────────
-- When HbA1c or years-diabetic is absent, no score is stored. Not 1, not 0,
-- not an imputed guess. A missing lab value becoming "urgency 1" would be a
-- fabricated clinical statement about a real patient, and 1 is a legitimate
-- score, so it cannot be distinguished from a real low-urgency result.
-- The CHECK below therefore starts at 1 and NULL is always allowed.
-- =============================================================================

ALTER TABLE grading_results
  ADD COLUMN IF NOT EXISTS urgency_score  INTEGER
    CONSTRAINT grading_results_urgency_score_range
    CHECK (urgency_score IS NULL OR (urgency_score BETWEEN 1 AND 100)),
  ADD COLUMN IF NOT EXISTS urgency_factor TEXT,
  ADD COLUMN IF NOT EXISTS urgency_inputs JSONB;

COMMENT ON COLUMN grading_results.urgency_score IS
  'Triage urgency 1-100 from calculateUrgencyScore.m. QUEUE ORDERING ONLY -- the model is trained on SYNTHETIC data and has never been validated against an outcome. NULL means not computed (missing clinical inputs), never low urgency.';

COMMENT ON COLUMN grading_results.urgency_factor IS
  'Which input contributed most for this patient, by exact Shapley attribution over the four inputs.';

COMMENT ON COLUMN grading_results.urgency_inputs IS
  'Exactly what went into the score, each value tagged measured or assumed, so the number can be explained and reproduced later.';

-- Down Migration
ALTER TABLE grading_results
  DROP CONSTRAINT IF EXISTS grading_results_urgency_score_range,
  DROP COLUMN IF EXISTS urgency_score,
  DROP COLUMN IF EXISTS urgency_factor,
  DROP COLUMN IF EXISTS urgency_inputs;
