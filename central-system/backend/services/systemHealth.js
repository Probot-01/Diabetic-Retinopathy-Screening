'use strict';

/**
 * systemHealth.js -- the four checks behind GET /api/v1/admin/system-health
 * (backend plan §F, design doc §10.7 / §1.17).
 *
 * A PHC gone silent, a grading job stuck, a dead MATLAB session and a referable
 * case nobody has reviewed are the same class of failure: nothing errors, the
 * system just quietly stops doing its job for someone. Each gets a threshold
 * and they are reported together, in one response, for one admin screen.
 *
 * Thresholds (env, all optional):
 *   PHC_SILENT_HOURS       24   no contact of any kind for this long (services/phcSilence.js)
 *   STUCK_JOB_MINUTES      15   'processing' this long with no recent recovery
 *                               (normal grading is ~12.5 s)
 *   UNREVIEWED_CASE_HOURS  48   referable, never reviewed, received this long ago
 */

const pool = require('../db/pgClient');
const supervisor = require('./matlabSessionSupervisor');
const segSupervisor = require('./segWorkerSupervisor');
const { openAlerts } = require('./systemAlerts');
const watchdog = require('./gradingWatchdog');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const { PHC_SILENT_HOURS } = require('./phcSilence');   // the one definition of a silent PHC
const STUCK_JOB_MINUTES     = num('STUCK_JOB_MINUTES', 15);
const UNREVIEWED_CASE_HOURS = num('UNREVIEWED_CASE_HOURS', 48);

const hoursSince = (d) => (d ? Math.floor((Date.now() - d.getTime()) / 3_600_000) : null);

async function silentPhcs() {
  // last_contact_at, NOT last_sync_at (§F.1): a site pushing only summary
  // packets over a thin link is in contact and must not alert. A site with no
  // contact at all yet (NULL) is listed too -- "never heard from" is the most
  // silent a site can be.
  const { rows } = await pool.query(`
    SELECT phc_id, name, last_contact_at
    FROM phc_sites
    WHERE last_contact_at IS NULL
       OR last_contact_at < now() - make_interval(hours => $1)
    ORDER BY last_contact_at ASC NULLS FIRST
  `, [PHC_SILENT_HOURS]);   // same rule as phcSilence.isSilent()
  return rows.map((r) => ({
    phcId:         r.phc_id,
    phcName:       r.name,
    lastContactAt: r.last_contact_at ? r.last_contact_at.toISOString() : null,
    hoursSilent:   hoursSince(r.last_contact_at),
  }));
}

async function stuckJobs() {
  // Stuck = still 'processing' STUCK_JOB_MINUTES after it arrived AND after
  // its last automatic recovery -- so a case the watchdog just re-queued gets
  // a fair run before it is reported. A case the watchdog has given up on
  // (autoRecoveredCount >= its cap) is always reported: it will not move again
  // without a human.
  const { rows } = await pool.query(`
    SELECT c.case_id,
           COALESCE(c.processing_started_at, c.received_at) AS started_at,
           count(r.recovery_id)::int AS recoveries,
           max(r.recovered_at)       AS last_recovered_at
    FROM cases c
    LEFT JOIN grading_recoveries r ON r.case_id = c.case_id
    WHERE c.status = 'processing'
    GROUP BY c.case_id, c.processing_started_at, c.received_at
    HAVING GREATEST(COALESCE(c.processing_started_at, c.received_at),
                    COALESCE(max(r.recovered_at),
                             COALESCE(c.processing_started_at, c.received_at)))
             < now() - make_interval(mins => $1)
        OR count(r.recovery_id) >= $2
    ORDER BY COALESCE(c.processing_started_at, c.received_at) ASC
  `, [STUCK_JOB_MINUTES, watchdog.MAX_RECOVERIES]);
  return rows.map((r) => ({
    caseId:             r.case_id,
    stuckSince:         r.started_at.toISOString(),
    autoRecoveredCount: r.recoveries,
    lastRecoveredAt:    r.last_recovered_at ? r.last_recovered_at.toISOString() : null,
    autoRecoveryExhausted: r.recoveries >= watchdog.MAX_RECOVERIES,
  }));
}

