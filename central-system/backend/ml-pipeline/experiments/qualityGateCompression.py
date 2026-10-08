"""
qualityGateCompression.py
=========================
Does the PHC quality gate reject heavily compressed captures?

    python qualityGateCompression.py [--n N] [--outdir DIR]

Asked because Task 9.3 found the classifier's one catastrophic failure mode is
severe JPEG compression: accuracy 0.192, kappa 0.163, specificity 0.261, while
mean confidence does not move (0.665 vs a 0.664 baseline) and conformal tiering
does NOT route the cases to review. If the model cannot notice compressed
images, the quality gate is the only thing standing between a compressed
capture and a confident wrong grade.

── THE ANSWER, AND WHY IT IS NOT REASSURING ────────────────────────────────
Measured on 52 held-out IDRiD test images, each in a clean and a
JPEG-quality-10 variant:

    clean    52/52 REJECTED   (51 'blur', 1 'low_illumination')
    jpeg10   52/52 REJECTED   (50 'blur', 1 'low_illumination', 1 'motion')

So yes, it rejects compressed images -- and the result means nothing, because
it rejects everything. Not one clean image passes. These are research-grade
fundus photographs from a dataset built for exactly this purpose; if they
cannot clear the gate, no capture from a PHC will either. Shipped as-is, every
patient is asked to retake indefinitely and no case ever reaches grading.

The cause is a threshold, not a broken metric:

    focusThreshold (cameraPresets.json)   0.40
    clean images    focus  min 0.0674  median 0.2876  max 0.3909
    jpeg10 images   focus  min 0.0656  median 0.1007  max 0.1643

The maximum focus score any clean image achieves is 0.3909, below the 0.40 cut.
The threshold sits above the entire observed range of good images, which means
it was never validated against real fundus photographs.

── THE METRIC ITSELF IS FINE, AND THAT IS THE USEFUL PART ──────────────────
The focus score separates the two populations well: median 0.2876 -> 0.1007, a
0.35x drop. Sweeping the threshold:

    threshold   clean pass   jpeg reject
      0.40          0.0%        100.0%     <- current
      0.27         63.5%        100.0%
      0.21         82.7%        100.0%
      0.17         88.5%        100.0%     <- best separation (Youden 0.885)
      0.12         96.2%         76.9%

0.17 rejects every compressed image while passing 88.5% of clean ones. So the
gate CAN do the job Task 9.3 needs; it is currently calibrated so it cannot.

── CAVEATS THAT MUST TRAVEL WITH THE 0.17 ──────────────────────────────────
Do not paste 0.17 into cameraPresets.json on the strength of this alone.

  - n = 52, one dataset, one camera. IDRiD was captured on a Kowa VX-10 -- a
    mydriatic desk unit, not the portable cameras this system targets. Its
    images are the BEST case, and a threshold fitted to them may be too strict
    for a portable capture that is legitimately usable.
  - The classes here are clean vs JPEG-10, not usable vs unusable. A genuinely
    blurred photograph is a different distribution and is not represented.
  - The populations OVERLAP: max(jpeg10) 0.1643 exceeds min(clean) 0.0674, so
    no single threshold separates them perfectly and 88.5% is a ceiling for
    this metric alone, not a tuning failure.

What this establishes is that 0.40 is wrong, that the metric carries real
signal, and roughly where a defensible threshold lies. Setting it needs images
from the actual target camera.

── A SECOND FINDING, FOUND ON THE WAY ──────────────────────────────────────
cameraPresets.json contains exactly one preset, "default". Every call passing a
real camera id -- 'forus_3nethra_v2' here -- silently falls back to it. The
per-camera threshold calibration the design describes is not implemented, and
nothing reports that it is missing: the caller supplies a camera id and gets an
answer that ignored it.
"""

import argparse
import csv
import json
import os
import subprocess
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ML_ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(ML_ROOT)))
GATE_DIR = os.path.join(REPO, "phc-local-app", "backend", "quality-gate-matlab")
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ML_ROOT, "inference"))

MATLAB_SCRIPT = """
addpath('{gate}');
d = dir(fullfile('{outdir}', '*.jpg'));
fid = fopen('{csv}', 'w');
fprintf(fid, 'file,variant,status,reason,focus,illum,occl,glare,motion,fov\\n');
for i = 1:numel(d)
    p = fullfile(d(i).folder, d(i).name);
    try
        r = qualityGateMain(p, '{camera}');
        rs = r.reason; if isempty(rs), rs = '-'; end
        v = 'clean'; if contains(d(i).name, '_B_'), v = 'jpeg10'; end
        sc = r.scores;
        fprintf(fid, '%s,%s,%s,%s,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f\\n', ...
                d(i).name, v, r.status, rs, sc.focusScore, sc.illuminationScore, ...
                gf(sc,'occlusionScore'), gf(sc,'glareScore'), ...
                gf(sc,'motionScore'), gf(sc,'fovScore'));
    catch ME
        fprintf(fid, '%s,err,err,%s,NaN,NaN,NaN,NaN,NaN,NaN\\n', d(i).name, ME.message);
    end
end
fclose(fid);
function v = gf(s, f)
if isfield(s, f), v = s.(f); else, v = NaN; end
end
"""


