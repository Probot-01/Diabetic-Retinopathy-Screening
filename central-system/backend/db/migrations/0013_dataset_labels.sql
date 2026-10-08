-- Up Migration
-- =============================================================================
-- 0013  dataset_labels -- the retraining corpus, written as doctors work
--
-- Every review an ophthalmologist submits is a human-adjudicated label on a
-- real image. `corrections` already records the OVERRIDES (design doc §6.11),
-- but an override is only half the signal: a confirm says "the model was right
-- about this image", which is exactly as much of a label and is the majority of
-- them. Neither table carried what a retraining run actually needs -- the grade
-- itself, which image it belongs to, and whether the image may be used.
--
-- One row per review, not per case. A case reviewed twice yields two rows, and
-- the exporter takes the newest per case: a label is a statement by a named
-- person at a point in time, and overwriting the first one would destroy the
-- record that a reviewer changed their mind.
--
-- ── WHY THE SNAPSHOT COLUMNS ────────────────────────────────────────────────
-- consent_given_at, image_sha256, model_grade and conformal_tier are COPIED
-- here rather than read back through joins at export time. A training corpus
-- must say what was true when the label was made:
--
--   consent_given_at  A patient who withdraws consent tomorrow did not consent
--                     retroactively -- but a row whose consent was never given
--                     must never silently become exportable because someone
--                     later back-filled the patients table either.
--   image_sha256      The label belongs to THE BYTES that were graded. If the
--                     file is replaced, re-encoded or lost, the hash mismatch
--                     is detectable instead of silently mislabelling whatever
--                     sits at that path now. It also dedupes: the same eye
--                     submitted twice is one training example, not two.
--   model_grade       What the model said at review time. Needed to tell a
--                     confirm from an override after the fact, and to measure
--                     drift without re-running an old model version.
--   conformal_tier    The selection bias, recorded rather than guessed. Tier A
--                     cases are auto-cleared and never reviewed, so this corpus
--                     is NOT a random sample of screening -- it is the hard
--                     cases plus whatever Tier B/C caught. Training on it as if
--                     it were representative would skew the model toward
--                     difficulty it already finds difficult.
-- =============================================================================
CREATE TABLE IF NOT EXISTS dataset_labels (
  label_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           UUID NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  review_id         UUID NOT NULL REFERENCES ophthalmologist_reviews(review_id) ON DELETE CASCADE,

  -- The label itself: what a human says this image is.
  label_grade       INTEGER NOT NULL CHECK (label_grade BETWEEN 0 AND 4),
  -- 'confirm' -> the reviewer accepted model_grade; 'override' -> they replaced it.
  label_source      TEXT NOT NULL CHECK (label_source IN ('confirm', 'override')),

  -- Snapshots, per the note above.
  model_grade       INTEGER CHECK (model_grade BETWEEN 0 AND 4),
  conformal_tier    TEXT,
  image_path        TEXT,
  image_sha256      TEXT,
  eye_laterality    TEXT,
  consent_given_at  TIMESTAMPTZ,

  reviewer_id       TEXT,
  labelled_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Set when this label is exported, so a corpus handed to a training run can
  -- be reproduced later. NULL means "not yet used".
  exported_at       TIMESTAMPTZ,
  export_batch      TEXT,

  -- One label per review. A retry of the same review must not double-count a
  -- training example.
  UNIQUE (review_id)
);

CREATE INDEX IF NOT EXISTS dataset_labels_case_idx   ON dataset_labels (case_id, labelled_at DESC);
CREATE INDEX IF NOT EXISTS dataset_labels_export_idx ON dataset_labels (exported_at);
CREATE INDEX IF NOT EXISTS dataset_labels_sha_idx    ON dataset_labels (image_sha256);

-- Down Migration
DROP INDEX IF EXISTS dataset_labels_sha_idx;
DROP INDEX IF EXISTS dataset_labels_export_idx;
DROP INDEX IF EXISTS dataset_labels_case_idx;
DROP TABLE IF EXISTS dataset_labels;