async function unreviewedCases() {
  const { rows } = await pool.query(`
    SELECT c.case_id, g.conformal_tier, c.received_at
    FROM cases c
    JOIN grading_results g ON g.case_id = c.case_id
    WHERE g.referable = true
      AND c.received_at < now() - make_interval(hours => $1)
      AND NOT EXISTS (SELECT 1 FROM ophthalmologist_reviews r WHERE r.case_id = c.case_id)
    ORDER BY c.received_at ASC
  `, [UNREVIEWED_CASE_HOURS]);
  return rows.map((r) => ({
    caseId:          r.case_id,
    tier:            r.conformal_tier,
    createdAt:       r.received_at.toISOString(),
    hoursUnreviewed: hoursSince(r.received_at),
  }));
}

async function failedCases() {
  // A case that gave up is NOT a stuck job: stuckJobs() looks at 'processing',
  // which by definition is still moving or recoverable. An 'error' case will
  // never move again on its own, and until migration 0014 the database could
  // not say why any of them stopped -- the reason lived in a log line that is
  // long gone.
  //
  // Grouped by cause, because that is the question an operator actually has.
  // "62 failed" is a number to worry about; "58 of them are one missing
  // executable" is something to fix.
  const { rows } = await pool.query(`
    SELECT COALESCE(failure_code, 'not_recorded') AS code,
           count(*)::int AS n,
           max(failed_at) AS last_failed_at,
           (array_agg(failure_reason ORDER BY failed_at DESC NULLS LAST))[1] AS example,
           (array_agg(case_id::text ORDER BY failed_at DESC NULLS LAST))[1] AS example_case
      FROM cases
     WHERE status = 'error'
     GROUP BY 1
     ORDER BY 2 DESC
  `);
  return rows.map((r) => ({
    failureCode:  r.code,
    count:        r.n,
    lastFailedAt: r.last_failed_at ? r.last_failed_at.toISOString() : null,
    // 'not_recorded' rows predate 0014. Saying so beats an empty string that
    // reads as "failed for no reason".
    exampleReason: r.example
      || (r.code === 'not_recorded' ? 'failed before the reason was recorded' : null),
    exampleCaseId: r.example_case,
  }));
}

async function getSystemHealth() {
  const [phcs, stuck, failed, unreviewed, alerts] = await Promise.all([
    silentPhcs(), stuckJobs(), failedCases(), unreviewedCases(), openAlerts(),
  ]);
  const matlab = supervisor.getStatus();
  const segWorker = segSupervisor.getStatus();
  return {
    silentPhcs: phcs,
    stuckJobs: stuck,
    // Cases that gave up, grouped by cause (migration 0014). Separate from
    // stuckJobs on purpose: a stuck case may still recover on its own, a
    // failed one needs a person.
    failedCases: failed,
    failedCaseCount: failed.reduce((n, f) => n + f.count, 0),
    matlabSessionStatus: matlab.status,
    unreviewedCases: unreviewed,
    // Additive to the plan's four keys: the detail behind the MATLAB status,
    // every open alert, and the thresholds in force -- so the admin UI can say
    // "silent for more than 48 h" without hard-coding a number of its own.
    matlabSession: matlab,
    // The segmentation worker. Deliberately NOT folded into an overall
    // "healthy" flag: the MATLAB session being down fails cases, this being
    // down only makes them slower, and an admin who cannot tell those apart
    // will treat both as the same emergency or neither as one.
    segWorker,
    alerts,
    thresholds: {
      silentPhcHours: PHC_SILENT_HOURS,
      stuckJobMinutes: STUCK_JOB_MINUTES,
      unreviewedCaseHours: UNREVIEWED_CASE_HOURS,
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getSystemHealth, PHC_SILENT_HOURS, STUCK_JOB_MINUTES, UNREVIEWED_CASE_HOURS };
