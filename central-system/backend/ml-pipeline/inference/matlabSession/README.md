# Persistent MATLAB inference session

Why this exists: `matlab -batch` cold-starts in ~24s (mean, measured on 10
real images — see `ml-pipeline/experiments/measureInferenceLatency.js`), 3.9x
Python's ~6.2s. Almost all of that is MATLAB interpreter + toolbox + ONNX
custom-layer-package startup, not the actual `predict()` call, which is fast
once the network is resident. This session amortizes that cost across many
requests instead of paying it per case.

**This is a second long-running process, not a drop-in.** It does not start
automatically with the Node backend, and `INFERENCE_BACKEND=matlab` now
**requires** it to be running — there is no per-call `matlab -batch` fallback
any more (see `gradingOrchestrator.js`'s `runBranchAInferenceMatlab`). If the
session isn't running, every MATLAB-backend case fails with a clear timeout
error pointing back here.

## What it is

- `runMatlabInferenceSession.m` — the server. Loads only the networks its
  configured backends need (the classifier when `INFERENCE_BACKEND=matlab`,
  M2-M4 when `SEG_INFERENCE_BACKEND=matlab`) once, then polls `requests/` for work and writes to `responses/`. Never
  daemonizes itself.
- `manageMatlabSession.ps1` — the actual start/stop/status interface. Use
  this, not `runMatlabInferenceSession.m` directly.
- `requests/`, `responses/` — created automatically. A request is
  `<id>.json` = `{"tensorPath": "...", "gradcamPath": "..."}`; the matching
  response is `responses/<id>.json`, the same JSON shape
  `branchAInferMatlab.m` always produced (or `{"error": "..."}` on failure).
  Files are written temp-then-renamed on both sides, so a half-written file
  is never visible to the other side of the poll loop.
- `session.log` — one line per request (id, ms, OK/FAILED), plus startup.
- `session.pid`, `stop.flag`, `session.stdout.log`, `session.stderr.log` —
  management-script bookkeeping; safe to delete when the session is stopped.

## Operating it

```powershell
cd central-system\backend\ml-pipeline\inference\matlabSession

.\manageMatlabSession.ps1 start     # launches matlab -batch in the background,
                                     # returns immediately -- networks take a
                                     # few seconds to load after this returns

.\manageMatlabSession.ps1 status    # RUNNING/NOT RUNNING, PID, last 15 log
                                     # lines, pending/unclaimed request counts

.\manageMatlabSession.ps1 stop      # writes stop.flag, waits up to 15s for a
                                     # clean exit, force-kills if it doesn't
```

Wait for `status` to show the "session ready, polling for requests" log line
(or just tail `session.log`) before sending real traffic — the five network
loads plus one warmup inference call take a few seconds, during which
requests would sit in `requests/` unanswered until the session catches up.

**Start this before setting `INFERENCE_BACKEND=matlab` on the Node backend.**
There is no ordering enforcement between the two processes; starting the
Node backend first just means its earliest MATLAB-backend cases time out
(`matlab_session_unavailable`, pointing back at this file) until the session
comes up.

## Restarting after a code change

`branchAInferMatlab.m`, `conformalTiering.m`, or `models/*.mat` changing on
disk does **not** get picked up by a running session — it loaded everything
once at startup and keeps running the code/weights it started with. Restart
(`stop` then `start`) after any change under `ml-pipeline/calibration/`,
`ml-pipeline/explainability/`, `ml-pipeline/models/`, or
`ml-pipeline/inference/branchAInferMatlab.m`.

## Failure modes

- **Session not running / crashed**: requests pile up in `requests/`
  unanswered. Node's poll times out after `MATLAB_SESSION_TIMEOUT_MS`
  (default 30000ms) and rejects with `matlab_session_unavailable`. Check
  `status`, then `session.stderr.log` for a MATLAB-level crash.
- **One request fails** (bad tensor, network error): the session writes
  `{"error": "..."}` to that request's response and keeps polling — one bad
  case does not take the session down. Node treats that response as a
  rejected promise, same as any other Branch A failure.
- **Stale files after a crash**: if the session process dies without
  reaching its own cleanup, a `requests/<id>.json` can be left with no
  response ever written. It sits there harmlessly (the Node side that
  submitted it has already timed out and moved on) until the next session
  restart's operator notices and clears `requests/`/`responses/` if they
  want a clean directory — nothing re-processes an orphaned request file
  automatically.

## What still cold-starts per call

Image preprocessing (`preprocessBranchATensor.py`) is **not** part of this
session — it stays a fresh Python process per case, on purpose: preprocessing
now lives in exactly one place (`branchAInfer.preprocess()`, called by both
backends — see `branchAInferMatlab.m`'s header), and that's Python, not
MATLAB. A persistent *Python* process was not asked for here and was not
built. Real per-case latency under `INFERENCE_BACKEND=matlab` is therefore
Python's preprocessing startup cost + a near-instant persistent-session
`predict()` + file-poll overhead — measured, not assumed, in the top-level
latency report this README's change was made to support.
