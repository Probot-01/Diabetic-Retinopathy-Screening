-- Up Migration
-- =============================================================================
-- 0015  Why a case landed in its review tier, in the database instead of
--       nowhere at all
--
-- decideTier() returns { tier, tierReason }. The tier was stored; the reason
-- was used for one console.log on Tier C and then discarded. So the single
-- most useful fact about a queued case -- WHY a human has to look at it -- was
-- not recoverable once the process that graded it had gone.
--
-- That mattered less when the tier came from one place. It now has four
-- distinct floors that all produce the same letter B:
--   * camera/site probation (a family mismatch with no track record)
--   * eye-laterality mismatch between the file and the technician
--   * fovea could not be located, so the quadrant criteria were skipped
--   * unvalidated_camera (no local validation for this camera/site)
-- plus the conformal set's own B, which means something completely different:
-- the model is simply not confident. A reviewer opening the case sees "Tier B"
-- and cannot tell which of the five it is, and neither can an auditor later.
--
-- Nullable with no backfill, deliberately. Rows graded before this migration
-- genuinely do not have a recorded reason, and inventing one -- even a
-- plausible-looking 'conformal prediction set' -- would be fabricating an
-- audit trail. NULL reads as "not recorded", which is the truth.
-- =============================================================================

ALTER TABLE grading_results
  ADD COLUMN IF NOT EXISTS tier_reason TEXT;

COMMENT ON COLUMN grading_results.tier_reason IS
  'Why this case got its conformal_tier: the escalation that fired, or the floor that raised it from A. NULL for rows graded before migration 0015, which means "not recorded", not "no reason".';

-- Down Migration
ALTER TABLE grading_results
  DROP COLUMN IF EXISTS tier_reason;
