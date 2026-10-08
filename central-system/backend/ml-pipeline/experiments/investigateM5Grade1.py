"""
investigateM5Grade1.py — real evidence for v2 task item 6 ("feed M5's
microaneurysm count into the grade-0-vs-1 decision").

Runs the REAL segInfer.py red-lesion pipeline (M5) on the 4 recovered
held-out IDRiD grade-1 cases (branchA_v1_test_ids.npy) and 6 grade-0
comparison cases from the same recovered split, to check whether a simple
count-vs-redFloor(3) rule (ruleEngineGrade.m's existing threshold) would
actually fix M1's grade-1 recall, or just move the failure mode.

    python investigateM5Grade1.py

Finding (2026-09-19, n=10 -- small, but real, not simulated):

  image        true grade   M5 red count   per-quadrant       >= redFloor(3)?
  IDRiD_203    1            3              [0, 2, 1, 0]       True
  IDRiD_290    1            3              [1, 1, 0, 1]       True
  IDRiD_291    1            1              [0, 0, 0, 1]       False
  IDRiD_021    1            60             [17, 12, 16, 15]   True
  IDRiD_255    0            6              [0, 4, 2, 0]       True   <- FALSE POSITIVE
  IDRiD_267    0            16             [4, 7, 5, 0]       True   <- FALSE POSITIVE
  IDRiD_298    0            3              [3, 0, 0, 0]       True   <- FALSE POSITIVE (boundary)
  IDRiD_351    0            2              [1, 1, 0, 0]       False
  IDRiD_395    0            3              [0, 1, 0, 2]       True   <- FALSE POSITIVE (boundary)
  IDRiD_396    0            0              [0, 0, 0, 0]       False

3 of 6 true grade-0 images produce 3-16 spurious M5 detections -- well above
the "1-2" ruleEngineGrade.m's redFloor=3 docstring cites (that number came
from n=14 images, 2026-09-09, a different and much smaller probe). 1 of 4
true grade-1 images (IDRiD_291, count=1) falls BELOW the floor anyway, so it
would still be missed.

CONCLUSION: a naive "CNN says 0, M5 count >= redFloor => override to grade 1"
rule, on this evidence, would fix at most 3/4 grade-1 misses while actively
mis-escalating roughly half the grade-0 sample tested. That is not a
defensible trade at n=10, and probably not at any n given how noisy the
per-image counts are (0 to 60 across true grade-0 alone).

WHAT WAS ACTUALLY DONE INSTEAD (see grading/ruleEngineGrade.m and
services/gradingOrchestrator.js): the EXISTING branchesAgree() /
branchAgreement-forces-Tier-C mechanism already routes exactly this
disagreement (CNN=0, rule engine>=1) to mandatory human review -- confirmed
by reading branchesAgree.m's `agree = double(gradeA) == double(gradeB)` for
the non-lower-bound case, which covers 0-vs-1 directly. That is the safe
version of "feed M5's count into the decision": a human sees the disagreement
and the evidence, rather than the pipeline silently overwriting a grade on a
noisy count. gradingOrchestrator.js now labels this specific boundary
distinctly (grade0Vs1Disagreement) so it can be monitored and the threshold
revisited with more data -- see that file's tier-decision section.

This script is real, runnable evidence, not a one-off finding to take on
faith -- re-run it against any updated M5 checkpoint or redFloor value.
"""
import json
import os
import subprocess
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parents[1]
SEG_INFER = ML_ROOT / "inference" / "segInfer.py"
PY = os.environ.get("PYTHON_EXECUTABLE", "python")

GRADING_DIR = ML_ROOT / "datasets" / "idrid" / "grading" / "B. Disease Grading" / "1. Original Images"

# Recovered from branchA_v1_test_ids.npy / branchA_v1_test_labels.npy -- the
# SAME held-out split branchA_v1's own evaluation used (see
# recoverHeldOutSplit.py in this folder). Not a fresh random sample.
GRADE1 = {
    "IDRiD_203": "a. Training Set", "IDRiD_290": "a. Training Set",
    "IDRiD_291": "a. Training Set", "IDRiD_021": "b. Testing Set",
}
GRADE0 = {
    "IDRiD_255": "a. Training Set", "IDRiD_267": "a. Training Set",
    "IDRiD_298": "a. Training Set", "IDRiD_351": "a. Training Set",
    "IDRiD_395": "a. Training Set", "IDRiD_396": "a. Training Set",
}

RED_FLOOR = 3  # ruleEngineGrade.m's current threshold


def run(name, subfolder):
    img = GRADING_DIR / subfolder / f"{name}.jpg"
    out = subprocess.run([PY, str(SEG_INFER), str(img)], capture_output=True, text=True)
    if out.returncode != 0:
        print(f"{name}: FAILED rc={out.returncode} stderr={out.stderr[-500:]}")
        return None, None
    start = out.stdout.find("{")
    data = json.loads(out.stdout[start:])
    return data["redLesions"]["count"], data.get("redPerQuadrant")


def main():
    print(f"{'image':14s} {'true grade':10s} {'M5 red count':13s} {'per-quadrant':20s} {'>= redFloor(3)?'}")
    fp, fn = 0, 0
    for name, sub in GRADE1.items():
        c, q = run(name, sub)
        hit = c is not None and c >= RED_FLOOR
        if not hit:
            fn += 1
        print(f"{name:14s} {'1':10s} {str(c):13s} {str(q):20s} {hit}")
    for name, sub in GRADE0.items():
        c, q = run(name, sub)
        hit = c is not None and c >= RED_FLOOR
        if hit:
            fp += 1
        print(f"{name:14s} {'0':10s} {str(c):13s} {str(q):20s} {hit}")

    print(f"\ngrade-1 cases still missed by redFloor={RED_FLOOR}: {fn}/{len(GRADE1)}")
    print(f"grade-0 cases that would be FALSELY escalated: {fp}/{len(GRADE0)}")
    print("\nSee this file's module docstring for the conclusion and what was built instead.")


if __name__ == "__main__":
    main()
