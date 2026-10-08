-- Up Migration
-- =============================================================================
-- 0017  Register the 512 px classifier family in model_versions
--
-- grading_results.model_version is a FOREIGN KEY into model_versions, and that
-- table held exactly one row: branchA_v1. So the registry was not merely out
-- of date, it made recording the truth IMPOSSIBLE -- writing the model that
-- actually graded a case raised
--   "violates foreign key constraint grading_results_model_version_fkey"
-- and the only value that could be stored was the one hardcoded constant.
-- That is very likely why the constant existed in the first place.
--
-- The fix is not to drop the constraint. The constraint is doing real work:
-- it says a grade may only cite a model somebody registered, with the
-- validation numbers that justified using it. What was missing is the
-- registration.
--
-- Numbers below are each model's own delivered metrics on the SHARED held-out
-- test split (n=628, 550 APTOS + 78 IDRiD), read from
-- models/Model1/<v>/branchA_<v>_metrics.json -- test_pooled.ref_sens,
-- .ref_spec and .qwk. Not re-derived here; these are the ML side's numbers.
--
-- promoted: v2c only. It is the deployed default as of 2026-09-23. Note the
-- honest wrinkle recorded in docs/backend-plan-status.md -- the pre-declared
-- promotion rule selects v2b, and v2c is a DISCLOSED override on its far
-- better false-auto-clear behaviour under domain shift (2.29% vs 12.84%).
-- 'promoted' here means "this is what runs", not "this won the rule".
--
-- v2a and v2b are registered but not promoted: both have real artifacts and
-- can be selected with BRANCH_A_MODEL_VERSION, and a grade produced by either
-- must be able to say so rather than being blocked by the FK.
-- =============================================================================

INSERT INTO model_versions
  (version_id, trained_at, validation_sensitivity, validation_specificity,
   validation_kappa, promoted, promoted_at)
VALUES
  ('branchA_v2a', '2026-09-21T02:16:00Z', 0.900735, 0.938202, 0.873440, false, NULL),
  ('branchA_v2b', '2026-09-22T21:22:00Z', 0.849265, 0.946629, 0.884888, false, NULL),
  ('branchA_v2c', '2026-09-21T19:38:00Z', 0.926471, 0.924157, 0.883875, true,
   '2026-09-23T00:00:00Z')
ON CONFLICT (version_id) DO NOTHING;

-- Down Migration
DELETE FROM model_versions
 WHERE version_id IN ('branchA_v2a', 'branchA_v2b', 'branchA_v2c');
