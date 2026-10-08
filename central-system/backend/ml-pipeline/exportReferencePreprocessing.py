"""
exportReferencePreprocessing.py
===============================
Run the ACTUAL training preprocessing (ben_graham.py) and
write the result to disk, so the MATLAB port in preprocessModel1.m can be
diffed against it rather than against another of my own implementations.

    python exportReferencePreprocessing.py <image> [<image> ...] --out <dir>

Writes, per input image:
    <out>/<stem>_reference.png    what the model was actually trained on

── WHY THIS EXISTS ─────────────────────────────────────────────────────────
Branch A (Model1) was trained on this Python chain. The serving path is MATLAB.
preprocessModel1.m ports the recipe from the Python SOURCE, which is not the
same as matching the Python BINARY: cv2.createCLAHE and adapthisteq normalise
their clip limits differently, cv2.INTER_AREA and imresize are not identical,
and OpenCV's MORPH_ELLIPSE is not MATLAB's strel('disk').

Until the port is checked against this output, "the chains agree" is a claim
about two files I wrote, not about the model's actual input. That distinction
is the whole point — the failure being guarded against is silent, so the
verification has to be real.
"""

import argparse
import os
import sys

import cv2
import numpy as np

# The training preprocessing, imported rather than reimplemented. If these
# files change, this script follows automatically -- which is the point.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preprocessing.ben_graham import ben_graham_preprocess      # noqa: E402


def reference_chain(bgr_image: np.ndarray, target_size: int = 384) -> np.ndarray:
    """The chain training actually used: ben_graham ONLY.

    clahe_enhance.py ships beside it and is exported from
    preprocessing/__init__.py, but it is NOT in the chain. Confirmed twice:
    the checkpoint's own metadata names ben_graham alone, and
    identifyTrainingChain.py reproduces the model's published logits exactly
    with ben_graham only (100.0% class agreement, mean logit difference
    0.0050) and badly with CLAHE added (57.7%).
    """
    return ben_graham_preprocess(bgr_image, target_size=target_size)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("images", nargs="+", help="input fundus image paths")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--size", type=int, default=384,
                    help="target size; must match the trained network (384)")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    for path in args.images:
        # cv2.imread returns BGR, which is what their chain was written against.
        # Passing RGB here would silently swap the red and blue channels -- and
        # in a fundus photograph the red channel is most of the signal, so it
        # would look plausible and be completely wrong.
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        if bgr is None:
            print(f"SKIP  could not read {path}", file=sys.stderr)
            continue

        out = reference_chain(bgr, target_size=args.size)

        stem = os.path.splitext(os.path.basename(path))[0]
        dest = os.path.join(args.out, f"{stem}_reference.png")
        cv2.imwrite(dest, out)   # imwrite expects BGR, which is what we have

        print(f"{path}  ->  {dest}   shape={out.shape} dtype={out.dtype}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
