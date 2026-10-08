-- Up Migration
-- =============================================================================
-- 0016  Where a capture actually came from: its file format, and the device
--       the file itself names
--
-- runCasePipeline.m and matlabFallback.js have BOTH been returning
-- sourceFormat and dicomDeviceModel on every case since DICOM support landed
-- (plan SP). Nothing read them. They were computed, serialised, returned
-- across the MATLAB boundary, and dropped.
--
-- That is worse than merely wasteful, because readFundusImage.m's header
-- states the intent as already satisfied:
--
--     "A DICOM file names the device that took the photograph, which is
--      better evidence than the worker's dropdown -- and it is deliberately
--      NOT substituted here. [...] The device is recorded as evidence
--      instead, in out.dicomDeviceModel."
--
-- It was not recorded anywhere. Either the claim goes or the column does;
-- the column is the better half to keep, because the fact is genuinely
-- useful and cannot be recovered later -- the capture is re-read only during
-- grading.
--
-- WHY NOT REUSE camera_device_id. That column is the WORKER'S dropdown
-- selection. This is what the image file says about itself. Keeping them
-- apart is the same reported-vs-detected split the schema already makes for
-- camera_family_detected and eye_laterality_detected, and collapsing them
-- would destroy exactly the disagreement worth seeing.
--
-- Both are NULL for an ordinary JPEG capture, and dicom_device_model is NULL
-- even for a DICOM file that carries no device tag. NULL means "not stated by
-- the file", never "no device".
-- =============================================================================

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS source_format      TEXT,
  ADD COLUMN IF NOT EXISTS dicom_device_model TEXT;

COMMENT ON COLUMN cases.source_format IS
  'Container the capture arrived in, as readFundusImage saw it: jpg, png, dicom, ... NULL for rows graded before migration 0016.';

COMMENT ON COLUMN cases.dicom_device_model IS
  'Device model named by the DICOM file itself (evidence), as opposed to cases.camera_device_id which is the worker''s dropdown selection. NULL when the capture is not DICOM or carries no device tag.';

-- Down Migration
ALTER TABLE cases
  DROP COLUMN IF EXISTS source_format,
  DROP COLUMN IF EXISTS dicom_device_model;
