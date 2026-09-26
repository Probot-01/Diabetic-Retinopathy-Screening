"""Persistent segmentation worker (backend plan §S.4's open item).

Loads M2-M5 once, then polls a request directory for images to segment. Each
request is one image; each response is the JSON segInfer.py has always printed
to stdout, written back under the matching request id.

    python runSegWorker.py

Do not run this directly for real use -- manageSegWorker.ps1 in this folder is
the documented start/stop/status interface (background process, log
redirection, PID tracking). This script never daemonizes; it blocks until told
to stop and expects whatever launched it to have put it in the background.

STOP: create a file named 'stop.flag' in this directory.

-- WHY --------------------------------------------------------------------
Segmentation was the largest remaining cost in grading a case, and almost none
of it was segmentation. Measured on this machine:

    torch import + 4 model loads   17.1 s   <- paid on EVERY case
    actual work per image           2.0 s

Spawning `segInfer.py` per case paid that 17 s every time. This pays it once,
at start-up.

It is also why backend plan §S.4 found that serving M2-M4 from the MATLAB
session gave no speed-up at all (22.5 s vs 21.4 s over 20 images): the forward
passes it moved were under a second each, while the process start it did NOT
move was seventeen. Moving the forward passes was never going to show up.

-- THE PROTOCOL -----------------------------------------------------------
Deliberately the same file protocol as the MATLAB session next door
(inference/matlabSession/), for the same reasons: no extra dependency, and
every step is inspectable with a directory listing -- a stuck request is a file
sitting in requests/, not opaque socket state. The Node side speaks to both
through one client (services/sessionClient.js).

    requests/<id>.json    {"image": "...", "outdir": "...", "minArea": 10}
    responses/<id>.json   segInfer's result dict, or {"error": "..."}

Both sides write temp-then-rename, so neither ever observes a partial file.

-- WHAT THIS DOES NOT CHANGE ----------------------------------------------
Nothing about the numbers. It calls segInfer.run_one, which is the same code
path the command line uses -- every preprocessing step, threshold, optic-disc
mask, component filter and quadrant assignment is untouched, so the counts the
ICDR thresholds were calibrated against cannot drift because of this file.
"""

import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
INFERENCE_DIR = os.path.dirname(HERE)
sys.path.insert(0, INFERENCE_DIR)

REQUEST_DIR = os.path.join(HERE, "requests")
RESPONSE_DIR = os.path.join(HERE, "responses")
STOP_FLAG = os.path.join(HERE, "stop.flag")
LOG_FILE = os.path.join(HERE, "worker.log")
# Liveness for the Node side. Rewritten from inside the poll loop, so a fresh
# heartbeat means "loaded AND still polling" -- a process that is alive but
# wedged stops refreshing it, which a PID check alone would miss. Written only
# once the loop starts, so it is absent while the models load.
HEARTBEAT = os.path.join(HERE, "worker.heartbeat")

POLL_INTERVAL_SECONDS = 0.05
HEARTBEAT_SECONDS = 5

# segInfer's role names, which are NOT the checkpoint filenames: M4's role is
# "hard_exudate" since the GATE 4 rename (its file is still
# bright_lesion_unet_v1.pt). The old "bright_lesion" here made every worker
# start die with KeyError, so every case paid the per-case segInfer.py spawn.
# M5's role follows RED_LESION_MODEL_VERSION, so the model a case will use is
# the one loaded up front.
def _roles(seg):
    red = "red_lesion_v2" if seg.RED_LESION_MODEL_VERSION == "v2" else "red_lesion"
    return ("vessel", "localization", "hard_exudate", red)


def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def handle(req_path, segInfer):
    req_id = os.path.splitext(os.path.basename(req_path))[0]
    resp_path = os.path.join(RESPONSE_DIR, req_id + ".json")
    started = time.time()
    try:
        with open(req_path, encoding="utf-8") as fh:
            req = json.load(fh)
        out = segInfer.run_one(req["image"], req.get("outdir") or None,
                               int(req.get("minArea", segInfer.DEFAULT_MIN_AREA)))
        write_atomic(resp_path, json.dumps(out))
        log(f"  request {req_id} OK ({(time.time() - started) * 1000:.0f} ms)")
    except BaseException as exc:  # noqa: BLE001
        # BaseException, not Exception: segInfer._fail() raises SystemExit for a
        # missing checkpoint, and a worker that exited on one bad request would
        # take every queued case with it.
        write_atomic(resp_path, json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        log(f"  request {req_id} FAILED ({(time.time() - started) * 1000:.0f} ms): {exc}")
        log(traceback.format_exc().strip())
    finally:
        # Deleted LAST, after the response is written: the Node side polls for
        # the RESPONSE file only, so this ordering just keeps requests/ from
        # accumulating -- it is not part of the handshake.
        try:
            os.remove(req_path)
        except OSError:
            pass


def main():
    os.makedirs(REQUEST_DIR, exist_ok=True)
    os.makedirs(RESPONSE_DIR, exist_ok=True)
    for stale in (STOP_FLAG, HEARTBEAT):
        if os.path.exists(stale):
            os.remove(stale)

    log("worker starting -- loading M2-M5")
    import segInfer
    for role in _roles(segInfer):
        segInfer.load(role)
        log(f"  loaded {role}")
    log(f"worker ready, polling for requests (backend: {segInfer.SEG_BACKEND})")

    last_beat = 0.0
    while True:
        if os.path.exists(STOP_FLAG):
            log("stop.flag seen -- shutting down")
            os.remove(STOP_FLAG)
            break

        now = time.time()
        if now - last_beat >= HEARTBEAT_SECONDS:
            write_atomic(HEARTBEAT, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            last_beat = now

        for name in sorted(os.listdir(REQUEST_DIR)):
            if name.endswith(".json"):
                handle(os.path.join(REQUEST_DIR, name), segInfer)

        time.sleep(POLL_INTERVAL_SECONDS)

    if os.path.exists(HEARTBEAT):
        os.remove(HEARTBEAT)
    log("worker stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
