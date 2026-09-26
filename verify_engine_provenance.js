#!/usr/bin/env node
'use strict';

/**
 * verify_engine_provenance.js
 *
 * Standing rule: every case records which engine (matlab / python /
 * js-fallback) produced each ML output, and no engine switch is silent. This
 * checks the pieces that make that true, without MATLAB:
 *
 *   1. buildEngineProvenance -- what the orchestrator stores per case.
 *   2. toContractShape       -- what GET /api/v1/cases/:caseId serves: every
 *                               key present, null for "not recorded".
 *   3. segment()             -- a MATLAB-engine failure reported by the
 *                               segmentation worker REJECTS (the case fails or
 *                               retries); it is not degraded to classifier-only.
 *   4. segInfer.py           -- with the MATLAB session unreachable: exits 4
 *                               with the fallback off; with
 *                               SEG_ALLOW_PYTHON_FALLBACK=1 it succeeds and
 *                               reports every model's engine, fallback: true
 *                               for the three MATLAB-served ones.
 *                               Needs PYTHON_EXECUTABLE + the model files, and
 *                               is SKIPPED when a live MATLAB session is up
 *                               (it would answer, which is not the point).
 *   5. GET /health           -- reachability stays 'ok'; db, queue,
 *                               matlabSession, python reported separately.
 *                               Needs the database in central-system/backend/.env.
 *
 *   node verify_engine_provenance.js [--no-python] [--no-db]
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CENTRAL = path.join(__dirname, 'central-system', 'backend');
require(path.join(CENTRAL, 'loadEnv'));

const SKIP_PY = process.argv.includes('--no-python');
const SKIP_DB = process.argv.includes('--no-db');

// Real session state is read BEFORE the scratch overrides below, for check 4's
// precondition.
const LIVE_SESSION_HEARTBEAT = path.join(CENTRAL, 'ml-pipeline', 'inference',
  'matlabSession', 'session.heartbeat');
const liveSessionUp = (() => {
  try { return Date.now() - fs.statSync(LIVE_SESSION_HEARTBEAT).mtimeMs < 30_000; } catch { return false; }
})();

// Scratch session dirs, so nothing here talks to a live worker.
const segScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-prov-seg-'));
process.env.SEG_SESSION_DIR = segScratch;
process.env.SEG_HEARTBEAT_PATH = path.join(segScratch, 'worker.heartbeat');
const mlScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-prov-ml-'));
process.env.MATLAB_SESSION_DIR = mlScratch;
process.env.MATLAB_HEARTBEAT_PATH = path.join(mlScratch, 'session.heartbeat');
process.env.MATLAB_SUPERVISOR_ENABLED = 'false';
process.env.SEG_WORKER_SUPERVISOR_ENABLED = 'false';

const orchestrator = require(path.join(CENTRAL, 'services', 'gradingOrchestrator'));
const provenance   = require(path.join(CENTRAL, 'services', 'engineProvenance'));
const segSession   = require(path.join(CENTRAL, 'services', 'segSessionClient'));

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${detail}`); }
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const MATLAB_SEG = {
  vessel:       { engine: 'matlab', fallback: false, detail: 'MATLAB session forward pass (vessel_unet_v1)' },
  localization: { engine: 'matlab', fallback: false, detail: 'x' },
  hardExudate:  { engine: 'matlab', fallback: false, detail: 'x' },
  redLesion:    { engine: 'python', fallback: false, detail: 'PyTorch; not converted for MATLAB serving' },
};

async function main() {
  console.log('\n--- 1. What the orchestrator stores per case ---');
  const { buildEngineProvenance } = orchestrator;

  const live = buildEngineProvenance({
    inferenceBackend: 'matlab', segResult: { engines: MATLAB_SEG }, casePipelineVia: 'session' });
  check('classifier on the MATLAB backend is matlab', live.classifier.engine === 'matlab'
    && live.classifier.fallback === false, JSON.stringify(live.classifier));
  check('classifier detail says preprocessing is Python',
    /preprocessBranchATensor\.py/.test(live.classifier.detail));
  check('each segmentation model keeps its own engine',
    live.segmentation.vessel.engine === 'matlab' && live.segmentation.redLesion.engine === 'python');
  check('rule engine in the session is matlab, not a fallback',
    live.ruleEngine.engine === 'matlab' && live.ruleEngine.fallback === false);

  const py = buildEngineProvenance({ inferenceBackend: 'python', segResult: null, casePipelineVia: 'batch' });
  check('classifier on the python backend is python', py.classifier.engine === 'python');
  check('segmentation that did not run is null, not four nulls', py.segmentation === null);
  check('a matlab -batch case pipeline is still matlab, and says so',
    py.ruleEngine.engine === 'matlab' && /matlab -batch/.test(py.ruleEngine.detail));

  const js = buildEngineProvenance({ inferenceBackend: 'matlab', segResult: {}, casePipelineVia: 'js-fallback' });
  check('the JS rule-engine substitute is js-fallback with fallback: true',
    js.ruleEngine.engine === 'js-fallback' && js.ruleEngine.fallback === true);
  check('a segResult without an engines block records each model as null',
    js.segmentation && Object.values(js.segmentation).every((v) => v === null),
    JSON.stringify(js.segmentation));

  const odd = buildEngineProvenance({ inferenceBackend: 'matlab',
    segResult: { engines: { vessel: { engine: 'cuda' }, localization: 'matlab' } }, casePipelineVia: null });
  check('an unknown engine value is not stored as if it were real',
    odd.segmentation.vessel === null && odd.segmentation.localization === null);
  check('a case pipeline that never reported how it ran is null', odd.ruleEngine === null);

  console.log('\n--- 2. What GET /api/v1/cases/:caseId serves ---');
  const none = provenance.toContractShape(null, null);
  check('ungraded / pre-0019 case: every key present',
    ['classifier', 'segmentation', 'ruleEngine', 'qualityGate'].every((k) => has(none, k)),
    JSON.stringify(none));
  check('...and every value null', Object.values(none).every((v) => v === null));
  check('survives JSON.stringify with keys intact (null, not undefined)',
    JSON.stringify(none) === '{"classifier":null,"segmentation":null,"ruleEngine":null,"qualityGate":null}',
    JSON.stringify(none));
  const full = provenance.toContractShape(live,
    { engine: 'js-fallback', fallback: true, detail: 'qualityGateFallback.js' });
  check('quality gate comes from the case, grading outputs from the result',
    full.qualityGate.engine === 'js-fallback' && full.qualityGate.fallback === true
      && full.classifier.engine === 'matlab');
  check('segmentation serves exactly the four contract keys',
    JSON.stringify(Object.keys(full.segmentation)) ===
      '["vessel","localization","hardExudate","redLesion"]', JSON.stringify(Object.keys(full.segmentation)));
  check('an over-long detail is truncated, not stored whole',
    provenance.normaliseEngineEntry({ engine: 'python', detail: 'x'.repeat(5000) }).detail.length === 300);

  console.log('\n--- 3. A MATLAB-engine failure in the segmentation worker fails the case ---');
  fs.writeFileSync(process.env.SEG_HEARTBEAT_PATH, 'now');
  check('(precondition) the scratch worker looks alive', segSession.alive());
  const seg = orchestrator.segment(path.join(os.tmpdir(), 'nonexistent.jpg'), '');
  await serveOnce({ error: 'MatlabEngineFailed: MATLAB session failed for vessel (no response)',
    code: 'matlab_segmentation_failed' });
  let segErr = null;
  try { await seg; } catch (err) { segErr = err; }
  check('segment() rejects instead of resolving null', segErr !== null);
  check('with the retryable code matlab_segmentation_failed',
    segErr && segErr.code === 'matlab_segmentation_failed', segErr && segErr.code);
  check('and does not re-run segmentation in a fresh process',
    !fs.readdirSync(path.join(segScratch, 'requests')).some((f) => f.endsWith('.json')));
  fs.unlinkSync(process.env.SEG_HEARTBEAT_PATH);

  console.log('\n--- 4. segInfer.py with the MATLAB session unreachable ---');
  if (SKIP_PY) {
    console.log('  SKIP  --no-python');
  } else if (liveSessionUp) {
    console.log('  SKIP  a live MATLAB session is up in this checkout and would answer; '
      + 'stop it (manageMatlabSession.ps1 stop) to run this');
  } else {
    await checkSegInfer();
  }

  console.log('\n--- 5. GET /health ---');
  if (SKIP_DB) console.log('  SKIP  --no-db');
  else await checkHealth();

  console.log(failures ? `\n===== ${failures} FAILURE(S) =====` : '\n===== ALL PASSED =====');
  process.exit(failures ? 1 : 0);
}

async function checkSegInfer() {
  const pyExe = process.env.PYTHON_EXECUTABLE || 'python';
  const image = firstFixture();
  if (!image) { console.log('  SKIP  no public-dataset fixture image found'); return; }
  const script = path.join(CENTRAL, 'ml-pipeline', 'inference', 'segInfer.py');
  const env = { ...process.env, SEG_INFERENCE_BACKEND: 'matlab', MATLAB_SESSION_TIMEOUT_MS: '1500' };
  delete env.SEG_ALLOW_PYTHON_FALLBACK;

  const off = spawnSync(pyExe, [script, image], { env, encoding: 'utf8', timeout: 300_000 });
  check('fallback off: exits 4 (MATLAB engine failed)', off.status === 4,
    `status ${off.status}; stderr: ${String(off.stderr).slice(-300)}`);
  check('fallback off: prints no JSON result', !String(off.stdout).includes('{'));
  check('fallback off: says why, naming the flag',
    /SEG_ALLOW_PYTHON_FALLBACK/.test(off.stderr), String(off.stderr).slice(-300));

  const on = spawnSync(pyExe, [script, image],
    { env: { ...env, SEG_ALLOW_PYTHON_FALLBACK: '1' }, encoding: 'utf8', timeout: 300_000 });
  let out = null;
  try { out = JSON.parse(on.stdout.slice(on.stdout.indexOf('{'))); } catch { /* checked below */ }
  check('fallback on: succeeds', on.status === 0 && out !== null,
    `status ${on.status}; stderr: ${String(on.stderr).slice(-300)}`);
  if (!out) return;
  const e = out.engines || {};
  check('fallback on: vessel/localization/hardExudate are python with fallback: true',
    ['vessel', 'localization', 'hardExudate'].every((k) => e[k] && e[k].engine === 'python'
      && e[k].fallback === true), JSON.stringify(e));
  check('fallback on: the detail says MATLAB failed',
    /MATLAB failed/.test((e.vessel || {}).detail || ''), (e.vessel || {}).detail);
  check('red lesion is python and NOT a fallback (never MATLAB-served)',
    e.redLesion && e.redLesion.engine === 'python' && e.redLesion.fallback === false,
    JSON.stringify(e.redLesion));
  check('the orchestrator stores it as reported',
    orchestrator.buildEngineProvenance({ inferenceBackend: 'matlab', segResult: out,
      casePipelineVia: 'session' }).segmentation.vessel.fallback === true);
}

