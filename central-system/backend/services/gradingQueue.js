'use strict';

/**
 * gradingQueue.js  (Task 8.3)
 *
 * A real job queue in front of the grading pipeline, replacing the synchronous
 * `await processCase(caseId)` that Task 3.3 put directly in the POST handler.
 *
 *   enqueue(caseId)      hand a case to the workers; returns immediately
 *   start()              begin draining (idempotent)
 *   stop({drain})        stop taking new work; optionally wait for inflight
 *   onIdle()             promise that resolves when nothing is queued or inflight
 *   recoverStranded()    re-enqueue cases the database says are unfinished
 *   stats()              { queued, inflight, processed, failed, concurrency }
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A MATLAB grading run takes tens of seconds. Doing it inside the request meant
 * the PHC's upload connection was held open for the whole run, over exactly the
 * bad rural link this system is designed around: the sync manager's 600 s
 * upload timeout was being spent mostly on grading, not transfer. Two PHCs
 * syncing at once queued behind each other inside Express with no visibility,
 * and a client that gave up got no result even though the work had been done.
 *
 * Now the POST returns as soon as the case is durably stored, and grading
 * happens behind it. The client polls GET /cases/:id/status, which is what that
 * endpoint was always for.
 *
 * ── Why there is no 'queued' status ─────────────────────────────────────────
 * api-contracts.md pins the status enum to processing | graded | error, and the
 * database CHECK constraint enforces it. "Queued" is not a distinct fact for
 * any client: from outside, waiting-for-a-worker and being-graded are the same
 * state — the answer is not ready, keep polling. Adding a fourth value would
 * change a published contract to express a distinction only this module cares
 * about. Queue position is available through stats() instead.
 *
 * ── The failure this module exists to prevent ───────────────────────────────
 * The queue is in memory. A restart therefore loses every pending job, while
 * the database still says those cases are 'processing'. Nothing would ever pick
 * them up again: no error, no retry, no log line — a patient's scan sitting
 * forever in a state that means "any moment now". That is a worse failure than
 * the blocking request this task replaces, and it is invisible.
 *
 * recoverStranded() is the answer, and server.js calls it at boot. The database
 * is the queue of record; this module is only the work order.
 */

const pool = require('../db/pgClient');
const { processCase } = require('./gradingOrchestrator');

// One at a time by default. The bottleneck is a MATLAB process, and running
// several on one machine does not finish the batch sooner -- they contend for
// CPU and for license checkouts, and each individual case gets slower, which
// matters because a clinician is waiting on the case at the front of the queue,
// not on the batch. Raise it only on a box measured to take it.
const CONCURRENCY = Math.max(1, parseInt(process.env.GRADING_CONCURRENCY || '1', 10));

// Attempts per case, total, not additional. Most grading failures we have seen
// are transient (a license checkout that timed out, a file still being flushed
// to disk), and those succeed on a second attempt seconds later. A genuinely
// bad image fails all three quickly and lands on 'error' -- bounded either way,
// because a case that retries forever is a case nobody is ever told about.
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.GRADING_MAX_ATTEMPTS || '3', 10));

const RETRY_BASE_MS = parseInt(process.env.GRADING_RETRY_BASE_MS || '2000', 10);

// Error codes that must NOT be retried: no number of attempts will make a
// missing file appear. Retrying these wastes the queue's time and delays every
// case behind them.
// Retrying cannot help any of these.
//
// The two *_unavailable codes are about the ENVIRONMENT, not the case: a
// missing interpreter fails identically for every case and every attempt. They
// matter more than they look, because the model stages run before MATLAB, so
// each pointless retry re-runs Branch A and four segmentation models — about
// 35 s of inference to rediscover that an executable is still absent.
//
// A non-zero EXIT is deliberately NOT here: that can be a licence hiccup or a
// locked file, which a retry does fix.
const PERMANENT = new Set([
  'image_not_found', 'invalid_image_type', 'case_not_found',
  'matlab_unavailable', 'python_unavailable',
]);

const queue = [];              // caseIds waiting for a worker
const queued = new Set();      // membership test for the above (dedupe)
const inflight = new Set();    // caseIds a worker currently holds
const retrying = new Set();    // caseIds waiting out a retry backoff (neither of the above)

let workers = 0;
let started = false;
let processed = 0;
let failed = 0;
let idleWaiters = [];

// Injectable so tests can drive the queue without MATLAB. Production never
// touches this.
let runGrading = processCase;

