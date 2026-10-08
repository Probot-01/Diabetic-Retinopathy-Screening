-- Up Migration
-- =============================================================================
-- 0014  Why a case failed, in the database instead of only in a log line
--
-- markError() wrote status = 'error' and nothing else. 62 of the 117 cases in
-- the development database are in that state and the database cannot say why
-- any of them failed: the reason existed only in the server's stdout at the
-- time, which is gone. An operator looking at the admin dashboard sees a
-- number, not a cause, and during a demo "it says error" is the whole of the
-- available information.
--
-- Three columns, because three different questions get asked:
--
--   failure_code      The classification the queue already computes and then
--                     throws away -- image_not_found, matlab_unavailable,
--                     python_unavailable and so on. Stable enough to GROUP BY,
--                     which is what turns 62 mystery failures into "58 of them
--                     are the same missing-executable problem".
--   failure_reason    The message, truncated. What a human reads when the code
--                     is not enough. Never shown to a patient-facing surface;
--                     it can quote internal paths and library errors.
--   failed_at         When it gave up -- distinct from received_at, and the
--                     only way to tell a failure from this morning's run from
--                     one left over from two weeks ago.
--
-- All three are CLEARED when a case is re-queued or grades successfully. A
-- stale reason on a case that has since worked is worse than no reason: it
-- describes a state that no longer exists, and someone will act on it.
--
-- The existing 62 rows keep NULL in all three. Back-filling a guessed cause
-- would be inventing history; "we did not record it" is the honest value, and
-- the code below distinguishes that from "no failure" by reading status.
-- =============================================================================
ALTER TABLE cases ADD COLUMN IF NOT EXISTS failure_code   TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS failed_at      TIMESTAMPTZ;

-- The dashboard asks for recent failures grouped by cause; a partial index
-- keeps that off a sequential scan without indexing the graded majority.
CREATE INDEX IF NOT EXISTS idx_cases_failed
  ON cases (failed_at DESC) WHERE status = 'error';

-- Down Migration
DROP INDEX IF EXISTS idx_cases_failed;
ALTER TABLE cases DROP COLUMN IF EXISTS failed_at;
ALTER TABLE cases DROP COLUMN IF EXISTS failure_reason;
ALTER TABLE cases DROP COLUMN IF EXISTS failure_code;
