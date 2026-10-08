-- Up Migration
-- =============================================================================
-- The ophthalmologist's own grade on an override, persisted.
--
-- POST /cases/:caseId/review has accepted correctedGrade since Task 3.6, but
-- only handed it to the referral/SMS step and never stored it. So the review
-- history (GET /cases/:caseId/reviews, frontend plan §14) could say THAT a
-- reviewer overrode the model but not WHAT grade they gave, and the continual-
-- learning consumer of `corrections` had a correction with no corrected label.
--
-- Nullable: every review recorded before this column existed has no value, and
-- a plain confirm on an agreeing case needs none.
-- =============================================================================
ALTER TABLE ophthalmologist_reviews
  ADD COLUMN IF NOT EXISTS corrected_grade INTEGER
  CHECK (corrected_grade BETWEEN 0 AND 4);

-- Down Migration
ALTER TABLE ophthalmologist_reviews DROP COLUMN IF EXISTS corrected_grade;
