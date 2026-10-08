'use strict';

/**
 * simulinkValidation.js -- the scheduled SimEvents validation run (backend plan
 * §G.2, second half).
 *
 * §G.2 offers two ways to feed the dashboard, and the project took option (b):
 * `referenceQueueingModel('recommend')` runs daily and produces the numbers
 * (resourceRecommendations.js), because it takes seconds and needs no Simulink
 * at request time. The other half of that option is the part that makes it
 * honest -- "with the full Simulink model run less frequently as the validation
 * check against it" -- and until now that check only ever ran when somebody
 * typed `runDistrictScreeningModel` by hand.
 *
 * So this runs the `.slx` weekly and records whether the two models still
 * agree.
 *
 * WHY IT MATTERS THAT IT IS SCHEDULED: what the admin dashboard shows comes
 * from the reference model. Its right to be believed comes entirely from having
 * agreed with the Simulink deliverable. A validation that ran once, in
 * September, on parameters nobody has touched since, is not evidence about the
 * model being served today -- it is a memory of one. When the two drift apart
 * this raises a `simulink_model_diverged` alert on System Health, so the
 * recommendation stops being trusted at the moment it stops being validated,
 * rather than at the moment someone thinks to re-check.
 *
 * WHAT IS COMPARED, and the tolerances, live in runDistrictScreeningModel.m
 * next to the metrics themselves -- not here. A tolerance stated in two places
 * is one that gets relaxed in only one of them. Upload figures are deliberately
 * not compared: the two models queue uploads differently by construction.
 *
 * WHEN: SIMULINK_VALIDATION_CRON, default Sunday 03:00 server time. Weekly, not
 * daily: the run takes minutes and loads Simulink, and the thing it is checking
 * changes only when someone edits a model.
 *
 * WHERE THE RESULT GOES: `simulink-model/out/last-validation.json`, which is
 * what §G.2 asks for ("writes a result file the API can read"), served by
 * GET /api/v1/admin/simulink-validation. A file and not a table: this is one
 * current fact about the models, not per-case history, and it must stay
 * readable when the database is the thing that is broken.
 */

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { raiseAlert, resolveAlert } = require('./systemAlerts');

const SIMULINK_DIR  = path.resolve(__dirname, '..', '..', '..', 'simulink-model');
const INFERENCE_DIR = path.resolve(__dirname, '..', 'ml-pipeline', 'inference');
const OUT_DIR       = path.join(SIMULINK_DIR, 'out');
const RESULT_PATH   = process.env.SIMULINK_VALIDATION_PATH
  || path.join(OUT_DIR, 'last-validation.json');

const MATLAB_EXE = process.env.MATLAB_EXECUTABLE || 'matlab';
const TIMEOUT_MS = Number(process.env.SIMULINK_VALIDATION_TIMEOUT_MS) || 20 * 60_000;
const CRON       = process.env.SIMULINK_VALIDATION_CRON || '0 3 * * 0';
const ALERT_KIND = 'simulink_model_diverged';

let running = null;   // the in-flight run, shared by concurrent callers
let task = null;

const toMatlabStr = (s) => String(s).replace(/\\/g, '/').replace(/'/g, "''");

function enabled() {
  const flag = process.env.SIMULINK_VALIDATION_ENABLED;
  return !(flag !== undefined && flag !== '' && /^(0|false|no|off)$/i.test(flag.trim()));
}

/** Test seam: how MATLAB is invoked. Resolves the parsed result struct. */
let runModel = () => new Promise((resolve, reject) => {
  // jsonencodeAscii, not jsonencode: Windows stdout is the ANSI code page and
  // drops the em dashes MATLAB text is full of.
  const expr = `addpath('${toMatlabStr(SIMULINK_DIR)}'); `
    + `addpath('${toMatlabStr(INFERENCE_DIR)}'); `
    + 'r = runDistrictScreeningModel(); disp(jsonencodeAscii(r));';
  execFile(MATLAB_EXE, ['-batch', expr],
    { cwd: SIMULINK_DIR, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(
          `SimEvents validation failed: ${err.message} ${stderr || ''}`.trim().slice(0, 600)));
      }
      // The function prints a human report first; the JSON is the first brace.
      const i = stdout.indexOf('{');
      if (i === -1) {
        return reject(new Error(`SimEvents validation printed no JSON: ${stdout.slice(0, 300)}`));
      }
      try { resolve(JSON.parse(stdout.slice(i))); }
      catch (e) { reject(new Error(`SimEvents validation JSON parse failed: ${e.message}`)); }
    });
});

