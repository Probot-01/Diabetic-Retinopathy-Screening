-- Up Migration
-- =============================================================================
-- Additive columns from the backend plan's §L list. Each is nullable, so none
-- of them changes the behaviour of existing code until something writes it.
-- =============================================================================

-- §F: last time a PHC made ANY contact (full case, summary packet or chunk).
-- Deliberately separate from last_sync_at, which keeps its narrower meaning of
-- "a full case landed" and feeds the existing PHC Health sync indicator. A site
-- on a poor link that only gets summaries through is in contact, and must not
-- trip the silent-PHC alert just because no full sync completed.
ALTER TABLE phc_sites ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMPTZ;

-- §M: when the patient gave consent, as captured by the PHC app.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS consent_given_at TIMESTAMPTZ;

-- §B.2: which reviewer has claimed a case. Set only by the conditional UPDATE
-- in POST /cases/:caseId/claim, which is the whole locking mechanism.
ALTER TABLE grading_results
  ADD COLUMN IF NOT EXISTS claimed_by UUID REFERENCES users(user_id);
ALTER TABLE grading_results ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- §I: localization could not place the fovea reliably, so quadrant-dependent
-- rules fall back to the image axis and the case is held to at least Tier B.
-- NULL means "not reported" (older cases, or before the field ships).
ALTER TABLE segmentation_outputs ADD COLUMN IF NOT EXISTS fovea_unreliable BOOLEAN;

-- §O: path of the generated PDF clinical-rationale report.
ALTER TABLE explainability_outputs ADD COLUMN IF NOT EXISTS rationale_report_path TEXT;

-- Down Migration
ALTER TABLE explainability_outputs DROP COLUMN IF EXISTS rationale_report_path;
ALTER TABLE segmentation_outputs   DROP COLUMN IF EXISTS fovea_unreliable;
ALTER TABLE grading_results        DROP COLUMN IF EXISTS claimed_at;
ALTER TABLE grading_results        DROP COLUMN IF EXISTS claimed_by;
ALTER TABLE patients               DROP COLUMN IF EXISTS consent_given_at;
ALTER TABLE phc_sites              DROP COLUMN IF EXISTS last_contact_at;