def build_pairs(outdir, limit):
    from domainGap import resolve_idrid, jpeg
    ids = np.load(os.path.join(ML_ROOT, "models", "Model1",
                               "branchA_v1_test_ids.npy"), allow_pickle=True)
    os.makedirs(outdir, exist_ok=True)
    for f in os.listdir(outdir):
        if f.endswith(".jpg"):
            os.remove(os.path.join(outdir, f))
    n = 0
    for s in ids:
        s = str(s)
        if not s.startswith("idrid"):
            continue
        path = resolve_idrid(s)
        if not path:
            continue
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        base = os.path.splitext(os.path.basename(path))[0]
        # Both variants are written at quality 95. The DEGRADATION happened in
        # jpeg(), which encodes at 10 and decodes; re-saving at 95 preserves
        # those artefacts without adding a second generation of its own.
        cv2.imwrite(os.path.join(outdir, base + "_A_clean.jpg"), bgr,
                    [int(cv2.IMWRITE_JPEG_QUALITY), 95])
        cv2.imwrite(os.path.join(outdir, base + "_B_jpeg10.jpg"), jpeg(bgr, 1.0),
                    [int(cv2.IMWRITE_JPEG_QUALITY), 95])
        n += 1
        if limit and n >= limit:
            break
    return n


def sweep(clean, degraded):
    rows = []
    for t in np.arange(0.05, 0.45, 0.01):
        cp = float((clean >= t).mean())
        jr = float((degraded < t).mean())
        rows.append({"threshold": round(float(t), 2), "cleanPass": cp,
                     "compressedReject": jr, "youden": cp + jr - 1})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=0, help="image pairs (0 = all)")
    ap.add_argument("--outdir", default=os.path.join(HERE, "qg_images"))
    ap.add_argument("--camera", default="forus_3nethra_v2")
    ap.add_argument("--out", default=os.path.join(HERE, "quality_gate_compression.json"))
    args = ap.parse_args()

    n = build_pairs(args.outdir, args.n)
    print(f"built {n} clean/compressed pairs in {args.outdir}")

    csv_path = os.path.join(args.outdir, "gate.csv")
    # NOT a leading-underscore name. MATLAB script filenames must be valid
    # identifiers, and run('_runGate.m') fails with "Invalid text character" --
    # an error about the file's NAME that reads as an error about its contents.
    script = os.path.join(args.outdir, "runQualityGate.m")
    # Unix newlines and no leading blank line: MATLAB rejects a script whose
    # first line is a bare CR with "Invalid text character", which reads like
    # an encoding problem and is not one.
    with open(script, "w", encoding="ascii", newline="\n") as fh:
        fh.write(MATLAB_SCRIPT.strip().format(
            gate=GATE_DIR.replace("\\", "/"),
            outdir=args.outdir.replace("\\", "/"),
            csv=csv_path.replace("\\", "/"),
            camera=args.camera))

    # One MATLAB session for all images: startup costs ~9 s and would otherwise
    # be paid per image.
    subprocess.run(["matlab", "-batch", f"run('{script}')".replace("\\", "/")],
                   check=True)

    with open(csv_path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    out = {"n": n, "camera": args.camera}
    focus = {}
    for variant in ("clean", "jpeg10"):
        sub = [r for r in rows if r["variant"] == variant]
        f = np.array([float(r["focus"]) for r in sub])
        focus[variant] = f
        statuses = {}
        reasons = {}
        for r in sub:
            statuses[r["status"]] = statuses.get(r["status"], 0) + 1
            reasons[r["reason"]] = reasons.get(r["reason"], 0) + 1
        out[variant] = {
            "n": len(sub), "status": statuses, "reason": reasons,
            "focusMin": float(f.min()), "focusMedian": float(np.median(f)),
            "focusMax": float(f.max()),
            "passedAt0_40": int((f >= 0.40).sum()),
        }
        print(f"{variant:8s} n={len(sub)} status={statuses} "
              f"focus min {f.min():.4f} median {np.median(f):.4f} max {f.max():.4f}")

    out["thresholdSweep"] = sweep(focus["clean"], focus["jpeg10"])
    best = max(out["thresholdSweep"], key=lambda r: r["youden"])
    out["bestThreshold"] = best
    out["currentThreshold"] = 0.40
    print(f"\ncurrent 0.40  -> clean pass {100*(focus['clean']>=0.4).mean():.1f}%, "
          f"compressed reject {100*(focus['jpeg10']<0.4).mean():.1f}%")
    print(f"best {best['threshold']:.2f}     -> clean pass {100*best['cleanPass']:.1f}%, "
          f"compressed reject {100*best['compressedReject']:.1f}%")

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print(f"written to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
