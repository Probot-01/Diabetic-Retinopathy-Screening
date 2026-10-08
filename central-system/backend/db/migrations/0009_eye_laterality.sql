-- Up Migration
-- =============================================================================
-- Design doc §10.4 / backend plan §P: DR is graded per eye, so every case says
-- which eye it is -- and records WHO said so.
--
--   eye_laterality_reported  what the technician selected (capture metadata),
--                            forwarded by the PHC sync manager
--   eye_laterality_detected  what the image file itself says: DICOM
--                            ImageLaterality (0020,0062), read by
--                            readFundusImage.m. NULL for JPEG/PNG, which carry
--                            no such tag.
--
-- The effective value is detected when present, reported otherwise. When both
-- exist and disagree, the case is not auto-cleared: a mislabelled eye breaks
-- per-eye longitudinal tracking, and a camera's own tag is better evidence
-- than a dropdown.
-- =============================================================================
ALTER TABLE cases ADD COLUMN IF NOT EXISTS eye_laterality_reported TEXT
  CHECK (eye_laterality_reported IN ('left', 'right'));
ALTER TABLE cases ADD COLUMN IF NOT EXISTS eye_laterality_detected TEXT
  CHECK (eye_laterality_detected IN ('left', 'right'));

-- Down Migration
ALTER TABLE cases DROP COLUMN IF EXISTS eye_laterality_detected;
ALTER TABLE cases DROP COLUMN IF EXISTS eye_laterality_reported;