/**
 * enqueue(caseId)
 *
 * @returns {boolean} true if newly queued, false if already queued or inflight.
 *
 * The dedupe is not cosmetic. recoverStranded() runs at boot and can name a
 * case the POST handler has just enqueued; without this the same case would be
 * graded twice concurrently, and two MATLAB runs writing the same Grad-CAM
 * path is a corrupted overlay for whichever finishes second.
 */
function enqueue(caseId) {
  if (!caseId) throw new Error('enqueue: caseId is required');
  if (queued.has(caseId) || inflight.has(caseId) || retrying.has(caseId)) return false;
  queue.push({ caseId, attempts: 0 });
  queued.add(caseId);
  // Fire-and-forget: a stale failure reason must not survive a re-queue, but
  // clearing it is bookkeeping and must not delay or block the grading itself.
  clearFailure(caseId);
  if (started) pump();
  return true;
}

/** Spin up workers until concurrency is reached or the queue is empty. */
function pump() {
  while (started && workers < CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    queued.delete(job.caseId);
    workers++;
    inflight.add(job.caseId);
    runJob(job).finally(() => {
      workers--;
      inflight.delete(job.caseId);
      if (queue.length > 0) pump();
      else if (workers === 0) resolveIdle();
    });
  }
  if (queue.length === 0 && workers === 0) resolveIdle();
}

async function runJob(job) {
  job.attempts++;
  try {
    await runGrading(job.caseId);
    processed++;
  } catch (err) {
    const permanent = PERMANENT.has(err.code);
    const exhausted = job.attempts >= MAX_ATTEMPTS;

    if (permanent || exhausted) {
      failed++;
      console.error(
        `[gradingQueue] ${job.caseId} failed after ${job.attempts} attempt(s)`
        + `${permanent ? ' (permanent)' : ''}: ${err.message}`);
      await markError(job.caseId, err, job.attempts);
      return;
    }

    // Backoff before the retry, and re-queue rather than recursing -- recursion
    // would hold this worker for the whole backoff and starve the other cases.
    const delay = RETRY_BASE_MS * Math.pow(2, job.attempts - 1);
    console.warn(
      `[gradingQueue] ${job.caseId} attempt ${job.attempts} failed, retrying in `
      + `${delay}ms: ${err.message}`);

    // `retrying` covers the backoff gap, when the job is neither queued nor
    // inflight. Without it the watchdog (§D) would see a 'processing' case the
    // queue does not know about, enqueue a FRESH job with attempts = 0, and a
    // permanently failing case would be retried forever.
    retrying.add(job.caseId);
    const t = setTimeout(() => {
      retrying.delete(job.caseId);
      if (!queued.has(job.caseId) && !inflight.has(job.caseId)) {
        queue.push(job);
        queued.add(job.caseId);
        if (started) pump();
      }
    }, delay);
    if (t.unref) t.unref();   // a pending retry must not hold the process open
  }
}

/**
 * markError(caseId, err, attempts)
 *
 * 'error', not left on 'processing'. A poller cannot distinguish "still
 * working" from "gave up" otherwise, and the case would look active forever.
 *
 * The CAUSE is written too (migration 0014). It used to live only in the line
 * printed just above this call, which meant that by the time anyone looked at
 * a failed case -- on the dashboard, or during a demo -- the reason was gone
 * and the database could only say "error". err.code is the classification this
 * queue already computes for the retry decision; keeping it makes failures
 * groupable, which is the difference between 62 mysteries and one cause with
 * 62 instances.
 *
 * The message is truncated at 500 characters: a stack-laden library error can
 * run to kilobytes, and the first line is the part anyone reads.
 *
 * A failure to write the status is swallowed and logged: it means the database
 * is unreachable, which the next case will surface anyway, and throwing out of
 * a worker would take the queue down with it.
 */
async function markError(caseId, err, attempts) {
  const code = (err && err.code) || 'unknown';
  const reason = [
    err && err.message ? String(err.message) : 'no message',
    attempts ? `(after ${attempts} attempt${attempts === 1 ? '' : 's'})` : '',
  ].join(' ').trim().slice(0, 500);
  try {
    await pool.query(
      `UPDATE cases
          SET status = 'error', failure_code = $2, failure_reason = $3,
              failed_at = now()
        WHERE case_id = $1`, [caseId, code, reason]);
  } catch (dbErr) {
    console.error(`[gradingQueue] could not mark ${caseId} as error: ${dbErr.message}`);
  }
}

/**
 * clearFailure(caseId)
 *
 * A case being tried again has no current failure. Leaving the old reason in
 * place would describe a state that no longer exists, and the dashboard would
 * keep showing a cause for a case that has since graded -- someone would act
 * on it. Cleared on enqueue rather than on success, so a case that is retrying
 * does not read as still-broken while it runs.
 */
