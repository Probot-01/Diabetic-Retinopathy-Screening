"""
exportModel1Predictions.py
==========================
Bridge Branch A's saved predictions from .npy into CSV, so the MATLAB
calibration code (calibrateBranchA.m, via refitCalibration.m) can read them.

    python exportModel1Predictions.py                      # branchA_v1 (default)
    python exportModel1Predictions.py --model-version branchA_v2a

Writes {val,test}_{logits,labels}.csv into the resolved model directory:
    branchA_v1  -> models/Model1/                (unchanged from before)
    branchA_v2a -> models/Model1/v2a/

── WHY LOGITS AND NOT PROBABILITIES ────────────────────────────────────────
Temperature scaling divides LOGITS by T before the softmax. Handing it
probabilities means taking a log to recover the logits, which is lossy where
a probability has already saturated to 1.0 or underflowed to 0. The
checkpoint saved raw pre-softmax logits precisely so this step is exact.

── VAL AND TEST ARE BOTH JUST "CALIBRATION POOL INPUT" NOW ────────────────
Earlier (score v2), val was the calibration fold and test the genuinely
untouched evaluation split, and they were never allowed to mix. Under the
current protocol (score v3, calibrateBranchA.m) val+test are POOLED for the
final fit -- a cross-fit study showed val-only calibration is not
trustworthy at the per-stratum n a single split gives. This script still
exports both splits SEPARATELY (calibrateBranchA.m does the pooling, not
this script) so the caller retains the option to treat them differently if
a future protocol needs to.
"""

import argparse
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

MODEL_VERSIONS = {
    "branchA_v1":  {"npy_prefix": "branchA_v1", "dir": os.path.join(HERE, "models", "Model1")},
    "branchA_v2a": {"npy_prefix": "branchA_v2a", "dir": os.path.join(HERE, "models", "Model1", "v2a")},
    "branchA_v2b": {"npy_prefix": "branchA_v2b", "dir": os.path.join(HERE, "models", "Model1", "v2b")},
    "branchA_v2c": {"npy_prefix": "branchA_v2c", "dir": os.path.join(HERE, "models", "Model1", "v2c")},
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-version", choices=sorted(MODEL_VERSIONS), default="branchA_v1")
    args = ap.parse_args()

    cfg = MODEL_VERSIONS[args.model_version]
    model_dir = cfg["dir"]
    prefix = cfg["npy_prefix"]

    for split in ("val", "test"):
        logits = np.load(os.path.join(model_dir, f"{prefix}_{split}_logits.npy"))
        labels = np.load(os.path.join(model_dir, f"{prefix}_{split}_labels.npy"))

        if logits.shape[0] != labels.shape[0]:
            raise SystemExit(
                f"{split}: {logits.shape[0]} logit rows but {labels.shape[0]} labels")
        if logits.shape[1] != 5:
            raise SystemExit(f"{split}: expected 5 classes, got {logits.shape[1]}")

        # %.17g round-trips a float64 exactly. Fewer digits would quietly
        # change the fitted temperature in the last decimal places, which is
        # a silly way to introduce a discrepancy into a calibration constant.
        np.savetxt(os.path.join(model_dir, f"{split}_logits.csv"),
                   logits, delimiter=",", fmt="%.17g")
        np.savetxt(os.path.join(model_dir, f"{split}_labels.csv"),
                   labels.astype(int), delimiter=",", fmt="%d")

        counts = np.bincount(labels.astype(int), minlength=5)
        print(f"{split:5s}  n={len(labels):4d}  grade counts {counts.tolist()}")

    print(f"\n[{args.model_version}] written to {model_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
