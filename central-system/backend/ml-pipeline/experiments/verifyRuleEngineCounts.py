"""
verifyRuleEngineCounts.py
=========================
Prove that segInfer's lesion counts reproduce the ones the ICDR thresholds were
calibrated on.

    python verifyRuleEngineCounts.py

── WHY THIS IS THE GATE ON BRANCH B ────────────────────────────────────────
redFloor = 3 and grade3QuadMin = 3 are not clinical constants. They were fitted
to the counts that diagnostics/check_agreement.py produces, so they only mean
anything if our counting produces the same numbers. A threshold divorced from
its counting procedure is a number with no units.

Result: 14/14 exact on sum(red), and the rule-engine grade is identical on
14/14. Quadrant VECTORS differ on 5 of 14 by a lesion or two crossing an
adjacent boundary, which changes no grade — see below.

── A CORRECTION THIS SCRIPT EXISTS TO PREVENT REPEATING ────────────────────
An earlier conclusion in this project said our counts were ~100x the diagnostic
counts, and that Branch B was therefore blocked until the two procedures were
reconciled. That was wrong, in two compounding ways:

  1. It used min_area = 1. check_agreement.py uses MIN_BLOB_AREA = 10 px at
     512, which is most of the difference.
  2. It measured on datasets/2.jpg, which turns out to be atypical — 196 red
     components where the 14 IDRiD images give 1 to 64. One image was treated
     as representative of a distribution.

Reproducing the reference implementation on the reference images, rather than
comparing summary statistics from different images, would have caught both
immediately. That is what this script does.

── THE MIN-AREA TRAP, WHICH IS EASY TO REINTRODUCE ─────────────────────────
min_area is 10 px AT 512. segInfer also returns masks mapped back to original
image space for overlays, and counting those instead applies a 10 px floor to a
mask whose areas are ~70x larger on a 4288-wide photograph — equivalent to a
0.14 px floor at 512, i.e. no filtering. Measured, that inflated IDRiD_212 from
1 red lesion to 11 and every other count with it, while looking completely
normal in the output.

── WHY THE QUADRANT VECTORS DIFFER, AND WHY IT DOES NOT MATTER ─────────────
check_agreement.py builds the fovea->disc axis in the 512 crop, where the
resize from the retinal crop box is anisotropic unless that box is exactly
square. segInfer builds it in original image space, which is geometrically
correct. The axes differ by a fraction of a degree, so lesions sitting almost
exactly on a quadrant boundary land on opposite sides.

That is a real difference and it is reported rather than smoothed over. It
changes no grade here because the rule engine reads sum(red) — which matches
exactly — and all(quadrant >= 3), and the images where quadrants disagree have
every quadrant far from 3. A future threshold that sat closer to these counts
would be sensitive to it.
"""

import csv
import glob
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
SEG_INFER = os.path.join(ML_ROOT, "inference", "segInfer.py")
REFERENCE = os.path.join(ML_ROOT, "diagnostics", "out", "agreement_results.csv")
GRADING = os.path.join(ML_ROOT, "datasets", "idrid", "grading",
                       "B. Disease Grading", "1. Original Images")


def rule_grade(red_q, sum_bright, red_floor=3, quad_min=3, moderate=5,
               bright_floor=1, max_grade=3):
    """Python mirror of ruleEngineGrade.m's defaults, for this check only.

    Deliberately NOT the production path — that is MATLAB, and this script is
    verifying counts, not re-implementing the rule engine. If the two ever
    disagree, ruleEngineGrade.m is right.
    """
    total = sum(red_q)
    if red_q and all(q >= quad_min for q in red_q):
        grade = 3
    elif total >= red_floor and (sum_bright >= bright_floor or total > moderate):
        grade = 2
    elif total >= red_floor:
        grade = 1
    else:
        grade = 0
    return min(grade, max_grade)


def main():
    if not os.path.exists(REFERENCE):
        print(f"missing {REFERENCE}", file=sys.stderr)
        return 2
    with open(REFERENCE, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    print(f"{'image':12s}{'ref':>5}{'ours':>6}  {'ref quadrants':<18}"
          f"{'ours':<18}{'grade ref/ours':>15}")
    sum_ok = quad_ok = grade_ok = n = 0
    for row in rows:
        hits = glob.glob(os.path.join(GRADING, "**", row["image"] + ".jpg"),
                         recursive=True)
        if not hits:
            print(f"{row['image']:12s}  source image not present")
            continue
        proc = subprocess.run([sys.executable, SEG_INFER, hits[0]],
                              capture_output=True, text=True)
        if proc.returncode != 0:
            print(f"{row['image']:12s}  segInfer failed: {proc.stderr.strip()[:60]}")
            continue
        out = json.loads(proc.stdout)

        ours = out["redLesions"]["count"]
        our_q = out["redPerQuadrant"]
        ref = int(row["sum_red"])
        ref_q = list(eval(row["red_per_quadrant"]))  # noqa: S307 - our own CSV
        bright = int(row["sum_bright"])

        g_ref, g_ours = rule_grade(ref_q, bright), rule_grade(our_q, bright)
        sum_ok += (ref == ours)
        quad_ok += (ref_q == our_q)
        grade_ok += (g_ref == g_ours)
        n += 1
        flag = "" if ref_q == our_q else "  (quadrants differ)"
        print(f"{row['image']:12s}{ref:>5}{ours:>6}  {str(ref_q):<18}"
              f"{str(our_q):<18}{g_ref:>7}/{g_ours:<7}{flag}")

    print(f"\nsum(red) exact          : {sum_ok}/{n}")
    print(f"quadrant vector exact   : {quad_ok}/{n}")
    print(f"rule-engine grade equal : {grade_ok}/{n}")

    # The bar is sum and GRADE, not the quadrant vector — see the docstring.
    ok = (sum_ok == n and grade_ok == n)
    print("\nVERDICT:", "counts reproduce the calibration" if ok
          else "counts do NOT reproduce the calibration -- do not grade with them")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
