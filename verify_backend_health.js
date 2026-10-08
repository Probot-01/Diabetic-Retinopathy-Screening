'use strict';

/**
 * verify_backend_health.js -- backend plan §D (grading watchdog), §E (MATLAB
 * session supervisor) and §F (GET /api/v1/admin/system-health).
 *
 * Run:  node verify_backend_health.js
 *
 * Needs the central Postgres with migrations applied. Does NOT need or launch
 * MATLAB: the supervisor's manageMatlabSession.ps1 calls are replaced by a
 * recorder, and liveness is simulated by writing/removing the heartbeat file
 * the real session maintains. The grading queue's workers are never started,
 * so nothing is graded.
 *
 * Cleans up everything it creates (temp PHC site, patient, cases, recovery and
 * alert rows, the heartbeat file).
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const CENTRAL = path.resolve(__dirname, 'central-system', 'backend');
require(require.resolve('dotenv', { paths: [CENTRAL] }))
  .config({ path: path.resolve(__dirname, '.env') });

// Before any module reads them.
process.env.AUTH_ENABLED = 'false';
process.env.INFERENCE_BACKEND = 'matlab';
process.env.MATLAB_SUPERVISOR_ENABLED = 'true';
process.env.MATLAB_STARTUP_GRACE_MS = '150';
process.env.MATLAB_HEARTBEAT_STALE_MS = '30000';
process.env.MATLAB_MAX_RESTARTS = '3';
// Watch a heartbeat file of our own: the real session, when one is running on
// this machine, rewrites its own every 5 s and would make every "session is
// dead" step below silently pass as healthy.
process.env.MATLAB_HEARTBEAT_PATH = require('path').join(
  require('os').tmpdir(), `verify_health_${process.pid}.heartbeat`);
process.env.GRADING_RETRY_BASE_MS = '600000';   // a failed job stays in backoff for the test
// §G.2: write the validation result somewhere disposable, not over the real one.
process.env.SIMULINK_VALIDATION_PATH = require('path').join(
  require('os').tmpdir(), `verify_health_${process.pid}_validation.json`);

const pool         = require(path.join(CENTRAL, 'db', 'pgClient'));
const gradingQueue = require(path.join(CENTRAL, 'services', 'gradingQueue'));
const watchdog     = require(path.join(CENTRAL, 'services', 'gradingWatchdog'));
const supervisor   = require(path.join(CENTRAL, 'services', 'matlabSessionSupervisor'));
const simulink     = require(path.join(CENTRAL, 'services', 'simulinkValidation'));
const app          = require(path.join(CENTRAL, 'server.js'));

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const testStart = new Date();
  // server.js started the queue on import; stop it so enqueue() only queues.
  await gradingQueue.stop();
  gradingQueue._reset();

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  const patientId = `ZZTEST-${crypto.randomBytes(4).toString('hex')}`;
  let siteId;

  try {
    const otherProcessing = (await pool.query(
      "SELECT count(*)::int n FROM cases WHERE status = 'processing'")).rows[0].n;
    if (otherProcessing > 0) {
      console.log(`  NOTE  ${otherProcessing} real case(s) already 'processing' -- the sweeps below ` +
        'will pick those up too (and record recoveries for them), exactly as in production.');
    }

    siteId = (await pool.query(`
      INSERT INTO phc_sites (name, last_contact_at)
      VALUES ('ZZ verify_backend_health silent', now() - interval '72 hours') RETURNING phc_id`)).rows[0].phc_id;
    await pool.query(`INSERT INTO patients (patient_id, name, age, contact_number, registered_at)
                      VALUES ($1, 'Zz Health', 60, '+910000000001', now())`, [patientId]);

    const mkCase = async (status, age, ref) => (await pool.query(`
      INSERT INTO cases (patient_id, phc_id, capture_id_ref, image_path, status, received_at)
      VALUES ($1, $2, $3, 'x.jpg', $4, now() - $5::interval) RETURNING case_id`,
      [patientId, siteId, ref, status, age])).rows[0].case_id;

    // ── §D watchdog ─────────────────────────────────────────────────────────
    console.log('\n===== Grading watchdog (§D) =====');
    const stranded = await mkCase('processing', '30 minutes', `ZZTEST-str-${Date.now()}`);
    const fresh    = await mkCase('processing', '5 seconds',  `ZZTEST-new-${Date.now()}`);

    await watchdog.sweep();
    const q1 = gradingQueue.stats();
    let recs = (await pool.query(
      'SELECT source FROM grading_recoveries WHERE case_id = $1', [stranded])).rows;
    check('a stranded processing case is re-enqueued and recorded (source watchdog)',
      recs.length === 1 && recs[0].source === 'watchdog', { recs, q1 });
    const freshRecs = (await pool.query('SELECT 1 FROM grading_recoveries WHERE case_id = $1', [fresh])).rows;
    check('a case younger than WATCHDOG_MIN_AGE_SECONDS is left alone', freshRecs.length === 0);

    await watchdog.sweep();
    recs = (await pool.query('SELECT 1 FROM grading_recoveries WHERE case_id = $1', [stranded])).rows;
    check('sweeping again while it is still queued does nothing (dedupe)', recs.length === 1);

    // Simulate the job being lost twice more, then a fourth time past the cap.
    for (let i = 0; i < 3; i++) { gradingQueue._reset(); await watchdog.sweep(); }
    recs = (await pool.query('SELECT 1 FROM grading_recoveries WHERE case_id = $1', [stranded])).rows;
    check(`recovery stops at WATCHDOG_MAX_RECOVERIES (${watchdog.MAX_RECOVERIES}), not forever`,
      recs.length === watchdog.MAX_RECOVERIES, recs.length);

    // A job waiting out a retry backoff must not be mistaken for a lost one.
    gradingQueue._reset();
    const backoff = await mkCase('processing', '30 minutes', `ZZTEST-bo-${Date.now()}`);
    const prev = gradingQueue._setGradingFn(async () => { throw new Error('transient'); });
    gradingQueue.enqueue(backoff);
    gradingQueue.start();
    await sleep(100);
    await gradingQueue.stop();
    check('the failing job is now in retry backoff', gradingQueue.stats().retrying === 1, gradingQueue.stats());
    await watchdog.sweep();
    const boRecs = (await pool.query('SELECT 1 FROM grading_recoveries WHERE case_id = $1', [backoff])).rows;
    check('the watchdog does NOT re-enqueue a job that is backing off (no attempt reset)',
      boRecs.length === 0);
    gradingQueue._setGradingFn(prev);
    gradingQueue._reset();

    // A summary-first case: received days ago, grading started seconds ago.
    // Measuring from received_at reported this as stuck immediately.
    const summaryish = (await pool.query(`
      INSERT INTO cases (patient_id, phc_id, capture_id_ref, image_path, status,
                         received_at, processing_started_at)
      VALUES ($1, $2, $3, 'x.jpg', 'processing', now() - interval '3 days', now())
      RETURNING case_id`, [patientId, siteId, `ZZTEST-sum-${Date.now()}`])).rows[0].case_id;
    await watchdog.sweep();
    const sumRecs = (await pool.query(
      'SELECT 1 FROM grading_recoveries WHERE case_id = $1', [summaryish])).rows;
    check('a case received days ago but only now processing is not "stranded"',
      sumRecs.length === 0);

    // ── §E supervisor ───────────────────────────────────────────────────────
    console.log('\n===== MATLAB session supervisor (§E) =====');
    const calls = [];
    let startOk = true;
    supervisor._setManager(async (cmd) => { calls.push(cmd); return { ok: cmd !== 'start' || startOk, output: 'stub' }; });
    const alertOpen = async () => (await pool.query(
      "SELECT occurrences FROM system_alerts WHERE kind = 'matlab_session_down' AND resolved_at IS NULL")).rows[0];
    const beat = () => fs.writeFileSync(supervisor.HEARTBEAT, new Date().toISOString());
    const noBeat = () => fs.rmSync(supervisor.HEARTBEAT, { force: true });

    supervisor._reset('unknown'); noBeat();
    let s = await supervisor.checkOnce();
    check('boot with no session running -> it is started (stop, start)',
      s === 'restarting' && calls.join(',') === 'stop,start', { s, calls });
    check('...without raising an alert for a plain cold start', !(await alertOpen()));

    s = await supervisor.checkOnce();
    check('inside the startup grace period it waits instead of restarting again',
      s === 'restarting' && calls.length === 2);

    beat();
    s = await supervisor.checkOnce();
    check('a fresh heartbeat -> healthy', s === 'healthy' && supervisor.getStatus().lastHeartbeatAt);

    // Heartbeat goes stale (hung or crashed).
    fs.utimesSync(supervisor.HEARTBEAT, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    calls.length = 0;
    s = await supervisor.checkOnce();
    check('a stale heartbeat (hung session) -> restart via stop+start',
      s === 'restarting' && calls.join(',') === 'stop,start', { s, calls });

    // Restart never produces a heartbeat: alert, retry, then give up at the cap.
    noBeat();
    for (let i = 0; i < 4; i++) { await sleep(200); await supervisor.checkOnce(); }
    check('no heartbeat after a restart -> matlab_session_down alert raised', !!(await alertOpen()));
    check(`gives up after MATLAB_MAX_RESTARTS (3) and reports down`,
      supervisor.getStatus().status === 'down' && supervisor.getStatus().restartsInWindow === 3,
      supervisor.getStatus());
    const before = calls.length;
    await sleep(200); await supervisor.checkOnce();
    check('once down it stops restarting (no restart loop)', calls.length === before);

    // Operator fixes it by hand: the heartbeat comes back.
    beat();
    s = await supervisor.checkOnce();
    check('heartbeat returns -> healthy again, alert auto-resolved',
      s === 'healthy' && !(await alertOpen()), { s });

    // A restart command that itself fails -> down + alert immediately.
    fs.utimesSync(supervisor.HEARTBEAT, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    startOk = false;
    s = await supervisor.checkOnce();
    check('a failing start command -> down with an alert straight away',
      s === 'down' && !!(await alertOpen()), { s, st: supervisor.getStatus() });

    // ── §F system health ────────────────────────────────────────────────────
    console.log('\n===== System health endpoint (§F) =====');
    const old = await mkCase('graded', '3 days', `ZZTEST-old-${Date.now()}`);
    await pool.query(`INSERT INTO grading_results (case_id, dr_grade_cnn, referable, conformal_tier)
                      VALUES ($1, 3, true, 'C')`, [old]);
    const recent = await mkCase('graded', '1 hour', `ZZTEST-rec-${Date.now()}`);
    await pool.query(`INSERT INTO grading_results (case_id, dr_grade_cnn, referable, conformal_tier)
                      VALUES ($1, 3, true, 'C')`, [recent]);

    const res = await fetch(`${BASE}/api/v1/admin/system-health`);
    const h = await res.json();
    check('GET /admin/system-health -> 200 with the four plan keys',
      res.status === 200 && ['silentPhcs', 'stuckJobs', 'matlabSessionStatus', 'unreviewedCases']
        .every((k) => k in h), Object.keys(h));
    const silent = h.silentPhcs.find((p) => p.phcId === siteId);
    check('a PHC silent for 72h is listed with hoursSilent', silent && silent.hoursSilent >= 71, silent);
    check('...and it is not reported as a stuck job either',
      !h.stuckJobs.some((j) => j.caseId === summaryish),
      h.stuckJobs.find((j) => j.caseId === summaryish));
    const stuck = h.stuckJobs.find((j) => j.caseId === stranded);
    check('the stranded case is a stuck job, with autoRecoveredCount and exhausted flag',
      stuck && stuck.autoRecoveredCount === 3 && stuck.autoRecoveryExhausted === true, stuck);
    check('a 5-second-old processing case is NOT reported stuck',
      !h.stuckJobs.some((j) => j.caseId === fresh));
    check('matlabSessionStatus reflects the supervisor (down)', h.matlabSessionStatus === 'down', h.matlabSessionStatus);
    check('open alerts are included', h.alerts.some((a) => a.kind === 'matlab_session_down'), h.alerts);
    const un = h.unreviewedCases.find((c) => c.caseId === old);
    check('a referable case unreviewed for 3 days is listed with tier and hours',
      un && un.tier === 'C' && un.hoursUnreviewed >= 71, un);
    check('a referable case received 1 hour ago is not (yet)',
      !h.unreviewedCases.some((c) => c.caseId === recent));
    // 24, not 48: the 2026-09-27 demo-prep change gave /admin/system-health and
    // /admin/phcs ONE definition of a silent PHC (services/phcSilence.js, env
    // PHC_SILENT_HOURS) because the two screens could disagree about the same
    // site. api-contracts.md records the change and its response example says
    // 24. This assertion still said 48 and had been failing ever since.
    // A GRADED CASE MUST NOT CARRY A FAILURE. A case reaches 'graded' after
    // having failed whenever the queue retries it, the watchdog recovers it,
    // or someone re-grades it by hand. The orchestrator's success UPDATE used
    // to leave failure_code / failure_reason / failed_at behind, so the row
    // said "graded" and getCaseDetail -- which serves failure_code straight,
    // with no status check -- reported the old reason as this case's own.
    // api-contracts.md: failureCode is "null on every case that has not
    // failed". /admin/system-health filters on status='error' and was never
    // wrong, which is exactly why nothing caught this.
    const dirty = (await pool.query(`
      SELECT count(*)::int n FROM cases
       WHERE status = 'graded'
         AND (failure_code IS NOT NULL OR failure_reason IS NOT NULL OR failed_at IS NOT NULL)`)).rows[0].n;
    check('no graded case still carries a failure code, reason or timestamp',
      dirty === 0,
      `${dirty} graded case(s) carry failure fields. Re-grading clears them now; rows `
      + 'from before that fix need one UPDATE.');

    check('thresholds are reported for the UI',
      h.thresholds && h.thresholds.silentPhcHours === 24
      && h.thresholds.stuckJobMinutes === 15 && h.thresholds.unreviewedCaseHours === 48,
      h.thresholds);

    const sync = await (await fetch(`${BASE}/api/v1/phc/${siteId}/sync-status`)).json();
    check('PHC sync-status now also carries lastContactAt', 'lastContactAt' in sync && sync.lastContactAt, sync);

    // ── §G.2: the scheduled SimEvents validation ──────────────────────────
    // The admin dashboard's resource recommendations come from the reference
    // queueing model, and its right to be believed comes entirely from having
    // agreed with the SimEvents deliverable. What is asserted here is that the
    // check is capable of FAILING -- a validation that can only ever report
    // agreement is decoration.
    console.log('\n--- §G.2: SimEvents validation ---');
    const AGREE = {
      ranAt: '2026-09-20T03:00:00Z', agree: true, simSeconds: 31,
      checks: [{ metric: 'auto-clear share', simEvents: 71, reference: 68.4,
                 tolerance: 5, unit: '%', agree: true }],
      reference: { casesReviewed: 2510 }, params: { simDays: 20 },
    };
    const DIVERGED = JSON.parse(JSON.stringify(AGREE));
    DIVERGED.agree = false;
    DIVERGED.checks[0] = { metric: 'auto-clear share', simEvents: 71, reference: 40,
                           tolerance: 5, unit: '%', agree: false };

    check('no result before it has ever run', simulink.latest() === null);

    let restore = simulink._setRunner(async () => AGREE);
    let vr = await simulink.refresh();
    check('a run that agrees is recorded as agreeing', vr.status === 'agree', vr.status);
    check('the result is readable back from the file it wrote',
      simulink.latest() && simulink.latest().status === 'agree');
    check('agreement raises no alert',
      !(await (await fetch(`${BASE}/api/v1/admin/system-health`)).json())
        .alerts.some((a) => a.kind === simulink.ALERT_KIND));

    simulink._setRunner(async () => DIVERGED);
    vr = await simulink.refresh();
    check('divergence is recorded as divergence, not as a pass',
      vr.status === 'diverged', vr.status);
    const alerted = await (await fetch(`${BASE}/api/v1/admin/system-health`)).json();
    const divergeAlert = alerted.alerts.find((a) => a.kind === simulink.ALERT_KIND);
    check('divergence raises an alert on System Health', !!divergeAlert);
    check('the alert names the metric and both numbers',
      divergeAlert && /auto-clear share/.test(divergeAlert.message)
        && /71/.test(divergeAlert.message) && /40/.test(divergeAlert.message),
      divergeAlert && divergeAlert.message);

    // A run that could not happen is NOT agreement. Recording it as one would
    // let a broken MATLAB install read as "validated" forever.
    simulink._setRunner(async () => { throw new Error('Simulink licence unavailable'); });
    vr = await simulink.refresh();
    check('a run that failed is neither agreement nor divergence',
      vr.status === 'error' && /licence/.test(vr.error), vr);
    check('a failed run still alerts, so nothing looks validated when it is not',
      (await (await fetch(`${BASE}/api/v1/admin/system-health`)).json())
        .alerts.some((a) => a.kind === simulink.ALERT_KIND));

    simulink._setRunner(async () => AGREE);
    await simulink.refresh();
    check('agreement afterwards resolves the alert automatically',
      !(await (await fetch(`${BASE}/api/v1/admin/system-health`)).json())
        .alerts.some((a) => a.kind === simulink.ALERT_KIND));
    simulink._setRunner(restore);

    const served = await (await fetch(`${BASE}/api/v1/admin/simulink-validation`)).json();
    check('the endpoint serves the recorded result', served.status === 'agree', served);
    check('and carries the assumptions caveat with it',
      typeof served.note === 'string' && /assumption/i.test(served.note), served.note);
  } finally {
    simulink.stop();
    fs.rmSync(process.env.SIMULINK_VALIDATION_PATH, { force: true });
    supervisor.stop();
    fs.rmSync(supervisor.HEARTBEAT, { force: true });   // our own temp file
    await pool.query('DELETE FROM system_alerts WHERE first_seen_at >= $1', [testStart]);
    // The sweeps also re-queue (in memory only) any REAL stranded cases; drop
    // the recovery rows written for them during this run so the test leaves no
    // trace in their history.
    await pool.query('DELETE FROM grading_recoveries WHERE recovered_at >= $1', [testStart]);
    await pool.query('DELETE FROM cases WHERE patient_id = $1', [patientId]);
    await pool.query('DELETE FROM patients WHERE patient_id = $1', [patientId]);
    if (siteId) await pool.query('DELETE FROM phc_sites WHERE phc_id = $1', [siteId]);
    gradingQueue._reset();
    server.close();
    await pool.end();
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