function readResult() {
  try { return JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8')); } catch { return null; }
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  const tmp = `${RESULT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, RESULT_PATH);   // a reader never sees a half-written file
}

async function doRun() {
  const startedAt = new Date();
  let result;
  try {
    const r = await runModel();
    const checks = Array.isArray(r.checks) ? r.checks : [r.checks].filter(Boolean);
    result = {
      ranAt: r.ranAt || startedAt.toISOString(),
      status: r.agree ? 'agree' : 'diverged',
      checks,
      simEvents: {
        tierAAutoCleared: r.tierAAutoCleared,
        reviewed: r.reviewed,
        uploadUtilisation: r.uploadUtilisation,
        reviewerUtilisation: r.reviewerUtilisation,
        reviewWaitMeanSec: r.reviewWaitMeanSec,
      },
      reference: r.reference,
      params: r.params,
      simSeconds: r.simSeconds,
      // Said in the payload and not only in a doc: every parameter in this
      // model is an assumption, and a dashboard that shows these numbers
      // without that caveat is overstating them (design doc §16).
      note: 'All parameters are modelled assumptions, not measured field data.',
    };
  } catch (err) {
    // A run that could not happen is NOT agreement, and must not be recorded as
    // one. It is also not divergence -- nothing was compared -- so it gets its
    // own status and its own alert text.
    result = {
      ranAt: startedAt.toISOString(),
      status: 'error',
      error: err.message,
      checks: [],
    };
  }
  writeResult(result);

  if (result.status === 'agree') {
    console.log('[simulinkValidation] SimEvents and the reference model still agree.');
    await resolveAlert(ALERT_KIND);
  } else if (result.status === 'diverged') {
    const failed = result.checks.filter((c) => !c.agree)
      .map((c) => `${c.metric}: SimEvents ${Number(c.simEvents).toFixed(1)}${c.unit} vs `
        + `reference ${Number(c.reference).toFixed(1)}${c.unit} (tolerance ${c.tolerance})`)
      .join('; ');
    const message = 'The SimEvents model and the reference queueing model no longer agree. '
      + 'The resource recommendations on the dashboard come from the reference model, and '
      + `its validation is what this checks. ${failed}`;
    console.error(`[simulinkValidation] DIVERGED -- ${failed}`);
    await raiseAlert(ALERT_KIND, '', message);
  } else {
    console.error(`[simulinkValidation] could not run: ${result.error}`);
    await raiseAlert(ALERT_KIND, '', `The weekly SimEvents validation could not run, so the `
      + `resource model is currently unvalidated: ${result.error}`);
  }
  return result;
}

/** Run now, or join the run already in flight. */
function refresh() {
  if (!running) running = doRun().finally(() => { running = null; });
  return running;
}

/** The last recorded result, or null if it has never run on this machine. */
function latest() {
  return readResult();
}

function start() {
  if (task || !enabled()) {
    if (!enabled()) console.log('[simulinkValidation] disabled (SIMULINK_VALIDATION_ENABLED).');
    return;
  }
  const cron = require('node-cron');
  if (!cron.validate(CRON)) {
    // Same rule as the resource model's: a bad cron string is a configuration
    // mistake, not a reason the backend should refuse to start.
    console.error(`[simulinkValidation] SIMULINK_VALIDATION_CRON "${CRON}" is not a valid `
      + 'cron expression -- the weekly validation is NOT scheduled.');
    return;
  }
  task = cron.schedule(CRON, () => { refresh().catch(() => {}); });
  console.log(`[simulinkValidation] weekly SimEvents validation scheduled (${CRON}).`);
}

function stop() {
  if (task) { task.stop(); task = null; }
}

module.exports = {
  start, stop, refresh, latest, enabled,
  RESULT_PATH, ALERT_KIND, CRON,
  _setRunner: (fn) => { const prev = runModel; runModel = fn; return prev; },
};
