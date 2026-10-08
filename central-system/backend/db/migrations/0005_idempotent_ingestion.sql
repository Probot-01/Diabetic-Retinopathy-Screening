-- Up Migration
-- =============================================================================
-- §C (backend plan) / design doc §10.6: one PHC capture = one central case.
--
-- capture_id_ref is the PHC's own capture id, carried on every submission as an
-- idempotency key. Without a uniqueness constraint a retried upload (the
-- response was lost on a bad link, the PHC tries again) creates a second case
-- and a second grading run for the same scan.
-- =============================================================================

-- ── 1. Existing duplicates ──────────────────────────────────────────────────
-- The constraint cannot be added over rows that already violate it. On the dev
-- database these are all one test capture id that scripts/seedTestCase.js
-- reused on every run. Nothing is deleted: the NEWEST row keeps the real id and
-- every older one is relabelled '<id>~dup-<n>', so all cases, grades and
-- reviews survive and the relabelled ones stay recognisable.
WITH ranked AS (
  SELECT case_id, capture_id_ref,
         ROW_NUMBER() OVER (PARTITION BY capture_id_ref
                            ORDER BY received_at DESC, case_id) AS rn
  FROM cases
  WHERE capture_id_ref IS NOT NULL
)
UPDATE cases c
SET capture_id_ref = r.capture_id_ref || '~dup-' || (r.rn - 1)
FROM ranked r
WHERE c.case_id = r.case_id AND r.rn > 1;

ALTER TABLE cases ADD CONSTRAINT cases_capture_id_ref_unique UNIQUE (capture_id_ref);

-- ── 2. Summary-first cases (POST /api/v1/cases/summary) ─────────────────────
-- Under thin connectivity a PHC sends a lightweight summary packet (patient,
-- questionnaires, capture metadata -- no image) ahead of the image (design doc
-- §10.1). That creates the case row early, in a new state 'awaiting_image';
-- the full upload later fills the SAME row and moves it to 'processing'.
--
-- So image_path may now be NULL -- but only while awaiting the image. The CHECK
-- keeps every other status exactly as strict as before: no case can be graded,
-- queued or errored without an image on record.
ALTER TABLE cases ALTER COLUMN image_path DROP NOT NULL;
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_status_check;
ALTER TABLE cases ADD CONSTRAINT cases_status_check
  CHECK (status IN ('awaiting_image', 'processing', 'graded', 'error'));
ALTER TABLE cases ADD CONSTRAINT cases_image_required_unless_awaiting
  CHECK (status = 'awaiting_image' OR image_path IS NOT NULL);

-- Down Migration
-- Refuses (via the NOT NULL) if summary-only cases exist; delete or complete
-- them first. The relabelled duplicate ids are deliberately not restored.
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_image_required_unless_awaiting;
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_status_check;
ALTER TABLE cases ADD CONSTRAINT cases_status_check
  CHECK (status IN ('processing', 'graded', 'error'));
ALTER TABLE cases ALTER COLUMN image_path SET NOT NULL;
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_capture_id_ref_unique;
