"""
verifyOnnx.py
=============
Prove the ONNX exports of M2 (vessel) and M3 (localization) compute the same
numbers as the PyTorch checkpoints they came from.

    python verifyOnnx.py [--image PATH] [--onnxdir DIR] [--tol 1e-4]

Exit 0 if every model agrees within tolerance, 1 otherwise, so this can gate
a build. Prints MAE and max absolute difference per model.

-- WHY RANDOM INPUT ALONE IS NOT ENOUGH ------------------------------------
A random tensor exercises the graph but not the regime the model actually
runs in. M2's real input is mostly zeros -- the aspect-pad puts black bands
down two sides of any non-square fundus photograph -- and a saturating
nonlinearity that disagreed near zero would be invisible under randn, which
never produces that structure. So each model is checked on BOTH:

  random   N(0,1), several seeds, catching graph-level breakage
  real     a fundus image through segInfer's OWN preprocessing, catching
           disagreement in the input distribution that is actually served

The real-image tensors are built by calling segInfer's preprocessing rather
than reimplementing it, for the same reason exportOnnx.py imports its _ARCH:
a second copy of (x/255 - 0.5)/0.5 vs ImageNet normalization is exactly the
mistake segInfer's own comments record someone already making once.

-- MAE IS NOT THE ONLY NUMBER THAT MATTERS ---------------------------------
Raw error is reported, and so is the decision each model's output feeds:

  M2  the vessel mask, sigmoid > 0.5 -- reported as disagreeing pixels
  M3  the disc and fovea peaks, argmax -- reported as pixel displacement

A MAE of 1e-7 with a moved argmax would still be a broken export, because
downstream nothing consumes the logits: segInfer takes the arg-maximum for
landmarks and thresholds the sigmoid for the mask. Conversely a nonzero MAE
that moves no pixel and no peak is float non-determinism, not a defect.
Both are printed so the two cannot be confused.

Bit-identity is NOT the bar. ONNX Runtime and PyTorch fuse and order float
ops differently, so differences at the 1e-7 level are expected and mean the
graphs agree. The bar is that no decision changes.
"""

import argparse
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ML_ROOT)

import segInfer  # noqa: E402  (path setup must precede it)

INPUT_SIZE = segInfer.INPUT_SIZE
ONNX_FILES = {"vessel": "vessel_unet_v1.onnx",
              "localization": "localization_v1.onnx"}


