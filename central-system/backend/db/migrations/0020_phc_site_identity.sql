-- Up Migration
-- =============================================================================
-- 0020  PHC site identity: a short code and a district
--
-- GET /api/v1/admin/phcs lists every PHC site with its code (PHC001) and
-- district. Neither was stored: the code lived only in the seed script and in
-- each PHC's own .env, and there was no district at all.
--
-- Both are NULLABLE and stay NULL when nobody has recorded them -- the API
-- reports null, never a guess. phc_code is unique when set, because it is what a
-- person says aloud to identify a site.
-- =============================================================================

ALTER TABLE phc_sites
  ADD COLUMN IF NOT EXISTS phc_code TEXT,
  ADD COLUMN IF NOT EXISTS district TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_phc_sites_phc_code
  ON phc_sites (phc_code) WHERE phc_code IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS uq_phc_sites_phc_code;
ALTER TABLE phc_sites DROP COLUMN IF EXISTS district;
ALTER TABLE phc_sites DROP COLUMN IF EXISTS phc_code;
