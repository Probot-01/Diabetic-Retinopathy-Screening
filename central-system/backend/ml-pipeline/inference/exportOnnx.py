"""
exportOnnx.py
=============
Export M2 (vessel) and M3 (localization) to ONNX.

    python exportOnnx.py [--outdir DIR] [--opset 14]

Writes <outdir>/vessel_unet_v1.onnx and <outdir>/localization_v1.onnx,
default outdir models/onnx/. Run verifyOnnx.py afterwards -- an export that
loads and runs is not the same as an export that computes the same numbers.

── THE ARCHITECTURE IS NOT RESTATED HERE ───────────────────────────────────
This imports segInfer.load() rather than rebuilding smp.Unet from its own
copy of the encoder/channel settings. A second copy of _ARCH would be free to
drift from the one inference actually uses, and the failure is silent in the
worst way: strict=True catches a wrong encoder, but nothing catches an ONNX
file exported from a correct-but-different arch than the one serving traffic.
One definition, imported.

── CHANNEL COUNTS DIFFER BETWEEN THE TWO MODELS ────────────────────────────
M2 is in_channels=1, NOT 3. It is fed the green channel alone (segInfer's
vessels() slices bgr[:, :, 1]), aspect-padded to 512 and normalised
(x/255 - 0.5)/0.5. M3 is in_channels=3, ImageNet-normalised, and emits 2
heatmap channels (optic disc, fovea).

So the dummy input shape is taken from _ARCH['<role>']['in_channels'], not
assumed to be 3. Exporting M2 at 3 channels does not fail at export time --
it fails at the first conv, or worse, succeeds against a wrongly-shaped
tensor someone fed it to make the error go away.

── BATCH IS DYNAMIC, SPATIAL SIZE IS NOT ───────────────────────────────────
dynamic_axes frees axis 0 only. Both models are U-Nets whose skip connections
concatenate encoder and decoder feature maps, and those line up at 512x512;
letting H/W float in the graph would export shape arithmetic that is only
exercised at other sizes, which nothing in this pipeline uses. The whole
pipeline resizes to 512 before inference in every path.
"""

import argparse
import os
import sys

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ML_ROOT)

import segInfer  # noqa: E402  (path setup must precede it)

INPUT_SIZE = segInfer.INPUT_SIZE

# role -> output filename. Named after the checkpoint so the .onnx sitting
# next to the .pt is obviously the same model.
EXPORTS = {
    "vessel":       "vessel_unet_v1.onnx",
    "localization": "localization_v1.onnx",
}


def export(role, outdir, opset):
    model, _ckpt = segInfer.load(role)          # strict=True load, .eval()
    channels = segInfer._ARCH[role]["in_channels"]
    dummy = torch.randn(1, channels, INPUT_SIZE, INPUT_SIZE)

    # Sanity-check in torch BEFORE exporting. If the arch and the dummy shape
    # disagree, the error should name that, not surface from inside the
    # exporter's tracer where it reads as an ONNX problem.
    with torch.no_grad():
        out = model(dummy)

    path = os.path.join(outdir, EXPORTS[role])
    torch.onnx.export(
        model,
        dummy,
        path,
        opset_version=opset,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        do_constant_folding=True,
        # The legacy tracer, explicitly. torch 2.9+ defaults dynamo=True, and
        # the two exporters produce different graphs; pinning it means the
        # file does not change shape because the torch version moved.
        dynamo=False,
    )
    return path, tuple(dummy.shape), tuple(out.shape)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default=os.path.join(ML_ROOT, "models", "onnx"))
    ap.add_argument("--opset", type=int, default=14)
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    for role in EXPORTS:
        path, ishape, oshape = export(role, args.outdir, args.opset)
        mb = os.path.getsize(path) / 1e6
        print(f"{role:13s} in={ishape} out={oshape} opset={args.opset} "
              f"-> {path} ({mb:.1f} MB)")

    # Structural check. onnx.checker validates the graph is well-formed; it
    # says nothing about whether the numbers match, which is verifyOnnx.py's
    # job and is the only check that actually matters.
    import onnx
    for fname in EXPORTS.values():
        onnx.checker.check_model(os.path.join(args.outdir, fname))
    print("onnx.checker: all models structurally valid")
    print("NEXT: python verifyOnnx.py   (numerical equivalence)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