async function clearFailure(caseId) {
  try {
    await pool.query(
      `UPDATE cases SET failure_code = NULL, failure_reason = NULL, failed_at = NULL
        WHERE case_id = $1 AND failure_code IS NOT NULL`, [caseId]);
  } catch (err) {
    console.error(`[gradingQueue] could not clear the failure on ${caseId}: ${err.message}`);
  }
}

/**
 * recoverStranded()
 *
 * Re-enqueue every case the database still calls 'processing'. Called at boot,
 * before the server accepts requests.
 *
 * A case is stranded if the process died between "row committed" and "grading
 * finished" -- a restart, a deploy, a crash. Since the queue lives in memory,
 * nothing else would ever look at those rows again.
 *
 * Ordered oldest first: the patient who has been waiting longest is graded
 * first. Any case genuinely mid-grading at the moment of the crash is picked up
 * again here, which is safe because processCase overwrites its outputs rather
 * than appending.
 *
 * @returns {Promise<number>} how many were re-enqueued.
 */
async function recoverStranded({ source = 'boot', minAgeSeconds = 0, maxRecoveries = null } = {}) {
  let rows;
  try {
    // minAgeSeconds: the watchdog skips rows younger than this, so it never
    // races a POST handler that has committed a case but not yet enqueued it.
    // maxRecoveries: the watchdog stops re-enqueuing a case it has already
    // recovered this many times; System Health surfaces it for a human instead
    // (§D.3). Boot recovery passes neither -- after a restart every
    // 'processing' row really is stranded.
    ({ rows } = await pool.query(`
      SELECT c.case_id
      FROM cases c
      WHERE c.status = 'processing'
        AND COALESCE(c.processing_started_at, c.received_at)
              <= now() - make_interval(secs => $1)
        AND ($2::int IS NULL OR
             (SELECT count(*) FROM grading_recoveries r WHERE r.case_id = c.case_id) < $2::int)
      ORDER BY COALESCE(c.processing_started_at, c.received_at) ASC
    `, [minAgeSeconds, maxRecoveries]));
  } catch (err) {
    // A failure here must not stop the server booting: the alternative is a
    // central system that will not start because of old rows, which takes every
    // PHC offline for a problem affecting a handful of cases.
    console.error(`[gradingQueue] stranded-case recovery failed: ${err.message}`);
    return 0;
  }

  // enqueue() returns false for anything already queued, inflight or backing
  // off, so only genuinely lost cases are counted -- and recorded (§D.3).
  const recovered = rows.map((r) => r.case_id).filter((id) => enqueue(id));
  if (recovered.length > 0) {
    console.log(`[gradingQueue] ${source}: recovered ${recovered.length} case(s) ` +
      "left 'processing' with no job behind them");
    try {
      await pool.query(`
        INSERT INTO grading_recoveries (case_id, source)
        SELECT unnest($1::uuid[]), $2
      `, [recovered, source]);
    } catch (err) {
      console.error(`[gradingQueue] could not record recoveries: ${err.message}`);
    }
  }
  return recovered.length;
}

function start() {
  if (started) return;
  started = true;
  pump();
}

/**
 * stop(opts)
 *
 * @param {boolean} [opts.drain=false] wait for inflight work to finish.
 *
 * Queued-but-not-started jobs are intentionally left in the array AND in the
 * database as 'processing', so the next boot's recoverStranded() finds them.
 * Discarding them here would lose exactly the cases this module promises not to
 * lose.
 */
async function stop({ drain = false } = {}) {
  started = false;
  if (drain && workers > 0) await onIdle();
}

/** Resolves when nothing is queued and no worker is running. */
function onIdle() {
  if (queue.length === 0 && workers === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

function resolveIdle() {
  if (queue.length > 0 || workers > 0) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const w of waiters) w();
}

function stats() {
  return {
    queued: queue.length,
    inflight: inflight.size,
    retrying: retrying.size,
    processed,
    failed,
    concurrency: CONCURRENCY,
    running: started,
  };
}

/** Test seam. Returns the previous function so a test can restore it. */
function _setGradingFn(fn) {
  const prev = runGrading;
  runGrading = fn || processCase;
  return prev;
}

/** Test seam: drop all state. Never call this from production code. */
function _reset() {
  queue.length = 0;
  queued.clear();
  inflight.clear();
  retrying.clear();
  workers = 0;
  started = false;
  processed = 0;
  failed = 0;
  idleWaiters = [];
  runGrading = processCase;
}

module.exports = {
  enqueue, start, stop, onIdle, recoverStranded, stats, clearFailure,
  _setGradingFn, _reset,
  MAX_ATTEMPTS, CONCURRENCY,
};
