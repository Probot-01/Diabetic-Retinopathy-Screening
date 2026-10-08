"""
preprocessBranchATensor.py — the ONLY entry point the MATLAB backend uses to
get Branch A input pixels. Exists so gradingOrchestrator.js's two Branch A
backends (python, matlab) see IDENTICAL input by construction, not by two
implementations trying to independently agree.

    python preprocessBranchATensor.py <imagePath> <outputMatPath>

Calls branchAInfer.preprocess() directly -- the EXACT function
branchAInfer.py's own Python inference path calls for every image. There is
no second preprocessing implementation here, in this file or anywhere else:
this file's only job is to call that one function and serialize its result.

WHY THIS FILE EXISTS AT ALL (2026-09-19): MATLAB used to carry its own port
of the same chain (preprocessModel1.m / preprocessForBranchA.m), kept in
lockstep with ben_graham.py by hand. That port measured SSIM 0.981 against
the Python reference -- small in pixel terms, but on a 10-image real-data
comparison it flipped the predicted grade on 1 image and the conformal tier
on 2, even though the imported network itself matched Python to 2e-6 given
identical input (training/parityCheck.m). The fix was not a tighter port; it
was removing the second implementation. preprocessModel1.m and
preprocessForBranchA.m's 'model1' recipe are no longer on Branch A's
critical path -- see docs/model-handoff-guide.md and
ml-pipeline/inference/branchAInferMatlab.m for the same note.

Output .mat (scipy.io.savemat -- full float precision, not a lossy format):
  x        (384,384,3,1) single, SSCB layout (H,W,C,N), ImageNet-normalized
           -- ready for dlarray(x,'SSCB') and predict() with no further
           transformation.
  display  (384,384,3) uint8, ben_graham-enhanced RGB -- the SAME pixels `x`
           was computed from, one step before normalization. This is what
           MATLAB's gradCam.m overlays the heatmap onto; it must be the
           enhanced image (what the network actually saw), not
           branchAInfer.py's own unenhanced `display_base` (that one is for
           THIS process's own Grad-CAM path only -- see preprocess()'s
           docstring in branchAInfer.py).

Exit codes: 0 success, 2 bad arguments, 3 preprocessing failed (unreadable
image, missing checkpoint metadata) -- same convention as branchAInfer.py.
"""
import argparse
import os
import sys

import numpy as np
import scipy.io as sio

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import branchAInfer as bai  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image", nargs="?")
    ap.add_argument("outputMat", nargs="?")
    args = ap.parse_args()

    if not args.image or not args.outputMat:
        print("usage: preprocessBranchATensor.py <imagePath> <outputMatPath>", file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(args.image):
        print(f"preprocessBranchATensor: no file at {args.image}", file=sys.stderr)
        sys.exit(3)

    try:
        # Only the four metadata fields preprocess() reads, from the on-disk
        # cache when the checkpoint is unchanged -- see load_preprocess_meta().
        meta = bai.load_preprocess_meta()
        x, _display_base, enhanced = bai.preprocess(args.image, meta)  # x: (1,3,H,W) NCHW float32

        hwcn = np.transpose(x, (2, 3, 1, 0)).astype(np.float32)  # NCHW -> HWCN (MATLAB SSCB)
        sio.savemat(args.outputMat, {
            "x": hwcn,
            "display": enhanced.astype(np.uint8),
        })
        print(args.outputMat)
        return 0
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - stdout carries only the output path on success
        print(f"preprocessBranchATensor: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    raise SystemExit(main())
