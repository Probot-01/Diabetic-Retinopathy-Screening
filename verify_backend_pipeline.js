#!/usr/bin/env node
'use strict';

/**
 * verify_backend_pipeline.js
 *
 * The per-case MATLAB round trip: the input the orchestrator builds for
 * runCasePipeline.m, and the session protocol that carries it.
 *
 * Both used to be one generated line of MATLAB source, checked only by whether
 * a real case came out the far end. They are now data and a transport, and both
 * have contracts worth asserting directly:
 *
 *   - "not measured" must stay distinguishable from "measured as zero/false",
 *     end to end. This is the §H/§I safety property: a detector signal that was
 *     never run must reach the rule engine as ABSENT, so the evidence text says
 *     the criterion was not assessed instead of quietly claiming it passed.
 *   - a request the Node side has given up on must not be left lying in the
 *     request directory, where a slow session picks it up later and runs work
 *     nobody is waiting for.
 *
 * No MATLAB and no database: this runs anywhere, in about a second.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CENTRAL = path.join(__dirname, 'central-system', 'backend');

// Point the session client at a scratch heartbeat BEFORE requiring it: a real
// session on this machine rewrites the live one every 5 s, which would make
// "no session is running" impossible to test here.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-pipeline-'));
process.env.MATLAB_HEARTBEAT_PATH = path.join(scratch, 'session.heartbeat');
// And at a scratch request directory, or the live session would answer these
// requests for real rather than letting the test drive both ends.
process.env.MATLAB_SESSION_DIR = scratch;
const segScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-seg-'));
process.env.SEG_SESSION_DIR = segScratch;
process.env.SEG_HEARTBEAT_PATH = path.join(segScratch, 'worker.heartbeat');

const orchestrator  = require(path.join(CENTRAL, 'services', 'gradingOrchestrator'));
const matlabSession = require(path.join(CENTRAL, 'services', 'matlabSessionClient'));
const segSession    = require(path.join(CENTRAL, 'services', 'segSessionClient'));
const { buildCasePipelineInput, caseRuleOpts } = orchestrator;

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${detail}`); }
}

const FULL_SEG = {
  redPerQuadrant: [3, 7, 2, 5],
  brightPerQuadrant: [1, 0, 4, 2],
  opticDisc: { x: 760, y: 430 },
  masks: {
    vessel: 'C:\\media\\cases\\x\\original_vessel.png',
    lesion384: 'C:\\media\\cases\\x\\original_lesion384.png',
    roi384: 'C:\\media\\cases\\x\\original_roi384.png',
  },
  venousBeadingQuadrants: [true, false, true, false],
  irmaQuadrants: [false, false, false, false],
  foveaUnreliable: true,
};

async function main() {
  console.log('\n--- The case-pipeline input: what MATLAB is asked to do ---');
  const full = buildCasePipelineInput('C:\\media\\cases\\x\\original.jpg',
    'forus_3nethra_v2', 'case-1', FULL_SEG, 2, [[0, 1], [1, 0]]);

  check('every path crosses as forward slashes',
    [full.imagePath, full.vesselPath, full.lesion384Path, full.roi384Path]
      .every((p) => !p.includes('\\')),
    JSON.stringify([full.imagePath, full.vesselPath]));
  check('quadrant counts pass through unchanged',
    JSON.stringify(full.redQ) === '[3,7,2,5]' && JSON.stringify(full.brightQ) === '[1,0,4,2]');
  check('the optic disc becomes [x, y]', JSON.stringify(full.odXY) === '[760,430]');
  check('the Grad-CAM stays a matrix', JSON.stringify(full.camMap) === '[[0,1],[1,0]]');
  check('the whole input is JSON-serialisable, no Buffers or dates',
    JSON.stringify(JSON.parse(JSON.stringify(full))) === JSON.stringify(full));

  console.log('\n--- Segmentation did not run: refuse, do not invent ---');
  const bare = buildCasePipelineInput('C:\\x.jpg', '', 'case-2', null, null, null);
  check('redQ and brightQ are null, NOT [0,0,0,0]',
    bare.redQ === null && bare.brightQ === null,
    JSON.stringify([bare.redQ, bare.brightQ]));
  check('the optic disc is null, not [0,0]', bare.odXY === null);
  check('the Grad-CAM is null, not a zero matrix', bare.camMap === null);
  check('branchAGrade is null, not 0', bare.branchAGrade === null);
  check('mask paths are empty strings, which isfile() rejects',
    bare.vesselPath === '' && bare.lesion384Path === '' && bare.roi384Path === '');

  // A grade of 0 is a real result -- "no DR" -- and must survive as 0.
  const zero = buildCasePipelineInput('C:\\x.jpg', '', 'case-3',
    { redPerQuadrant: [0, 0, 0, 0], brightPerQuadrant: [0, 0, 0, 0] }, 0, null);
  check('a grade of 0 survives as 0, not as null', zero.branchAGrade === 0);
  check('all-zero counts survive as counts, not as absence',
    JSON.stringify(zero.redQ) === '[0,0,0,0]');

  console.log('\n--- §H/§I: a detector signal is sent ONLY when measured ---');
  check('nothing measured -> no keys at all, so nothing is "assessed"',
    JSON.stringify(caseRuleOpts(null)) === '{}');
  check('an all-false measurement IS sent (assessed, and negative)',
    JSON.stringify(caseRuleOpts({ irmaQuadrants: [false, false, false, false] }))
      === '{"irmaQuadrants":[false,false,false,false]}');
  check('a malformed array is dropped rather than half-trusted',
    JSON.stringify(caseRuleOpts({ irmaQuadrants: [true, false, true] })) === '{}');
  check('0/1 integers are accepted as the booleans they are',
    JSON.stringify(caseRuleOpts({ venousBeadingQuadrants: [1, 0, 1, 0] }))
      === '{"venousBeadingQuadrants":[true,false,true,false]}');
  check('foveaUnreliable is sent only when TRUE',
    JSON.stringify(caseRuleOpts({ foveaUnreliable: false })) === '{}'
      && caseRuleOpts({ foveaUnreliable: true }).foveaUnreliable === true);
  check('a non-boolean foveaUnreliable does not read as "reliable" or as true',
    JSON.stringify(caseRuleOpts({ foveaUnreliable: 'yes' })) === '{}');
  check('the full case carries exactly the two measured signals',
    JSON.stringify(full.ruleOpts)
      === '{"venousBeadingQuadrants":[true,false,true,false],'
        + '"irmaQuadrants":[false,false,false,false],"foveaUnreliable":true}',
    JSON.stringify(full.ruleOpts));

  // ── Thresholds must travel with the counts, all the way into MATLAB ──────
  // The rule engine's thresholds belong to the red-lesion model that produced
  // the counts: v2 finds ~2.6x more lesions than v1, and v2 counts scored
  // against v1 thresholds give referable specificity 0.231 instead of 0.872.
  // So caseRuleOpts attaches the matching set, and BOTH engines must receive
  // it -- the JS fallback passes ruleOpts straight through, while the MATLAB
  // side re-validates it in runCasePipeline.m's reqRuleOpts, whose whitelist
  // silently dropped these fields when they were first added.
  console.log('\n--- Rule thresholds follow the red-lesion model version ---');
  const v2opts = caseRuleOpts({ redLesionModelVersion: 'v2' });
  const v1opts = caseRuleOpts({ redLesionModelVersion: 'v1' });
  check('v2 counts carry the v2 thresholds',
    v2opts.redFloor === 9 && v2opts.grade3QuadMin === 4
      && v2opts.moderateRedCount === 11 && v2opts.brightFloor === 7,
    JSON.stringify(v2opts));
  check('v1 counts still carry the v1 thresholds',
    v1opts.redFloor === 3 && v1opts.grade3QuadMin === 3,
    JSON.stringify(v1opts));
  check('an unknown version supplies none, leaving the documented defaults',
    JSON.stringify(caseRuleOpts({ redLesionModelVersion: 'v9' })) === '{}');
  check('a result with no version at all supplies none',
    JSON.stringify(caseRuleOpts({})) === '{}');
  check('the thresholds reach the MATLAB request, not just the JS side',
    (() => {
      const inp = buildCasePipelineInput('C:\\x.jpg', '', 'case-thr',
        { redPerQuadrant: [1, 2, 3, 4], redLesionModelVersion: 'v2' }, null, null);
      return inp.ruleOpts && inp.ruleOpts.grade3QuadMin === 4
        && inp.ruleOpts.redFloor === 9;
    })());

  // ── Model/capture provenance: every field a producer emits has a consumer ──
  // These three were all "produced and dropped": the model that graded a case
  // (hardcoded to branchA_v1 while branchA.modelVersion went unread), and the
  // capture's own source format and DICOM device, which BOTH engines returned
  // on every case and nothing stored -- while readFundusImage.m's header said
  // the device "is recorded as evidence".
  // ── Urgency score: the constraints that keep it safe ────────────────────
  // The score comes from a forest trained on SYNTHETIC data. Two properties
  // must hold or it stops being a queue hint and becomes a fabricated
  // clinical statement: a missing input yields NO score (never 1, which is a
  // real low-urgency value and would be indistinguishable), and a bucket
  // midpoint is never presented as a measured lab value.
  console.log('\n--- Urgency score: missing data, and provenance ---');
  const { caseClinicalInputs } = orchestrator;

  check('complete clinical data produces a clinical block',
    (() => {
      const c = caseClinicalInputs(58, { riskFactors: { hba1c: 8.2, yearsDiabetic: 6 } });
      return c && c.hba1c === 8.2 && c.yearsDiabetic === 6
        && c.provenance.hba1c === 'measured';
    })());
  check('a missing HbA1c yields NO clinical block, so no score is computed',
    caseClinicalInputs(58, { riskFactors: { yearsDiabetic: 6 } }) === null);
  check('a missing years-diabetic yields no block either',
    caseClinicalInputs(58, { riskFactors: { hba1c: 8.2 } }) === null);
  check('a missing patient age yields no block',
    caseClinicalInputs(null, { riskFactors: { hba1c: 8.2, yearsDiabetic: 6 } }) === null);
  check('an empty questionnaire yields no block',
    caseClinicalInputs(58, {}) === null);

  // Buckets may stand in, but the substitution must be VISIBLE -- a screen has
  // to be able to say "assumed from 'poor'" rather than implying a lab test.
  check('a bucket is used but labelled assumed, never as measured',
    (() => {
      const c = caseClinicalInputs(58, {
        riskFactors: { glycemicControl: 'poor', yearsSinceDiagnosis: '1to5' },
      });
      return c && c.hba1c === 9.5
        && /assumed/.test(c.provenance.hba1c)
        && /poor/.test(c.provenance.hba1c)
        && /assumed/.test(c.provenance.yearsDiabetic);
    })());
  check('an unrecognised bucket is not guessed at',
    caseClinicalInputs(58, { riskFactors: { glycemicControl: 'somethingelse' } }) === null);

  console.log('\n--- Capture and model provenance ---');
  const fb = require('./central-system/backend/services/matlabFallback');

  check('the JS fallback reports the same sourceFormat vocabulary as MATLAB',
    (() => {
      const r = fb.runMatlabFallback({ imagePath: 'C:\\x\\shot.JPG', segResult: null });
      // readFundusImage.m: 'image' for non-DICOM, 'dicom' only when parsed.
      return r.sourceFormat === 'image';
    })());
  check('  ...and never claims DICOM, which it cannot read',
    (() => {
      const r = fb.runMatlabFallback({ imagePath: 'C:\\x\\scan.dcm', segResult: null });
      return r.sourceFormat !== 'dicom';
    })());
  check('the fallback reports no DICOM device rather than a blank one',
    fb.runMatlabFallback({ imagePath: 'C:\\x\\a.jpg', segResult: null })
      .dicomDeviceModel === null);

  console.log('\n--- The session protocol ---');
  check('no heartbeat file means no session', matlabSession.alive() === false);
  fs.writeFileSync(process.env.MATLAB_HEARTBEAT_PATH, 'now');
  check('a fresh heartbeat means a session', matlabSession.alive() === true);
  const old = Date.now() - 120_000;
  fs.utimesSync(process.env.MATLAB_HEARTBEAT_PATH, old / 1000, old / 1000);
  check('a stale heartbeat means a wedged session, not a live one',
    matlabSession.alive() === false);

  // A session that answers.
  const answered = matlabSession.call({ casePipeline: 'C:/in.json' },
    { timeoutMs: 5_000, prefix: 't' });
  const served = await serveOnce({ ruleEngineGrade: 2, nvSuspicionScore: null });
  check('the request names what it wants done',
    served.request.casePipeline === 'C:/in.json', JSON.stringify(served.request));
  const body = await answered;
  check('the response comes back parsed', body.ruleEngineGrade === 2);
  check('the response file is cleaned up',
    !fs.existsSync(served.responsePath));

  // A session that reports a failure.
  const failing = matlabSession.call({ casePipeline: 'C:/in.json' },
    { timeoutMs: 5_000, prefix: 't' });
  await serveOnce({ error: 'Unrecognized function or variable "runCasePipeline".' });
  let message = null;
  try { await failing; } catch (err) { message = err.message; }
  check('a MATLAB error surfaces as MATLAB wrote it',
    message === 'Unrecognized function or variable "runCasePipeline".', message);

  // A session that never answers.
  let timedOut = null;
  try {
    await matlabSession.call({ casePipeline: 'C:/in.json' }, { timeoutMs: 300, prefix: 't' });
  } catch (err) { timedOut = err; }
  check('a silent session times out', timedOut !== null && timedOut.code === 'matlab_session_timeout');
  check('the timeout says how to start the session',
    timedOut && timedOut.message.includes('manageMatlabSession.ps1'));
  // The defect this guards: left behind, the request is picked up minutes later
  // by a session that has just restarted, which then runs a case nobody is
  // waiting for and leaves an orphan response file next to it.
  // PRECONDITION: no live session. This assertion is about the CLIENT taking
  // its request back, and a running session polls the same directory -- it
  // will pick the request up, answer it and delete the file itself, racing the
  // client's cleanup. The check then fails for a reason that has nothing to do
  // with the defect it guards, which is exactly what happened once here.
  // Reported as skipped rather than failed, so a red line always means the
  // client actually left something behind.
  if (matlabSession.alive()) {
    console.log('  SKIP  a timed-out request is TAKEN BACK '
      + '-- a live MATLAB session is polling the same directory and races '
      + 'this check; stop it (manageMatlabSession.ps1 stop) to run it');
  } else {
    check('a timed-out request is TAKEN BACK, not left for a late session',
      fs.readdirSync(matlabSession.REQUEST_DIR).filter((f) => f.startsWith('t_')).length === 0,
      fs.readdirSync(matlabSession.REQUEST_DIR).join(', '));
  }

  console.log('\n--- Branch B: the worker, and what happens without it ---');
  // Losing the segmentation worker must never lose a case. Branch B is the
  // SECOND opinion: a case graded by the classifier alone, with
  // branch_agreement NULL, is a degraded result the tier logic already
  // handles. A thrown error would turn that into a lost case.
  check('no worker means no worker', segSession.alive() === false);

  const { segment } = orchestrator;
  fs.writeFileSync(process.env.SEG_HEARTBEAT_PATH, 'now');
  check('a fresh heartbeat means the worker is preferred', segSession.alive() === true);

  const counts = { redPerQuadrant: [3, 7, 2, 5], brightPerQuadrant: [1, 0, 4, 2] };
  const viaWorker = segment('C:/no/such/image.jpg', '');
  const segServed = await serveOnce(counts, segSession.REQUEST_DIR, segSession.RESPONSE_DIR, 'seg_');
  check('the worker is asked for the image the case names',
    segServed.request.image === 'C:/no/such/image.jpg', JSON.stringify(segServed.request));
  const segBody = await viaWorker;
  check('the worker result is what Branch B grades',
    JSON.stringify(segBody && segBody.redPerQuadrant) === '[3,7,2,5]',
    JSON.stringify(segBody));

  // The worker fails on this image. The orchestrator must fall back to a fresh
  // segInfer.py, which on a path that does not exist fails too -- and the whole
  // thing must still resolve NULL rather than throw.
  const bothFail = segment('C:/no/such/image.jpg', '');
  await serveOnce({ error: 'FileNotFoundError: no file at C:/no/such/image.jpg' },
    segSession.REQUEST_DIR, segSession.RESPONSE_DIR, 'seg_');
  let threw = null;
  let result = 'not-resolved';
  try { result = await bothFail; } catch (err) { threw = err; }
  check('a failure on both paths resolves NULL, it does not throw',
    threw === null && result === null, threw ? threw.message : String(result));

  // ── lesionCounts: the stored shape vs the contract shape ────────────────
  // The clinical key names are an API-boundary mapping, not a second copy of
  // the measurement. What matters here is that nothing invents a number: a
  // detector that does not exist must surface as null, and null must survive
  // JSON.stringify as a PRESENT key.
  console.log('\n--- lesionCounts: clinical names, no invented numbers ---');
  const { toContractShape } = require(path.join(CENTRAL, 'services', 'lesionCounts'));

  const storedToday = {
    red: [43, 15, 82, 56], bright: [53, 7, 28, 12],
    redTotal: 196, brightTotal: 100, minAreaPx: 10, procedure: 'prob > 0.5 ...',
  };
  const mapped = toContractShape(storedToday);
  check('hardExudates is the bright-lesion count', mapped.hardExudates === 100, mapped.hardExudates);
  check('microaneurysms and hemorrhages are null while M5 is 2-class',
    mapped.microaneurysms === null && mapped.hemorrhages === null,
    JSON.stringify(mapped));
  check('softExudates is null, never 0 (disclosed exclusion)',
    mapped.softExudates === null, JSON.stringify(mapped.softExudates));
  check('all four keys survive JSON.stringify as present keys',
    ['microaneurysms', 'hemorrhages', 'hardExudates', 'softExudates']
      .every((k) => k in JSON.parse(JSON.stringify(mapped))));
  check('the red total is still reported, under detail',
    mapped.detail.redTotal === 196 && mapped.detail.redPerQuadrant.length === 4);
  check('no segmentation -> null, not an object of four nulls',
    toContractShape(null) === null && toContractShape(undefined) === null);
  const withM5 = toContractShape({ ...storedToday, ma: [10, 5, 2, 1], he: [3, 1, 0, 0] });
  check('M5\'s 3-class output fills the two null keys without a code change',
    withM5.microaneurysms === 18 && withM5.hemorrhages === 4,
    JSON.stringify(withM5));

  // ── Tier floors: the one path a real case could not reach ───────────────
  // A floor only acts on a Tier A case, which needs high confidence AND
  // agreeing branches AND a flag raised. No image in the corpus is all three
  // at once, so grading real images proved the flags REACH the decision and
  // never proved the floors DO anything. decideTier is pure, so here they are.
  console.log('\n--- Tier floors raise A, and never lower B or C ---');
  const { decideTier } = orchestrator;
  const agreeing = { branchAgreement: true, confidenceScore: 0.97 };

  check('a clean high-confidence case stays Tier A',
    decideTier({ ...agreeing, conformalTier: 'A' }).tier === 'A');

  for (const [flag, label] of [
    ['foveaUnreliable', 'an unreliable fovea'],
    ['lateralityMismatch', 'an eye-laterality mismatch'],
    ['cameraProbationOverride', 'a camera on probation'],
    ['cameraNotValidated', 'an unvalidated camera'],
  ]) {
    const r = decideTier({ ...agreeing, conformalTier: 'A', [flag]: true });
    check(`${label} floors Tier A to B`, r.tier === 'B', JSON.stringify(r));
    check(`  ...and the reason says why, not "conformal prediction set"`,
      !/conformal prediction set/.test(r.tierReason), r.tierReason);

    // The regression this whole shape exists to prevent: these were once
    // `tier = 'B'` INSIDE the chain, so a Tier C case came out as B and the
    // floor cut the review requirement instead of raising it.
    check(`  ...and a Tier C case with ${label} STAYS C`,
      decideTier({ ...agreeing, conformalTier: 'C', [flag]: true }).tier === 'C');
    check(`  ...and a Tier B case with ${label} stays B`,
      decideTier({ ...agreeing, conformalTier: 'B', [flag]: true }).tier === 'B');
  }

  check('fovea null does NOT floor -- only a real true does',
    decideTier({ ...agreeing, conformalTier: 'A', foveaUnreliable: null }).tier === 'A');

  // ── unvalidated_camera: the config layer behind the floor above ──────────
  // The floor is only as good as the answer it is given, and the question
  // "is this camera validated here?" has exactly one dangerous wrong answer:
  // saying yes when nobody checked. These assert it fails closed.
  console.log('\n--- unvalidated_camera: the validated-camera list ---');
  const vc = require('./central-system/backend/services/validatedCameras');

  check('a listed camera is validated',
    vc.isValidatedCamera('phc-anything', 'topcon_trc_nw400') === true);
  check('an unlisted camera is NOT validated',
    vc.isValidatedCamera('phc-1', 'some_unlisted_device') === false);
  check('a camera reported as literally "unknown" is NOT validated',
    vc.isValidatedCamera('phc-1', 'unknown') === false);

  // The hole this whole task existed to close: camera/site probation treats a
  // missing id as CLEARED (a blank field is a data-completeness problem, not
  // evidence of a strange camera). For THIS check that is backwards -- an
  // unidentified camera is the one we know least about.
  check('a MISSING camera id does not auto-clear',
    vc.cameraNotValidated('phc-1', null) === true
      && vc.cameraNotValidated('phc-1', '') === true
      && vc.cameraNotValidated('phc-1', '   ') === true);

  check('matching ignores case and surrounding whitespace',
    vc.isValidatedCamera('phc-1', '  Topcon_TRC_NW400 ') === true);

  // End to end: the config answer actually reaches the tier.
  check('an unlisted camera floors a Tier A case to B, with its own reason',
    (() => {
      const r = decideTier({ ...agreeing, conformalTier: 'A',
        cameraNotValidated: vc.cameraNotValidated('phc-1', 'never_validated_cam') });
      return r.tier === 'B' && /unvalidated_camera/.test(r.tierReason);
    })());
  check('a listed camera does not floor',
    decideTier({ ...agreeing, conformalTier: 'A',
      cameraNotValidated: vc.cameraNotValidated('phc-1', 'topcon_trc_nw400') }).tier === 'A');

  // Escalation still beats everything, and disagreement is checked first.
  check('branch disagreement is Tier C whatever the conformal set said',
    decideTier({ branchAgreement: false, conformalTier: 'A', confidenceScore: 0.99 }).tier === 'C');
  check('a CNN grade above the rule ceiling is Tier C',
    decideTier({ ...agreeing, beyondRuleEngine: true, grade: 4, ruleMaxGrade: 3,
      conformalTier: 'A' }).tier === 'C');
  check('a quality-forced case is Tier C',
    decideTier({ ...agreeing, qualityForced: true, conformalTier: 'A' }).tier === 'C');
  check('with no conformal tier it falls back to the confidence thresholds',
    decideTier({ ...agreeing, confidenceScore: 0.5 }).tier === 'C'
      && decideTier({ ...agreeing, confidenceScore: 0.95 }).tier === 'A');

  console.log(failures === 0
    ? '\n===== The per-case MATLAB round trip is verified ====='
    : `\n===== ${failures} FAILURE(S) =====`);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(segScratch, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Stand in for the MATLAB session for exactly one request: wait for a request
 * file to appear, read it, and write the given body back under the matching id.
 */
function serveOnce(body, requestDir = matlabSession.REQUEST_DIR,
                  responseDir = matlabSession.RESPONSE_DIR, prefix = 't_') {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const pending = fs.existsSync(requestDir)
        ? fs.readdirSync(requestDir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
        : [];
      if (pending.length) {
        clearInterval(poll);
        const reqPath = path.join(requestDir, pending[0]);
        const request = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
        const responsePath = path.join(responseDir, pending[0]);
        fs.writeFileSync(`${responsePath}.tmp`, JSON.stringify(body));
        fs.renameSync(`${responsePath}.tmp`, responsePath);
        fs.unlinkSync(reqPath);
        return resolve({ request, responsePath });
      }
      if (Date.now() - startedAt > 4_000) {
        clearInterval(poll);
        reject(new Error('no request appeared'));
      }
    }, 10);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
