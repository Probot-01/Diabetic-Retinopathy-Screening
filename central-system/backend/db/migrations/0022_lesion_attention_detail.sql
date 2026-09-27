-- Up Migration
-- =============================================================================
-- 0022  Lesion-attention consistency: the numbers that make the score readable
--
-- explainability_outputs.lesion_attention_consistency_score has existed since
-- the initial schema. It is the fraction of Grad-CAM energy falling inside the
-- segmented lesions, and ON ITS OWN IT IS NOT INTERPRETABLE --
-- lesionAttentionConsistency.m's own header says so in as many words:
--
--   "A RAW OVERLAP FRACTION IS NOT INTERPRETABLE. '70% of the attention is on
--    lesions' sounds excellent and can be terrible. If lesions cover 70% of the
--    retina, a heatmap of pure noise scores 0.70 too. The number only means
--    something against its chance level, which is the lesion area fraction."
--
--   "Anything storing the score should store or show the chance level with it."
--
-- Nothing did. The function computes chanceLevel, enrichment and flagged and
-- hands them back in `details`; runCasePipeline.m asked for one output and
-- dropped them, so the score reached the UI as a bare fraction rendered on a
-- 0-1 bar with a green/red threshold -- the exact presentation that header
-- warns is "actively misleading".
--
--   lesion_attention_chance_level  lesion area / ROI area: what a RANDOM
--                                  heatmap would score on this eye.
--   lesion_attention_enrichment    score / chance level. 1.0 is chance,
--                                  above 1 is real attention. This is the
--                                  number a reader should look at.
--   lesion_attention_flagged       enrichment not strictly above 1.0.
--                                  Computed in MATLAB, next to the maths,
--                                  rather than re-derived by each surface.
--
-- All three are NULL when the score could not be computed. flagged is also
-- meaningful in a case where the SCORE is NULL: a heatmap with no energy is
-- undefined-but-flagged, because Grad-CAM producing nothing is itself a
-- reason to review.
-- =============================================================================

ALTER TABLE explainability_outputs
  ADD COLUMN IF NOT EXISTS lesion_attention_chance_level DOUBLE PRECISION;

ALTER TABLE explainability_outputs
  ADD COLUMN IF NOT EXISTS lesion_attention_enrichment DOUBLE PRECISION;

ALTER TABLE explainability_outputs
  ADD COLUMN IF NOT EXISTS lesion_attention_flagged BOOLEAN;

COMMENT ON COLUMN explainability_outputs.lesion_attention_chance_level IS
  'Lesion area / ROI area: what a random heatmap would score on this eye. The '
  'consistency score must be read against this, never alone.';

COMMENT ON COLUMN explainability_outputs.lesion_attention_enrichment IS
  'consistency score / chance level. 1.0 = chance, >1 = real attention.';

COMMENT ON COLUMN explainability_outputs.lesion_attention_flagged IS
  'enrichment not strictly greater than 1.0, i.e. the heatmap told us no more '
  'than a uniform one would. Also true when the heatmap had no energy at all.';

-- Down Migration
ALTER TABLE explainability_outputs DROP COLUMN IF EXISTS lesion_attention_flagged;
ALTER TABLE explainability_outputs DROP COLUMN IF EXISTS lesion_attention_enrichment;
ALTER TABLE explainability_outputs DROP COLUMN IF EXISTS lesion_attention_chance_level;
