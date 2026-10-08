'use strict';

/**
 * segWorkerSupervisor.js -- keeps the persistent segmentation worker alive.
 *
 * The worker (ml-pipeline/inference/segSession/runSegWorker.py) holds M2-M5 in
 * memory so a case does not pay 17 s of torch import and model loading. When it
 * is down, grading still works -- the orchestrator falls back to spawning
 * segInfer.py per case -- and that is exactly why it needs watching: the
 * failure is SILENT except for a log line, and it shows up as every case
 * quietly taking 17 s longer, which is the kind of thing nobody chases down for
 * weeks.
 *
 * Everything else is workerSupervisor.js, shared with the MATLAB session: the
 * heartbeat test, the stop-then-start restart, the restart cap, the alert on
 * System Health and its automatic resolution.
 *
 * Status: 'healthy' | 'restarting' | 'down' | 'disabled'. Set
 * SEG_WORKER_SUPERVISOR_ENABLED=false on a machine that deliberately runs
 * without the worker; grading is unaffected either way, it is only slower.
 */

const path = require('path');
const { createWorkerSupervisor } = require('./workerSupervisor');

const SESSION_DIR = path.join(__dirname, '..', 'ml-pipeline', 'inference', 'segSession');
// Overridable for the same reason the MATLAB one is: a live worker rewrites
// the real file every 5 s, so a test cannot otherwise simulate a dead one.
const HEARTBEAT   = process.env.SEG_HEARTBEAT_PATH
  || path.join(SESSION_DIR, 'worker.heartbeat');
const MANAGER     = path.join(SESSION_DIR, 'manageSegWorker.ps1');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const ALERT_KIND = 'seg_worker_down';

function enabled() {
  const flag = process.env.SEG_WORKER_SUPERVISOR_ENABLED;
  return !(flag !== undefined && flag !== '' && /^(0|false|no|off)$/i.test(flag.trim()));
}

const supervisor = createWorkerSupervisor({
  name: 'segWorker',
  label: 'segmentation worker',
  sessionDir: SESSION_DIR,
  heartbeatPath: HEARTBEAT,
  managerScript: MANAGER,
  alertKind: ALERT_KIND,
  enabled,
  giveUpHint: 'check ml-pipeline/inference/segSession/worker.log and '
    + 'worker.stderr.log (a missing checkpoint or a Python environment problem '
    + 'will not be fixed by restarting). Grading continues without it, about '
    + '17 s slower per case.',
  intervalMs:      num('SEG_SUPERVISOR_INTERVAL_MS', 30_000),
  staleMs:         num('SEG_HEARTBEAT_STALE_MS', 30_000),
  // Shorter than MATLAB's four minutes: the four models load in about 17 s, so
  // a worker that has not reported in ninety seconds is not still starting.
  startupGraceMs:  num('SEG_STARTUP_GRACE_MS', 90_000),
  maxRestarts:     num('SEG_MAX_RESTARTS', 3),
  restartWindowMs: num('SEG_RESTART_WINDOW_MS', 30 * 60_000),
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
