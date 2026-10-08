-- Up Migration
-- =============================================================================
-- §E.3 / §F (backend plan): conditions a machine noticed but could not safely
-- fix on its own -- today, the MATLAB inference session that will not come
-- back up. "Fails loudly AND someone finds out": the supervisor writes here,
-- GET /api/v1/admin/system-health reads here.
--
-- One OPEN row per (kind, subject): raising an alert that is already open
-- bumps last_seen_at and occurrences instead of adding a row per check, so a
-- condition that persists for a day is one alert, not 2,880.
-- =============================================================================
CREATE TABLE IF NOT EXISTS system_alerts (
  alert_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL,             -- e.g. 'matlab_session_down'
  subject       TEXT NOT NULL DEFAULT '',  -- what it is about, '' when global
  message       TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrences   INTEGER NOT NULL DEFAULT 1,
  resolved_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_system_alerts_open
  ON system_alerts(kind, subject) WHERE resolved_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS system_alerts;
