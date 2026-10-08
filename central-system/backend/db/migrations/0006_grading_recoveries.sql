-- Up Migration
-- =============================================================================
-- §D.3 (backend plan): a record every time a stranded grading job is
-- re-enqueued, so System Health (§F) can show "case X was auto-recovered N
-- times" instead of a case being retried silently forever.
--
-- source: 'boot'     -- recoverStranded() at server start (a restart left it)
--         'watchdog' -- the periodic sweep (it went missing while running)
-- =============================================================================
CREATE TABLE IF NOT EXISTS grading_recoveries (
  recovery_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      UUID NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('boot', 'watchdog')),
  recovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_grading_recoveries_case ON grading_recoveries(case_id, recovered_at);

-- Down Migration
DROP TABLE IF EXISTS grading_recoveries;