async function checkHealth() {
  const app = require(path.join(CENTRAL, 'server'));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/health`;
  try {
    const t0 = Date.now();
    const res = await fetch(url);
    const ms = Date.now() - t0;
    const body = await res.json();
    check('200 with status "ok" (what PHC sync and mobile key off)',
      res.status === 200 && body.status === 'ok', JSON.stringify(body).slice(0, 200));
    const c = body.components || {};
    check('reports db, queue, matlabSession and python separately',
      ['db', 'queue', 'matlabSession', 'python'].every((k) => c[k] && typeof c[k].status === 'string'),
      JSON.stringify(Object.keys(c)));
    check('db is ok against this checkout\'s database', c.db && c.db.status === 'ok', JSON.stringify(c.db));
    check('queue carries its counters', c.queue && Number.isInteger(c.queue.queued)
      && Number.isInteger(c.queue.inflight));
    check('matlab session: supervisor status plus a live heartbeat reading',
      c.matlabSession && typeof c.matlabSession.heartbeatFresh === 'boolean'
        && has(c.matlabSession, 'lastHeartbeatAt'));
    check('python: never blocks the heartbeat (probe is cached, first answer may be "unknown")',
      c.python && ['ok', 'unknown', 'unavailable'].includes(c.python.status));
    check('answers fast enough to stay a heartbeat (< 2 s)', ms < 2000, `${ms} ms`);

    // The cached probe, once it has run.
    await require(path.join(CENTRAL, 'services', 'healthCheck')).probePython();
    const again = await (await fetch(url)).json();
    const p = again.components.python;
    check('python probe settles to ok or unavailable, with a reason when unavailable',
      p.status === 'ok' || (p.status === 'unavailable' && !!p.error), JSON.stringify(p).slice(0, 300));
    check('python reports its version when it runs', p.status !== 'ok' || /^\d+\.\d+/.test(p.version || ''));
  } finally {
    server.close();
    await require(path.join(CENTRAL, 'db', 'pgClient')).end().catch(() => {});
  }
}

/** An IDRiD fixture (public dataset only -- CLAUDE.md). */
function firstFixture() {
  const candidates = [
    process.env.VERIFY_FIXTURE_IMAGE,
    path.join(CENTRAL, 'ml-pipeline', 'datasets', 'idrid', 'grading', 'B. Disease Grading',
      '1. Original Images', 'b. Testing Set', 'IDRiD_001.jpg'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** Stand in for the segmentation worker for exactly one request. */
function serveOnce(body) {
  const requestDir = path.join(segScratch, 'requests');
  const responseDir = path.join(segScratch, 'responses');
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const pending = fs.existsSync(requestDir)
        ? fs.readdirSync(requestDir).filter((f) => f.endsWith('.json')) : [];
      if (pending.length) {
        clearInterval(poll);
        const reqPath = path.join(requestDir, pending[0]);
        const responsePath = path.join(responseDir, pending[0]);
        fs.mkdirSync(responseDir, { recursive: true });
        fs.writeFileSync(`${responsePath}.tmp`, JSON.stringify(body));
        fs.renameSync(`${responsePath}.tmp`, responsePath);
        fs.unlinkSync(reqPath);
        return resolve();
      }
      if (Date.now() - startedAt > 4_000) { clearInterval(poll); reject(new Error('no request appeared')); }
    }, 10);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
