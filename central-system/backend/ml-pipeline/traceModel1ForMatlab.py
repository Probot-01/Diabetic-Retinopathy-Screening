"""
traceModel1ForMatlab.py
=======================
Trace Branch A (Model1) so MATLAB's importNetworkFromPyTorch can read it.

    python traceModel1ForMatlab.py [--out <path>]

── WHY THIS STEP IS NEEDED ─────────────────────────────────────────────────
branchA_v1.pt is a training CHECKPOINT: a dict holding model_state_dict plus
metadata. importNetworkFromPyTorch cannot read that. It requires a TRACED
model — the graph itself, recorded by running one example through it, saved
with torch.jit.save.

So this rebuilds the architecture from the checkpoint's own `arch` string,
loads the weights, traces it, and writes a file MATLAB can import. It changes
no weights and trains nothing: torch.jit.trace runs the model forward once to
record what operations it performs.

── WHY TRACING CAN CHANGE BEHAVIOUR, AND WHY IT DOES NOT HERE ──────────────
Tracing records the operations executed for ONE input, so any data-dependent
branching is frozen to whichever path that input took. It also freezes
train/eval state — which matters here, because this model has dropout
(drop_rate 0.3). Traced in train mode it would bake in a random mask and
produce different answers every run.

model.eval() before tracing is therefore not a formality. It is the
difference between a deterministic classifier and a broken one.

EfficientNet-B0 has no data-dependent control flow, so the trace is faithful
for every input, not just the example.
"""

import argparse
import os

import numpy as np
import torch
import torch.nn as nn
import timm

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, "models", "Model1")
CKPT = os.path.join(MODEL_DIR, "branchA_v1.pt")


class DRClassifier(nn.Module):
    """Rebuilt from the checkpoint's own `arch` string:
    timm(model_name, num_classes=0, drop_rate=0) -> Dropout -> Linear
    """

    def __init__(self, model_name, num_classes, num_features, drop_rate):
        super().__init__()
        self.backbone = timm.create_model(model_name, pretrained=False,
                                          num_classes=0, drop_rate=0)
        self.dropout = nn.Dropout(drop_rate)
        self.head = nn.Linear(num_features, num_classes)

    def forward(self, x):
        return self.head(self.dropout(self.backbone(x)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(MODEL_DIR, "branchA_v1_traced.pt"))
    args = ap.parse_args()

    ckpt = torch.load(CKPT, map_location="cpu", weights_only=False)
    model = DRClassifier(ckpt["model_name"], ckpt["num_classes"],
                         ckpt["num_features"], ckpt["drop_rate"])
    model.load_state_dict(ckpt["model_state_dict"], strict=True)

    # NOT optional -- see the header. Dropout must be off before tracing.
    model.eval()

    size = ckpt["img_size"]
    example = torch.randn(1, 3, size, size)

    with torch.no_grad():
        traced = torch.jit.trace(model, example)
        traced = torch.jit.freeze(traced)

    torch.jit.save(traced, args.out)

    # Prove the trace matches the eager model before handing it to MATLAB. A
    # trace that silently diverges would look like a MATLAB import problem
    # later, several steps away from its cause.
    with torch.no_grad():
        probe = torch.randn(1, 3, size, size)
        a = model(probe).numpy()
        b = torch.jit.load(args.out)(probe).numpy()
    drift = float(np.abs(a - b).max())

    print(f"wrote {args.out}")
    print(f"input shape      : (1, 3, {size}, {size})")
    print(f"trace vs eager   : max |difference| = {drift:.3e}")
    print("OK" if drift < 1e-4 else "WARNING: trace does not match the eager model")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
