'use strict';

/**
 * gradingWatchdog.js -- periodic stranded-job recovery (backend plan §D).
 *
 * recoverStranded() used to run once, at boot. A case that lost its job while
 * the server stayed up -- the job vanished between commit and enqueue, a worker
 * died mid-case -- then sat on 'processing' until the next restart, however far
 * away that was. This re-runs the same recovery on an interval.
 *
 * Safe to run while grading is live: enqueue() ignores anything queued, inflight
 * or waiting out a retry, so only cases with NO job behind them are picked up.
 * Every pick-up is recorded in grading_recoveries (§D.3), and after
 * WATCHDOG_MAX_RECOVERIES (3) the watchdog leaves the case alone -- it is shown
 * on System Health as stuck, for a human, rather than retried forever.
 *
 * GRADING_WATCHDOG_INTERVAL_MS (default 90 s) is far above the ~12.5 s normal
 * pipeline run, and cases younger than WATCHDOG_MIN_AGE_SECONDS (120 s) are
 * skipped so a just-committed case is never raced.
 */

const gradingQueue = require('./gradingQueue');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const INTERVAL_MS    = num('GRADING_WATCHDOG_INTERVAL_MS', 90_000);
const MIN_AGE_S      = num('WATCHDOG_MIN_AGE_SECONDS', 120);
const MAX_RECOVERIES = num('WATCHDOG_MAX_RECOVERIES', 3);

let timer = null;

function sweep() {
  return gradingQueue.recoverStranded({
    source: 'watchdog', minAgeSeconds: MIN_AGE_S, maxRecoveries: MAX_RECOVERIES,
  });
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    sweep().catch((err) => console.error(`[gradingWatchdog] sweep failed: ${err.message}`));
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, sweep, MAX_RECOVERIES, MIN_AGE_S };