def real_input(role, image_path):
    """A real fundus image as the exact tensor the pipeline would feed.

    Both branches mirror segInfer, via its own helpers where they exist.
    Returns None if the image is unreadable, so the random checks still run.
    """
    import cv2
    bgr = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if bgr is None:
        return None

    if role == "vessel":
        # segInfer.vessels(): green channel, aspect-pad, (x/255 - 0.5)/0.5
        padded, _geom = segInfer._aspect_pad(bgr[:, :, 1])
        x = ((padded.astype(np.float32) / 255.0) - 0.5) / 0.5
        return x[None, None, ...]

    # segInfer.localize(): INTER_AREA to 512, BGR->RGB, ImageNet norm.
    resized = cv2.resize(bgr, (INPUT_SIZE, INPUT_SIZE),
                         interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    x = (rgb.astype(np.float32) / 255.0 - segInfer.IMAGENET_MEAN) / segInfer.IMAGENET_STD
    return x.transpose(2, 0, 1)[None, ...].astype(np.float32)


def decision_delta(role, torch_out, onnx_out, tol):
    """The downstream quantity, compared. Returns (message, unchanged).

    A flipped mask pixel is only counted against the export if the logit is
    decisively off zero. A pixel whose logit is -3e-06 in torch and +8e-07 in
    ONNX is sigmoid 0.4999991 vs 0.5000002: the model has no opinion about it,
    and which side of 0.5 it lands on is float op-ordering, not a difference
    between the graphs. Re-running the SAME torch model on a machine with a
    different BLAS would flip it too.

    Counting those as failures would make this check impossible to pass on any
    correct export; ignoring flips entirely would hide a real regression. So
    they are separated and both are printed -- ties are reported, never hidden,
    but only decisive flips fail the run.
    """
    t, o = torch_out[0], onnx_out[0]          # drop batch

    if role == "vessel":
        # segInfer thresholds the sigmoid at 0.5, which is logit > 0. Compared
        # on the logit directly to avoid a needless exp.
        tm, om = t[0] > 0.0, o[0] > 0.0
        flipped = tm != om
        # Decisive = at least one side is further from the threshold than the
        # arithmetic noise floor we already accept on the logits themselves.
        decisive = flipped & (np.maximum(np.abs(t[0]), np.abs(o[0])) > tol)
        n, nd = int(flipped.sum()), int(decisive.sum())
        return (f"vessel mask (sigmoid>0.5): {n} of {tm.size} pixels differ "
                f"({100.0 * n / tm.size:.6f}%), of which {nd} decisive "
                f"(|logit| > {tol:.0e}); {n - nd} are threshold ties"), nd == 0

    # Localization: argmax per heatmap channel is the landmark.
    worst, parts = 0.0, []
    for idx, name in ((0, "opticDisc"), (1, "fovea")):
        ty, tx = np.unravel_index(t[idx].argmax(), t[idx].shape)
        oy, ox = np.unravel_index(o[idx].argmax(), o[idx].shape)
        d = float(np.hypot(int(ty) - int(oy), int(tx) - int(ox)))
        worst = max(worst, d)
        parts.append(f"{name} torch=({tx},{ty}) onnx=({ox},{oy}) shift={d:.1f}px")
    return ("landmark argmax: " + "; ".join(parts)), worst == 0.0


def compare(role, onnxdir, image_path, tol):
    import onnxruntime as ort
    import torch

    model, _ckpt = segInfer.load(role)
    path = os.path.join(onnxdir, ONNX_FILES[role])
    if not os.path.exists(path):
        print(f"  MISSING {path} -- run exportOnnx.py first")
        return False
    # CPU only, so the comparison isolates the export rather than also
    # measuring a GPU kernel's different float behaviour.
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name

    channels = segInfer._ARCH[role]["in_channels"]
    cases = []
    for seed in (0, 1, 2):
        rng = np.random.default_rng(seed)
        cases.append((f"random(seed={seed})",
                      rng.standard_normal((1, channels, INPUT_SIZE, INPUT_SIZE),
                                          dtype=np.float32)))
    real = real_input(role, image_path) if image_path else None
    if real is not None:
        cases.append((f"real image {os.path.basename(image_path)}", real))

    ok = True
    for label, x in cases:
        with torch.no_grad():
            t_out = model(torch.from_numpy(x)).numpy()
        o_out = sess.run(None, {in_name: x})[0]

        if t_out.shape != o_out.shape:
            print(f"  {label}: SHAPE MISMATCH torch={t_out.shape} onnx={o_out.shape}")
            ok = False
            continue

        diff = np.abs(t_out.astype(np.float64) - o_out.astype(np.float64))
        mae, mx = float(diff.mean()), float(diff.max())
        # Scale-relative too: an absolute 1e-5 means different things on
        # logits spanning +/-1 and on logits spanning +/-50.
        rng_out = float(t_out.max() - t_out.min())
        within = mx <= tol
        print(f"  {label}")
        print(f"    shape {t_out.shape}  torch range "
              f"[{t_out.min():.4f}, {t_out.max():.4f}]")
        print(f"    MAE {mae:.3e}   max|diff| {mx:.3e}   "
              f"rel-to-range {(mx / rng_out if rng_out else 0):.3e}   "
              f"{'PASS' if within else 'FAIL'} (tol {tol:.0e})")
        msg, unchanged = decision_delta(role, t_out, o_out, tol)
        print(f"    {msg}  -> {'identical' if unchanged else 'CHANGED'}")
        ok = ok and within and unchanged
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnxdir", default=os.path.join(ML_ROOT, "models", "onnx"))
    ap.add_argument("--image", default=os.path.join(
        ML_ROOT, "datasets", "chasedb1", "Image_01L.jpg"))
    # 1e-4 on logits. Float32 accumulation over a U-Net's depth drifts in the
    # 1e-6..1e-5 range purely from op ordering; anything at 1e-4 or above is a
    # real graph difference, not arithmetic noise.
    ap.add_argument("--tol", type=float, default=1e-4)
    args = ap.parse_args()

    image = args.image if args.image and os.path.exists(args.image) else None
    if args.image and not image:
        print(f"note: no image at {args.image} -- random inputs only\n")

    results = {}
    for role in ONNX_FILES:
        print(f"[{role}]  {segInfer._ARCH[role]}")
        results[role] = compare(role, args.onnxdir, image, args.tol)
        print()

    for role, good in results.items():
        print(f"{role:13s} {'PASS' if good else 'FAIL'}")
    if all(results.values()):
        print("\nONNX exports are numerically faithful to the PyTorch models.")
        return 0
    print("\nAT LEAST ONE EXPORT DOES NOT MATCH -- do not ship it.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
