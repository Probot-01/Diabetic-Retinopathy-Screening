"""
test_conformal_v2.py
=====================
Golden-vector and property tests for branchAInfer.py's assign_tier() /
ordinal_mode_interval_score() -- the Python half of conformal policy v3
(score v3, referable-stratified Mondrian, referable-threshold safety gate),
method 'ordinal_mode_interval_stratified_v3'.

Run: pytest tests/test_conformal_v2.py -v

tests/conformal_golden_vectors.json and its expected outputs are generated
by the MATLAB implementation (tests/generateConformalGoldenVectors.m),
against models/calibration_branchA_v2a.json (v2a, the model behind the
switch this policy round is for), and reproduced exactly by both
testConformalV2.m (MATLAB) and this file. That reproduction -- not either
implementation alone -- is what verifies the two have not drifted apart,
since branchAInfer.py's own header explains why Branch A's model runs in
Python while the MATLAB backend's conformal tiering runs in MATLAB: the two
are duplicated by necessity and must be checked against one shared ground
truth.
"""

import json
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
INFERENCE_DIR = os.path.join(os.path.dirname(HERE), "inference")
sys.path.insert(0, INFERENCE_DIR)

from branchAInfer import assign_tier, ordinal_mode_interval_score  # noqa: E402

MODELS_DIR = os.path.join(os.path.dirname(HERE), "models")
CALIB_PATH = os.path.join(MODELS_DIR, "calibration_branchA_v2a.json")
GOLDEN_PATH = os.path.join(HERE, "conformal_golden_vectors.json")

EXPECTED_METHOD = "ordinal_mode_interval_stratified_v3"


def _load_calib():
    with open(CALIB_PATH, "r", encoding="utf-8") as f:
        calib = json.load(f)
    assert calib["method"] == EXPECTED_METHOD, (
        "models/calibration_branchA_v2a.json is not the expected method -- "
        "re-run calibrateBranchA.m / refitCalibration.m")
    calib["calibrated"] = True
    return calib


def _load_golden():
    with open(GOLDEN_PATH, "r", encoding="utf-8") as f:
        golden = json.load(f)
    assert golden["method"] == EXPECTED_METHOD
    return golden["cases"]


CALIB = _load_calib()
GOLDEN_CASES = _load_golden()


@pytest.mark.parametrize("case", GOLDEN_CASES, ids=lambda c: c["id"])
def test_golden_case_reproduced_exactly(case):
    probs = case["probs"]
    expected = case["expected"]

    tier, pred_set, _reason, low, high, contiguous = assign_tier(probs, CALIB)

    assert tier == expected["tier"], case["id"]
    assert pred_set == expected["predictionSet"], case["id"]
    assert low == expected["low"], case["id"]
    assert high == expected["high"], case["id"]
    assert len(pred_set) == expected["setSize"], case["id"]
    assert contiguous == expected["contiguous"], case["id"]

    _scores, mode = ordinal_mode_interval_score(probs)
    assert mode == expected["mode"], case["id"]

    p_referable = sum(probs[2:5])
    assert abs(p_referable - expected["pReferable"]) < 1e-9, case["id"]


def test_golden_vectors_cover_at_least_80_cases():
    assert len(GOLDEN_CASES) >= 80


def test_property_10000_random_simplex_points():
    """Dirichlet(1,1,1,1,1) -- uniform over the probability simplex.

    Independent of the MATLAB property test in testConformalV2.m: the two
    do not share random draws, they only both have to satisfy the same
    invariants on their own 10,000 draws.

    Checks, for every draw: (a) the RETURNED (post-hull) set is contiguous
    and (b) contains the mode -- both true by construction (the mode is
    always added before the hull is taken, and the hull is by definition
    contiguous), so this is a regression test against a future refactor
    that accidentally returns the raw, possibly-gapped set instead; and
    (c) the case is never Tier A when its own P(g>=2) >= referableThreshold
    -- the demotion rule (see assign_tier()'s docstring), checked as a
    property here rather than only via golden cases because no real
    calibration_branchA_v2a.json case reaches this condition (see
    test_referable_threshold_demotion_* below for why, and where the
    demotion logic itself is unit-tested in isolation).

    NOT checked here: assign_tier's own `contiguous` return value. That flag
    means "the raw pre-hull set needed no gap-filling" -- a diagnostic about
    whether the per-stratum thresholds happened to reopen a gap, which they
    routinely do and is expected -- not a claim that the final set is
    contiguous.
    """
    rng = np.random.default_rng(0)
    n_trials = 10_000
    failures = []
    referable_threshold = float(CALIB["referableThreshold"])

    for i in range(n_trials):
        p = rng.dirichlet(np.ones(5))
        tier, pred_set, _reason, low, high, _contiguous = assign_tier(list(p), CALIB)

        expected_hull = list(range(low, high + 1))
        is_contig = (pred_set == expected_hull)

        _scores, mode = ordinal_mode_interval_score(list(p))
        contains_mode = (low <= mode <= high)

        p_referable = float(p[2] + p[3] + p[4])
        never_autoclear_above_threshold = not (tier == "A" and p_referable >= referable_threshold)

        if not (is_contig and contains_mode and never_autoclear_above_threshold):
            failures.append((i, p.tolist(), tier, pred_set, mode, p_referable))

    assert not failures, f"{len(failures)}/{n_trials} property failures, e.g. {failures[:5]}"


# ── Standalone referable-threshold demotion unit test (hand-built calib) ────
# The demotion can only trigger from a Tier-A-eligible case (mode in {0,1}),
# which requires P(g>=2) < 1 - qhatPerStratum[referable]. With the REAL
# fitted numbers (qhat ~0.87-0.88 for both v1 and v2a), that forces
# P(g>=2) < ~0.12-0.13, comfortably below referableThreshold (~0.23-0.32).
# Checked empirically too: 0/531 real v2a Tier-A cases (pooled val+test)
# ever reach the demotion condition. So golden vectors against the REAL
# calibration structurally cannot exercise this branch -- it is unit-tested
# here in isolation, against a calibration deliberately built to make it
# reachable (a much smaller referable-stratum qhat than the real fitted one).
SYNTHETIC_DEMOTION_CALIB = {
    "method": "ordinal_mode_interval_stratified_v3",
    "stratumOf": [0, 0, 1, 1, 1],
    "qhatPerStratum": [1.0, 0.3],
    "referableThreshold": 0.2,
    "referableTargetSensitivity": 0.05,
    "referableFrom": 2,
    "calibrated": True,
}


def test_referable_threshold_demotion_fires():
    # mode=0; s(2)=p0+p1=0.75 > 0.3 (referable qhat) -> grades 2-4 excluded,
    # hi<2, Tier-A-eligible from the base algorithm; pRef=0.25 >= 0.2
    # (referableThreshold) -> demoted to B.
    probs = [0.65, 0.10, 0.15, 0.05, 0.05]
    tier, pred_set, reason, low, high, _contig = assign_tier(probs, SYNTHETIC_DEMOTION_CALIB)
    assert tier == "B"
    assert "auto-clear withheld" in reason


def test_referable_threshold_demotion_does_not_fire_below_threshold():
    # Same Tier-A-eligible structure, but pRef=0.05 < 0.2 -> stays Tier A.
    probs = [0.65, 0.30, 0.03, 0.01, 0.01]
    tier, pred_set, _reason, low, high, _contig = assign_tier(probs, SYNTHETIC_DEMOTION_CALIB)
    assert tier == "A"
