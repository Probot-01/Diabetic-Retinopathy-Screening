-- Up Migration
-- =============================================================================
-- 0021  Camera cross-check result -- reported device vs the image itself
--
-- classifyCameraFamily.m compares the camera family it detects in the image
-- against the family the WORKER-REPORTED device implies. Task 6.3 has computed
-- that for every case since it landed, and the result reached nobody:
--
--   * It sets cameraProbationOverride, which writes cases.tier_reason -- but
--     only when the tier would otherwise be A, because the floors run under
--     `if (tier === 'A')`. A mismatch on a case the conformal set already put
--     in Tier B or C leaves no trace at all.
--   * Once a camera/site clears probation (CAMERA_PROBATION_MIN_CASES prior
--     graded cases) the override stops firing entirely, so on an established
--     camera a mismatch is a console.warn and nothing else.
--
-- A reviewer looking at the image cannot re-derive it: it needs the device
-- association table, and the detected family is not stored next to what it was
-- compared against. So it is stored.
--
-- camera_mismatch is deliberately THREE-STATE:
--   true   the cross-check ran and the two disagreed
--   false  the cross-check ran and the two agreed
--   NULL   the cross-check COULD NOT RUN -- no device was reported, or the
--          reported device is not in calibrationProfiles.json's
--          deviceAssociations, so there was no expected family to compare to
--
-- That third state is the whole point of this column. classifyCameraFamily.m
-- returns mismatch = false in the not-checkable case, and storing that false
-- would record "this camera was verified against its image" about a case where
-- nobody could look. Those are different clinical claims.
--
-- camera_expected_family is the family the reported device implies -- the
-- other half of the comparison. Without it "mismatch" is an assertion the
-- reader cannot inspect; with it they can see both sides and judge.
-- =============================================================================

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS camera_mismatch BOOLEAN;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS camera_expected_family TEXT;

COMMENT ON COLUMN cases.camera_mismatch IS
  'Reported device vs detected camera family: true = disagreed, false = agreed, '
  'NULL = the cross-check could not run (device not reported, or not in '
  'deviceAssociations). NULL is never "agreed".';

COMMENT ON COLUMN cases.camera_expected_family IS
  'The camera family the worker-reported device implies, i.e. the other side of '
  'the camera_mismatch comparison. NULL whenever camera_mismatch is NULL.';

-- Down Migration
ALTER TABLE cases DROP COLUMN IF EXISTS camera_expected_family;
ALTER TABLE cases DROP COLUMN IF EXISTS camera_mismatch;
