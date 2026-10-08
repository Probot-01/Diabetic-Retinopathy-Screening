-- Up Migration
-- =============================================================================
-- Revoking a person's access, without destroying the audit trail.
--
-- Two problems this fixes, both found by trying it:
--
-- 1. DELETE FROM users failed outright once that user had claimed any case:
--    grading_results.claimed_by is a foreign key with the default RESTRICT. So
--    the only reviewer who could be removed was one who had never reviewed
--    anything. A claim is transient state, not history -- it should not
--    outrank removing someone's access.
--
-- 2. Deleting the row is the wrong tool anyway. access_log.user_id and
--    ophthalmologist_reviews point at that user, and an audit trail whose
--    subject can be erased is not an audit trail (design doc §11.1). Reviews
--    must stay attributable after the person leaves.
--
-- So: claimed_by releases the claim on delete, and `is_active` is the intended
-- way to revoke access -- the account stays, its history stays, its sessions
-- stop working within a minute (middleware/requireAuth.js) and it can no
-- longer log in.
-- =============================================================================
ALTER TABLE grading_results DROP CONSTRAINT IF EXISTS grading_results_claimed_by_fkey;
ALTER TABLE grading_results
  ADD CONSTRAINT grading_results_claimed_by_fkey
  FOREIGN KEY (claimed_by) REFERENCES users(user_id) ON DELETE SET NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE users DROP COLUMN IF EXISTS deactivated_at;
ALTER TABLE users DROP COLUMN IF EXISTS is_active;
ALTER TABLE grading_results DROP CONSTRAINT IF EXISTS grading_results_claimed_by_fkey;
ALTER TABLE grading_results
  ADD CONSTRAINT grading_results_claimed_by_fkey
  FOREIGN KEY (claimed_by) REFERENCES users(user_id);
