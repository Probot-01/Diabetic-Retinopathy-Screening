-- Up Migration
-- =============================================================================
-- §A (backend plan): authentication and access control.
-- =============================================================================

-- ── PHC device keys (§A.12) ─────────────────────────────────────────────────
-- A PHC app is a device submitting data, not a person logging in, so it gets a
-- per-site API key instead of a session. Only a SHA-256 of the key is stored:
-- the plaintext is printed once by scripts/provisionPhcKey.js and then exists
-- only in that PHC's local config. A database dump therefore does not hand out
-- working credentials for every site. SHA-256 rather than bcrypt because the
-- key is 32 random bytes, not a human-chosen password -- there is nothing for a
-- slow hash to protect against, and the lookup runs on every sync request.
ALTER TABLE phc_sites ADD COLUMN IF NOT EXISTS api_key_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_phc_sites_api_key_hash
  ON phc_sites(api_key_hash) WHERE api_key_hash IS NOT NULL;

-- ── Access log (§A.13) ──────────────────────────────────────────────────────
-- Who read or changed which patient data, and when. Written explicitly from
-- each handler via services/accessLog.js rather than inferred from the URL.
--
-- resource_id is TEXT, not UUID: most resources are UUID-keyed cases, but
-- patients are keyed by the PHC-generated TEXT id, and a column that cannot
-- hold a patient id would force patient reads out of the log.
CREATE TABLE IF NOT EXISTS access_log (
  log_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(user_id),
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  "timestamp"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_access_log_user     ON access_log(user_id, "timestamp");
CREATE INDEX IF NOT EXISTS idx_access_log_resource ON access_log(resource_type, resource_id);

-- Down Migration
DROP TABLE IF EXISTS access_log;
DROP INDEX IF EXISTS uq_phc_sites_api_key_hash;
ALTER TABLE phc_sites DROP COLUMN IF EXISTS api_key_hash;
