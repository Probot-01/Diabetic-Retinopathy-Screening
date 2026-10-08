-- Up Migration
-- =============================================================================
-- §G (backend plan): output of the district resource model, one row per run.
-- Written by services/resourceRecommendations.js (daily, or on demand), read by
-- GET /api/v1/admin/resource-recommendations. A table rather than a results
-- file: queryable, timestamped, and it keeps the history of what was advised.
--
-- min_ophthalmologists_* are NULL when the model's search hit its ceiling
-- without meeting the p95 target -- "more than max_searched" must never be
-- stored as a number that looks like it works.
-- =============================================================================
CREATE TABLE IF NOT EXISTS resource_recommendations (
  recommendation_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  min_ophthalmologists_routine  INTEGER,
  min_ophthalmologists_camp     INTEGER,
  max_searched                  INTEGER,
  p95_target_min                REAL,
  bottleneck                    TEXT NOT NULL,
  recommendation                TEXT NOT NULL,
  current_state                 JSONB,          -- the staffed-as-today simulation
  params                        JSONB NOT NULL, -- every input the model ran on
  inputs_source                 JSONB NOT NULL, -- which params were OBSERVED vs defaults
  model                         TEXT NOT NULL,  -- 'referenceQueueingModel'
  run_seconds                   REAL
);
CREATE INDEX IF NOT EXISTS idx_resource_recommendations_generated
  ON resource_recommendations(generated_at DESC);

-- Down Migration
DROP TABLE IF EXISTS resource_recommendations;
