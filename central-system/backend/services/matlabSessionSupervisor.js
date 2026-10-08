'use strict';

/**
 * matlabSessionSupervisor.js -- keeps the persistent MATLAB inference session
 * alive (backend plan §E, design doc §10.7).
 *
 * With INFERENCE_BACKEND=matlab (the default) every case is graded through the
 * persistent session in ml-pipeline/inference/matlabSession/. That session does
 * not start with the backend and does not survive a reboot; when it is down,
 * every case fails with matlab_session_unavailable -- loudly, but with nobody
 * told. This closes that gap:
 *
 *   - every MATLAB_SUPERVISOR_INTERVAL_MS (30 s) it reads the session's
 *     heartbeat file, which runMatlabInferenceSession.m rewrites every 5 s from
 *     inside its poll loop. Fresh = loaded and polling. Stale or missing = dead
 *     OR wedged -- a PID check alone would call a hung process healthy.
 *   - not healthy -> restart through manageMatlabSession.ps1 (stop, which
 *     force-kills a wedged process, then start): the same documented interface
 *     an operator uses, not a second way of launching MATLAB.
 *   - after a restart it allows MATLAB_STARTUP_GRACE_MS for the five networks
 *     to load before judging again.
 *   - a restart that fails, or does not produce a heartbeat within the grace
 *     period, raises a system_alerts row (matlab_session_down), shown on System
 *     Health (§F). It is resolved automatically once the heartbeat returns.
 *   - at most MAX_RESTARTS restarts per RESTART_WINDOW_MS. Past that the
 *     supervisor stops restarting and reports 'down': something is wrong that
 *     restarting will not fix (missing model files, a licence problem) and a
 *     restart loop would only hide it. It keeps watching, so a manual fix is
 *     picked up on the next check.
 *
 * On boot, a session that is not running is simply started -- that is the
 * "auto-start with the backend" half of §E.
 *
 * Status, for System Health: 'healthy' | 'restarting' | 'down' | 'disabled'
 * ('disabled' when INFERENCE_BACKEND is not matlab, or
 * MATLAB_SUPERVISOR_ENABLED=false).
 *
 * Started from server.js's main block only, never on import: a test that
 * requires the app must not launch MATLAB.
 *
 * All of the above is workerSupervisor.js now, which also watches the Python
 * segmentation worker: two workers that fail the same way and need the same
 * response. What stays here is what is specific to MATLAB -- where its files
 * are, when supervising it is even wanted, and what to check when restarting
 * has stopped helping.
 */

const path = require('path');
const { createWorkerSupervisor } = require('./workerSupervisor');

const SESSION_DIR = path.join(__dirname, '..', 'ml-pipeline', 'inference', 'matlabSession');
// Overridable so a test can watch its own file instead of the live session's
// (a running session rewrites the real one every 5 s, which made
// "simulate a dead session" impossible to test on a machine that has one).
const HEARTBEAT   = process.env.MATLAB_HEARTBEAT_PATH
  || path.join(SESSION_DIR, 'session.heartbeat');
const MANAGER     = path.join(SESSION_DIR, 'manageMatlabSession.ps1');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const ALERT_KIND = 'matlab_session_down';

function enabled() {
  // Branch A is not the only user of the session: segmentation (§S) and the
  // clinical-rationale PDF (§O) go through it too. Supervising only when
  // INFERENCE_BACKEND=matlab left the session unwatched on a
  // python-classifier + matlab-segmentation configuration, which is a valid
  // one -- segmentation would then silently run every case on the PyTorch
  // fallback with nobody told the session was down.
  const classifier = (process.env.INFERENCE_BACKEND || 'matlab').toLowerCase();
  const segmentation = (process.env.SEG_INFERENCE_BACKEND || 'matlab').toLowerCase();
  const flag = process.env.MATLAB_SUPERVISOR_ENABLED;
  const off = flag !== undefined && flag !== '' && /^(0|false|no|off)$/i.test(flag.trim());
  return (classifier === 'matlab' || segmentation === 'matlab') && !off;
}

const supervisor = createWorkerSupervisor({
  name: 'matlab',
  label: 'MATLAB session',
  sessionDir: SESSION_DIR,
  heartbeatPath: HEARTBEAT,
  managerScript: MANAGER,
  alertKind: ALERT_KIND,
  enabled,
  giveUpHint: 'check ml-pipeline/inference/matlabSession/session.log and '
    + 'session.stderr.log (missing models/*.mat files, or a licence problem, '
    + 'will not be fixed by restarting).',
  intervalMs:      num('MATLAB_SUPERVISOR_INTERVAL_MS', 30_000),
  staleMs:         num('MATLAB_HEARTBEAT_STALE_MS', 30_000),
  startupGraceMs:  num('MATLAB_STARTUP_GRACE_MS', 240_000),
  maxRestarts:     num('MATLAB_MAX_RESTARTS', 3),
  restartWindowMs: num('MATLAB_RESTART_WINDOW_MS', 30 * 60_000),
});

module.exports = {
  start: supervisor.start,
  stop: supervisor.stop,
  checkOnce: supervisor.checkOnce,
  getStatus: supervisor.getStatus,
  _setManager: supervisor._setManager,
  _reset: supervisor._reset,
  HEARTBEAT, ALERT_KIND,
};
