-- Up Migration
-- =============================================================================
-- 0019  Engine provenance -- which engine produced each ML output of a case
--
-- Standing rule: every case records which engine (matlab / python /
-- js-fallback) produced each ML output, and no engine switch is silent. Until
-- now nothing did: segInfer.py fell back from the MATLAB session to PyTorch
-- and only printed it to stderr, and the MATLAB_ALLOW_FALLBACK JS path left
-- no trace on the case at all.
--
-- grading_results.engine_provenance -- written by gradingOrchestrator at
--   grading time: { classifier, segmentation: { vessel, localization,
--   hardExudate, redLesion } | null, ruleEngine }, each entry
--   { engine, fallback, detail } or null.
--
-- cases.quality_gate_engine -- the PHC's quality gate runs BEFORE the case
--   exists centrally, so its engine arrives with the case (ingestion field
--   qualityGateEngine) and is stored on the case, not on the grading result.
--
-- NULL in either column means NOT RECORDED -- graded (or captured) before this
-- migration, or by a client that does not report it yet. It never means
-- "MATLAB": provenance is reported, not inferred from configuration.
-- =============================================================================

ALTER TABLE grading_results
  ADD COLUMN IF NOT EXISTS engine_provenance JSONB;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS quality_gate_engine JSONB;

-- Down Migration
ALTER TABLE cases DROP COLUMN IF EXISTS quality_gate_engine;
ALTER TABLE grading_results DROP COLUMN IF EXISTS engine_provenance;
