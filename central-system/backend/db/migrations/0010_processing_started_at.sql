-- Up Migration
-- =============================================================================
-- When the case entered 'processing' -- which is NOT when it was received.
--
-- The watchdog (§D) and System Health's stuck-job check (§F) both measured
-- "how long has this been processing?" from cases.received_at. That was the
-- same instant until summary-first ingestion (§C) arrived: a case can now be
-- created from a summary packet and sit in 'awaiting_image' for days before
-- the image turns up on a thin link. Measuring from received_at would report
-- such a case as stuck the moment grading started, and would let the watchdog
-- consider it overdue immediately.
--
-- Backfilled to received_at, which is exactly right for every case created
-- before summary packets existed.
-- =============================================================================
ALTER TABLE cases ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
UPDATE cases SET processing_started_at = received_at WHERE processing_started_at IS NULL;

-- Down Migration
ALTER TABLE cases DROP COLUMN IF EXISTS processing_started_at;
