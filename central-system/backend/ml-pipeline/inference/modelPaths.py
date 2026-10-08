"""
modelPaths.py
=============
Find a model checkpoint by FILENAME, anywhere under ml-pipeline/models/.

    from modelPaths import resolve_checkpoint
    path = resolve_checkpoint("branchA_v1.pt")

── WHY THIS IS NOT JUST A CONSTANT ─────────────────────────────────────────
The weights are not in git. They are 16-280 MB each, two of them over GitHub's
100 MB per-file limit, so they are distributed out of band and live only on
whichever machine someone copied them onto. That has two consequences this
module exists to handle.

FIRST: the folder layout is not stable. The five checkpoints currently sit in
Model1/, vessel_predictions(Model2)/, Model3/, Model4/ and
red_lesion_predictions(model5)/ — three different naming conventions, and
Tanuj's handover notes that an IDE keeps reorganising them. A hardcoded
"models/Model1/branchA_v1.pt" breaks the moment anyone tidies the directory,
and it breaks on a machine where the files were unzipped into a different
shape. The filename is the stable identifier; the path is not.

SECOND: an absent checkpoint must fail LOUDLY and say what is missing. This
already happened once. A teammate's commit deleted branchA_v1.pt from the repo;
merging it removed the file from the working tree, and the next grading call
would have failed inside model loading. Without a clear message that reads as
"a build artefact you have to obtain separately is missing", it looks like a
code bug and gets debugged as one.

So the error below names the file, the directory searched, and how to fix it,
rather than letting a FileNotFoundError surface from three frames deep.

── AMBIGUITY IS AN ERROR, NOT A COIN FLIP ──────────────────────────────────
If two files with the same name exist under models/, this raises rather than
picking the first. Duplicate checkpoints are usually a half-finished
reorganisation or an older copy left behind, and silently loading whichever one
os.walk reached first would mean the pipeline's behaviour depends on directory
iteration order. That is precisely the kind of difference that shows up as an
unreproducible grade and is nearly impossible to trace afterwards.
"""

import os

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
MODELS_DIR = os.path.join(ML_ROOT, "models")

# Filenames, as the source of truth. Folder names deliberately absent.
#
# GATE 4 RENAME (M5 phase 2): the role key for the exudate-detection model is
# "hard_exudate", not "bright_lesion" -- bright_lesion/brightLesion was never
# clinically accurate (soft exudates are also "bright") and is renamed here
# and everywhere this role is looked up (segInfer.py's _ARCH/load() calls,
# verifySegModels.py). The FILENAME (an artifact name, not an identifier) is
# deliberately UNCHANGED: bright_lesion_unet_v1.pt/.mat/.onnx, and every JSON
# key sent to the backend (brightLesions, brightPerQuadrant,
# verified.brightLesion) are also unchanged -- see segInfer.py's own
# GATE-4 comment at those keys.
CHECKPOINTS = {
    "classifier":     "branchA_v1.pt",
    "classifier_v2a": "branchA_v2a.pt",   # BRANCH_A_MODEL_VERSION=branchA_v2a -- see branchAInfer.py
    "classifier_v2b": "branchA_v2b.pt",   # BRANCH_A_MODEL_VERSION=branchA_v2b -- see branchAInfer.py
    "classifier_v2c": "branchA_v2c.pt",   # BRANCH_A_MODEL_VERSION=branchA_v2c -- see branchAInfer.py
    "vessel":         "vessel_unet_v1.pt",
    "localization":   "localization_v1.pt",
    "hard_exudate":   "bright_lesion_unet_v1.pt",   # GATE 4: role renamed, filename (artifact) unchanged
    "red_lesion":     "red_lesion_unet_v1.pt",
    "red_lesion_v2":  "red_lesion_unet_v2.pt",   # RED_LESION_MODEL_VERSION=v2 -- see segInfer.py
}


class CheckpointMissing(FileNotFoundError):
    """Raised when a checkpoint is not under models/. Distinct from a generic
    FileNotFoundError so callers can tell 'the operator has not installed the
    weights' apart from 'the image path was wrong'."""


def find_checkpoints(filename, models_dir=MODELS_DIR):
    """Every path under models_dir whose basename matches. May be empty."""
    hits = []
    for dirpath, _dirnames, filenames in os.walk(models_dir):
        if filename in filenames:
            hits.append(os.path.join(dirpath, filename))
    return sorted(hits)


def resolve_checkpoint(filename, models_dir=MODELS_DIR):
    """The one path for this checkpoint, or raise with something actionable."""
    hits = find_checkpoints(filename, models_dir)

    if len(hits) == 1:
        return hits[0]

    if not hits:
        raise CheckpointMissing(
            f"checkpoint '{filename}' not found under {models_dir}.\n"
            f"Model weights are NOT stored in git (16-280 MB each, two of them "
            f"over GitHub's 100 MB file limit) and must be copied in "
            f"separately. Obtain it from the team's model drop and place it "
            f"anywhere under {models_dir} — the folder name does not matter, "
            f"the filename does.")

    raise CheckpointMissing(
        f"checkpoint '{filename}' is AMBIGUOUS — {len(hits)} copies under "
        f"{models_dir}:\n  " + "\n  ".join(hits) +
        "\nRefusing to guess. Two copies of the same checkpoint are usually a "
        "half-finished reorganisation or a stale older version, and loading "
        "whichever one the filesystem returned first would make grades depend "
        "on directory iteration order. Delete the one that is not current.")


def resolve(role, models_dir=MODELS_DIR):
    """resolve_checkpoint by role name ('classifier', 'vessel', ...)."""
    if role not in CHECKPOINTS:
        raise KeyError(f"unknown model role '{role}'; "
                       f"known roles: {sorted(CHECKPOINTS)}")
    return resolve_checkpoint(CHECKPOINTS[role], models_dir)


def audit(models_dir=MODELS_DIR):
    """Which checkpoints are present, for a startup check or a status page.

    Returns {role: path or None}. Deliberately does not raise: the point is to
    report the whole picture at once rather than stopping at the first gap,
    because 'four of five models are installed' is the useful message.
    """
    out = {}
    for role, fname in CHECKPOINTS.items():
        hits = find_checkpoints(fname, models_dir)
        out[role] = hits[0] if len(hits) == 1 else (hits or None)
    return out


if __name__ == "__main__":
    import json
    status = audit()
    print(json.dumps({k: (v if isinstance(v, (str, type(None))) else v)
                      for k, v in status.items()}, indent=2))
    missing = [k for k, v in status.items() if not v]
    if missing:
        print(f"\nMISSING: {', '.join(missing)}")
        raise SystemExit(1)
    print(f"\nall {len(status)} checkpoints resolved")
