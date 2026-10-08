'use strict';

/**
 * matlabFallback.js
 *
 * Pure-JS re-implementation of the parts of the MATLAB grading round-trip
 * (gradingOrchestrator.js's buildMatlabExpr) that are plain logic rather than
 * image processing, used ONLY when MATLAB cannot be spawned at all on this
 * machine (no license, no disk space to install it — see the ticket this was
 * written for).
 *
 * Ported faithfully from:
 *   ml-pipeline/grading/ruleEngineGrade.m   -> ruleEngineGrade()
 *   ml-pipeline/grading/branchesAgree.m     -> branchesAgree()
 *   ml-pipeline/explainability/generateEvidenceReport.m -> evidenceSummaryText()
 *     (text-generation half only — the annotated-PNG half needs lesion
 *     coordinates/opticDisc/fovea that the orchestrator never actually passes
 *     it today, so the real MATLAB path also always returns reportPath: ''
 *     for every case currently graded; nothing is lost by not porting it.)
 *
 * NOT ported, deliberately left as the contract's documented "not measured"
 * state, same as the real pipeline would report if that stage failed:
 *   - classifyCameraFamily: needs vignette/colour-ratio pixel analysis against
 *     calibrationProfiles.json. It only ever produces a human-facing WARNING
 *     log (a possible reported-vs-detected camera mismatch) and never affects
 *     grading (see gradingOrchestrator.js's comment on Task 6.3), so this
 *     falls back to 'unknown' / no mismatch — the same as the real function's
 *     own "nothing matched" outcome.
 *   - lesionAttentionConsistency: needs an upsampled Grad-CAM compared against
 *     a lesion mask. Stays null — exactly what the contract already requires
 *     for "this was not measured" (api-contracts.md, lesionAttentionConsistencyScore).
 *   - DICOM metadata (sourceFormat / dicomDeviceModel / imageLaterality):
 *     readFundusImage.m's DICOM tag reading. Ordinary JPEG/PNG captures (which
 *     is everything this demo submits) have no DICOM tags anyway, so this
 *     reports the format from the file extension and leaves the rest null,
 *     matching what readFundusImage.m itself reports for a non-DICOM file.
 */

const path = require('path');

// ── ruleEngineGrade.m ─────────────────────────────────────────────────────
const DEFAULTS = {
  redFloor: 3,
  grade3QuadMin: 3,
  moderateRedCount: 5,
  brightFloor: 1,
  maxGrade: 3,
  nvThreshold: 0.6,
};

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

/**
 * quadrantFlags(opts, name) -> { count, assessed }. Mirrors the MATLAB helper
 * of the same name: a 4-element boolean/0-1 array counts the flagged
 * quadrants, a non-negative integer is accepted as an already-counted value
 * (the original interface), and absent/empty means NOT ASSESSED with count 0.
 *
 * "Not assessed" and "assessed, found nothing" both score 0 and must stay
 * distinguishable — only the second one drops the caveat from the evidence.
 */
function quadrantFlags(opts, name) {
  const v = opts[name];
  if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) {
    return { count: 0, assessed: false };
  }
  if (Array.isArray(v) && v.length === 4
      && v.every((q) => q === true || q === false || q === 0 || q === 1)) {
    return { count: v.filter(Boolean).length, assessed: true };
  }
  if (Number.isInteger(v) && v >= 0) return { count: v, assessed: true };
  throw new Error(`ruleEngineGrade: ${name} must be a 4-element boolean array `
    + '(one per quadrant) or a quadrant count.');
}

function joinNotes(parts) {
  return parts.filter((p) => p).join(' ');
}

/**
 * The fovea caveat. Mirrors foveaNote() in ruleEngineGrade.m: segInfer does
 * NOT fall back to the image axes when the gate fires (Tanuj, 2026-09-20) —
 * the counts stay keyed to an axis drawn through a fovea already flagged as
 * untrustworthy, which is why the quadrant-dependent criteria are dropped
 * rather than recomputed.
 */
function foveaNote(cfg) {
  if (!cfg.foveaUnreliable) return '';
  return 'Fovea could not be located reliably, so the quadrant assignment '
    + 'cannot be trusted and the quadrant-dependent criteria (a) '
    + 'all-four-quadrants and (b) venous beading were not applied.';
}

/** Names only the criteria actually not assessed, then appends foveaNote. */
function severeCriteriaNote(cfg) {
  const missing = [];
  if (!cfg.vbAssessed) missing.push('(b) venous beading');
  if (!cfg.irmaAssessed) missing.push('(c) IRMA');

  let note = '';
  if (missing.length === 2) {
    note = 'Severe-NPDR criteria (b) venous beading and (c) IRMA were NOT '
      + 'assessed — no detector exists. This grade may be an under-call.';
  } else if (missing.length === 1) {
    note = `Severe-NPDR criterion ${missing[0]} was NOT assessed. This grade `
      + 'may be an under-call.';
  }
  return joinNotes([note, foveaNote(cfg)]);
}
function provisionalNote(q) {
  return `The per-quadrant threshold of ${q} is PROVISIONAL: it was fitted `
    + 'on two grade-3 images and should be refitted when more labelled data exists.';
}
function brightFloorNote() {
  return 'The bright-lesion noise floor has never been measured, so a single '
    + 'spurious exudate can lift this case from grade 1 to referable.';
}

/**
 * ruleEngineGrade(red, bright, nvSuspicionScore, opts) -> { grade, evidence }
 *
 * red/bright: 1x4 arrays of integer counts. Mirrors ruleEngineGrade.m exactly,
 * including the grade-4 NV suspicion path and the maxGrade cap / isLowerBound
 * bookkeeping branchesAgree() depends on.
 */
function ruleEngineGrade(red, bright, nvSuspicionScore, opts = {}) {
  const vb = quadrantFlags(opts, 'venousBeadingQuadrants');
  const irma = quadrantFlags(opts, 'irmaQuadrants');
  const cfg = {
    ...DEFAULTS,
    ...opts,
    venousBeadingQuadrants: vb.count,
    irmaQuadrants: irma.count,
    vbAssessed: vb.assessed,
    irmaAssessed: irma.assessed,
    // §I: only a real `true` counts. Absent, null and MATLAB's [] all mean
    // "not reported", which must never read as "the fovea is reliable".
    foveaUnreliable: opts.foveaUnreliable === true,
  };

  if (!Array.isArray(red) || red.length !== 4 || !Array.isArray(bright) || bright.length !== 4) {
    throw new Error('ruleEngineGrade: red/bright must be 1x4 arrays');
  }

  const totalRed = sum(red);
  const totalBright = sum(bright);

  const evidence = {
    criterion: '', redTotal: totalRed, brightTotal: totalBright,
    redByQuadrant: red, brightByQuadrant: bright, nvSuspicionScore,
    venousBeadingAssessed: cfg.vbAssessed, irmaAssessed: cfg.irmaAssessed,
    venousBeadingQuadrantCount: cfg.venousBeadingQuadrants,
    irmaQuadrantCount: cfg.irmaQuadrants,
    foveaUnreliable: cfg.foveaUnreliable,
    redFloor: cfg.redFloor, grade3QuadMin: cfg.grade3QuadMin, limitation: '',
  };

  const redPresent = totalRed >= cfg.redFloor;
  const brightPresent = totalBright >= cfg.brightFloor;

  let rawGrade;

  if (nvSuspicionScore > cfg.nvThreshold) {
    rawGrade = 4;
    evidence.criterion = `NV suspicion ${nvSuspicionScore.toFixed(2)} exceeds `
      + `${cfg.nvThreshold.toFixed(2)} — possible proliferative pattern, urgent review`;
    evidence.limitation = 'NV suspicion is a vessel-irregularity signal, NOT a '
      + 'validated neovascularization detector.';
  } else if (!cfg.foveaUnreliable
             && red.some((v) => v >= cfg.grade3QuadMin)
             && red.every((v) => v >= cfg.grade3QuadMin)) {
    // (a) and (b) below are skipped when the fovea is unreliable: both turn on
    // WHICH quadrant a lesion sits in, and that mapping is untrustworthy. (c)
    // asks only "any quadrant", so a scrambled axis does not invalidate it.
    rawGrade = 3;
    evidence.criterion = `Severe NPDR, ETDRS 4-2-1(a) structure: >=${cfg.grade3QuadMin} `
      + `red lesions in all four quadrants [${red.join('  ')}]. The count is a `
      + 'recalibrated segmenter threshold, not the literature 20.';
    evidence.limitation = provisionalNote(cfg.grade3QuadMin);
  } else if (!cfg.foveaUnreliable && cfg.venousBeadingQuadrants >= 2) {
    rawGrade = 3;
    evidence.criterion = `ETDRS 4-2-1(b): venous beading in ${cfg.venousBeadingQuadrants} quadrants`;
    evidence.limitation = foveaNote(cfg);
  } else if (cfg.irmaQuadrants >= 1) {
    rawGrade = 3;
    evidence.criterion = `ETDRS 4-2-1(c): prominent IRMA in ${cfg.irmaQuadrants} quadrant(s)`;
    evidence.limitation = joinNotes([
      'IRMA is a classical vessel-irregularity heuristic, not a validated detector.',
      foveaNote(cfg)]);
  } else if (redPresent && (brightPresent || totalRed > cfg.moderateRedCount)) {
    rawGrade = 2;
    if (brightPresent) {
      evidence.criterion = `Moderate NPDR: ${totalRed} red lesion(s) with ${totalBright} bright lesion(s)`;
      evidence.limitation = `${severeCriteriaNote(cfg)} ${brightFloorNote()}`;
    } else {
      evidence.criterion = `Moderate NPDR: ${totalRed} red lesions (>${cfg.moderateRedCount}), no bright lesions`;
      evidence.limitation = severeCriteriaNote(cfg);
    }
  } else if (redPresent) {
    rawGrade = 1;
    evidence.criterion = `Mild NPDR: ${totalRed} red lesion(s) only`;
    evidence.limitation = severeCriteriaNote(cfg);
  } else {
    rawGrade = 0;
    if (totalRed > 0) {
      evidence.criterion = `No DR: ${totalRed} red detection(s), below the noise floor of `
        + `${cfg.redFloor}. Every grade-0 validation image produced 1-2 spurious `
        + 'detections, so counts this low are not evidence of disease.';
      evidence.limitation = severeCriteriaNote(cfg);
    } else if (brightPresent) {
      evidence.criterion = `No DR by ICDR criteria, but ${totalBright} bright lesion(s) `
        + 'found with no red lesions';
      evidence.limitation = 'Bright lesions without any red lesion do not map to a '
        + 'DR grade under ICDR. Likely a false positive or non-DR pathology — worth a human look.';
    } else {
      evidence.criterion = 'No DR: no lesions detected';
      evidence.limitation = severeCriteriaNote(cfg);
    }
  }

  evidence.maxGrade = cfg.maxGrade;
  evidence.cappedFrom = null;
  evidence.isLowerBound = rawGrade >= cfg.maxGrade;

  let grade;
  if (rawGrade > cfg.maxGrade) {
    evidence.cappedFrom = rawGrade;
    evidence.limitation = `${evidence.limitation} Rule-engine grade ${rawGrade} was `
      + `CAPPED to ${cfg.maxGrade}: the only path above ${cfg.maxGrade} is an `
      + 'unvalidated NV suspicion heuristic. Grade-4 detection is delegated to '
      + 'Branch A, and a branch disagreement forces mandatory human review.';
    grade = cfg.maxGrade;
  } else {
    grade = rawGrade;
  }

  return { grade, evidence };
}

// ── branchesAgree.m ────────────────────────────────────────────────────────
function isValidGrade(g) {
  return g !== null && g !== undefined && Number.isFinite(g) && g >= 0 && g <= 4 && Number.isInteger(g);
}

/**
 * branchesAgree(gradeA, gradeB, bIsLowerBound) -> boolean | null
 * Mirrors branchesAgree.m: null means "not comparable", never coerced to false.
 */
function branchesAgree(gradeA, gradeB, bIsLowerBound = false) {
  const aOk = isValidGrade(gradeA);
  const bOk = isValidGrade(gradeB);
  if (!aOk || !bOk) return null;

  if (bIsLowerBound) {
    // Rule engine reported ">= gradeB". Agreement can only be asserted when
    // Branch A is BELOW that bound (genuine disagreement); at or above it, the
    // bound neither confirms nor contradicts, so this stays "no opinion".
    return gradeA < gradeB ? false : null;
  }

  return gradeA === gradeB;
}

// ── generateEvidenceReport.m (text half) ──────────────────────────────────
const QUADRANT_NAMES = ['superior-temporal', 'superior-nasal', 'inferior-nasal', 'inferior-temporal'];

function quadrantBreakdown(counts) {
  const items = [];
  counts.forEach((c, i) => { if (c > 0) items.push(`${QUADRANT_NAMES[i]}: ${c}`); });
  return items.length ? `(${items.join(', ')})` : '';
}

function plural(word, n) { return n === 1 ? word : `${word}s`; }
function capitalise(s) { return s.length ? s[0].toUpperCase() + s.slice(1) : s; }

/**
 * evidenceSummaryText({redByQuadrant, brightByQuadrant, nvSuspicionScore}, ruleOpts)
 *
 * Same three-sentence template as generateEvidenceReport.m: findings, the
 * criterion that fired (Branch B's own words), then its limitation caveat.
 * When counts are absent, returns the exact "segmentation has not been run"
 * sentence the contract documents — matching the real MATLAB path's
 * behaviour when Tasks 4.2/4.3 have not produced counts.
 *
 * ── ruleOpts IS NOT OPTIONAL IN PRACTICE, AND OMITTING IT WAS A BUG ────────
 * This re-runs the rule engine to obtain the criterion and limitation text.
 * Run WITHOUT ruleOpts it is a different rule engine from the one that graded
 * the case: on a fovea-unreliable case the grade deliberately skips criteria
 * (a) all-four-quadrants and (b) venous beading, but this call would apply
 * them and print "Severe NPDR, ETDRS 4-2-1(a) structure: >=3 red lesions in
 * all four quadrants" — citing quadrant reasoning the system had just
 * declared untrustworthy, to justify a grade that never used it.
 *
 * generateEvidenceReport.m has always forwarded ruleOpts to its own
 * ruleEngineGrade call (runCasePipeline.m passes it explicitly). This side
 * did not, so the two paths produced different evidence prose for the same
 * image. verify_fallback_parity.js compared the rule engine's OUTPUT fields
 * and not this text, which is why 720 matching cases never surfaced it.
 */
function evidenceSummaryText(inputs, ruleOpts = {}) {
  const red = inputs?.redByQuadrant;
  const bright = inputs?.brightByQuadrant;
  const nvScoreRaw = inputs?.nvSuspicionScore;

  const haveCounts = Array.isArray(red) && red.length === 4
    && Array.isArray(bright) && bright.length === 4
    && red.every(Number.isFinite) && bright.every(Number.isFinite);

  if (!haveCounts) {
    return 'Lesion segmentation has not been run for this case, so no '
      + 'lesion-level evidence is available. The grade shown is from the image '
      + 'classifier alone and has not been cross-checked against ICDR lesion criteria.';
  }

  const nvScore = Number.isFinite(nvScoreRaw) ? nvScoreRaw : 0;
  const { evidence } = ruleEngineGrade(red, bright, nvScore, ruleOpts);

  const parts = [];
  const redTotal = sum(red);
  if (redTotal > 0) {
    parts.push(`${redTotal} ${plural('red lesion', redTotal)} ${quadrantBreakdown(red)}`.trim());
  }
  const brightTotal = sum(bright);
  if (brightTotal > 0) {
    parts.push(`${brightTotal} ${plural('bright lesion', brightTotal)} ${quadrantBreakdown(bright)}`.trim());
  }
  const findings = parts.length
    ? `${capitalise(parts.join(', '))}.`
    : 'No microaneurysms, haemorrhages or exudates detected.';

  let criterionSentence = evidence.criterion || 'No ICDR criterion for referable disease was met';
  criterionSentence = criterionSentence.trim();
  if (!criterionSentence.endsWith('.')) criterionSentence += '.';

  const sentences = [findings, criterionSentence];
  if (evidence.limitation) {
    let lim = evidence.limitation.trim();
    if (!lim.endsWith('.')) lim += '.';
    sentences.push(lim);
  }

  return sentences.join(' ');
}

// ── classifyCameraFamily.m (no-op stub — see file header) ─────────────────
// cameraExpectedFamily is '' because this stub never runs the cross-check.
// That is what makes the resulting cases.camera_mismatch NULL ("nobody
// looked") rather than false ("the camera was verified against its image"),
// which is the honest answer for a path that does no camera classification.
function classifyCameraFamily() {
  return { cameraFamily: 'unknown', cameraMismatch: false, cameraExpectedFamily: '' };
}

// ── readFundusImage.m metadata (non-DICOM path only) ───────────────────────
function readFundusImageMetaFallback(imagePath) {
  // ── SAME VOCABULARY AS readFundusImage.m, NOT THE FILE EXTENSION ─────────
  // This used to return the extension ('jpg', 'png', 'unknown'), while the
  // MATLAB path reports 'image' for anything non-DICOM and 'dicom' when it
  // actually parsed one. Both feed cases.source_format, so the column would
  // have held 'image' or 'jpg' for identical captures depending only on which
  // engine happened to run -- the same divergence class verify_fallback_parity
  // exists to catch, in a field it does not cover.
  //
  // Always 'image': this fallback has no DICOM reader at all (see the header),
  // so it must never claim 'dicom'. A .dcm capture reaching here fails earlier
  // on imread, which is the honest outcome.
  const ext = path.extname(imagePath).replace('.', '').toLowerCase() || 'unknown';
  return {
    sourceFormat: 'image',
    sourceFileExtension: ext,   // kept as detail; not the contract field
    dicomDeviceModel: null,
    imageLaterality: null,
  };
}

/**
 * runMatlabFallback({ imagePath, segResult, branchAGrade })
 *
 * Builds the same `mlResult` shape gradingOrchestrator.js expects back from
 * the MATLAB call (see buildMatlabExpr's `out.*` assignments), using this
 * module's JS ports instead of spawning MATLAB. segResult is Phase 4
 * segmentation's own Python output (segInfer.py) — unaffected by MATLAB being
 * absent, so Branch B genuinely runs on real segmentation counts here, not
 * placeholder data.
 */
function runMatlabFallback({ imagePath, segResult, branchAGrade, ruleOpts = {} }) {
  const meta = readFundusImageMetaFallback(imagePath);
  const cam = classifyCameraFamily();

  let ruleGrade = null;
  let branchAgreement = null;
  let ruleIsLowerBound = false;
  let ruleMaxGrade = null;
  let evidenceInputs = {};

  const redQ = segResult && segResult.redPerQuadrant;
  const brightQ = segResult && segResult.brightPerQuadrant;
  // ── NV SUSPICION IS REPORTED, NEVER GRADED ON ──────────────────────────
  // Held at 0 for the rule engine, mirroring runCasePipeline.m -- read the
  // long note there for the validation result that retired this signal
  // (AUC 0.286 / 0.379, at or below chance on both test sets).
  //
  // It matters that BOTH sides do this. The measured score is what the MATLAB
  // path once passed; if this path kept passing it, one image could get two
  // different grades depending only on whether MATLAB was installed -- the
  // exact divergence verify_fallback_parity.js exists to catch.
  const nvScoreMeasured = Number.isFinite(segResult && segResult.nvSuspicionScore)
    ? segResult.nvSuspicionScore : null;
  const nvScore = 0;

  if (Array.isArray(redQ) && redQ.length === 4 && Array.isArray(brightQ) && brightQ.length === 4) {
    // ruleOpts is caseRuleOpts(segResult) from the orchestrator -- the SAME
    // opts the MATLAB path gets (§H venous beading / IRMA, §I foveaUnreliable).
    // Without them this path graded a flagged-fovea case on quadrant criteria
    // the MATLAB path skips, so the two engines could return different grades
    // for one image depending only on whether MATLAB happened to be installed.
    const { grade, evidence } = ruleEngineGrade(redQ, brightQ, nvScore, ruleOpts);
    ruleGrade = grade;
    ruleIsLowerBound = evidence.isLowerBound;
    ruleMaxGrade = evidence.maxGrade;
    branchAgreement = branchesAgree(branchAGrade, ruleGrade, ruleIsLowerBound);
    evidenceInputs = { redByQuadrant: redQ, brightByQuadrant: brightQ, nvSuspicionScore: nvScore };
  }

  return {
    // ruleOpts, so the prose describes the SAME rule engine that produced the
    // grade above -- see evidenceSummaryText's header.
    evidenceSummaryText: evidenceSummaryText(evidenceInputs, ruleOpts),
    sourceFormat: meta.sourceFormat,
    dicomDeviceModel: meta.dicomDeviceModel,
    imageLaterality: meta.imageLaterality,
    cameraFamily: cam.cameraFamily,
    cameraMismatch: cam.cameraMismatch,
    cameraExpectedFamily: cam.cameraExpectedFamily,
    ruleEngineGrade: ruleGrade,
    branchAgreement,
    // The MEASURED score (null when it could not run), not the 0 the rule
    // engine was given. Mirrors runCasePipeline.m's out.nvSuspicionScore: the
    // signal stays visible and auditable, it just decides nothing. Reporting
    // the gated 0 here would store a fabricated measurement.
    nvSuspicionScore: nvScoreMeasured,
    ruleIsLowerBound,
    ruleMaxGrade,
    lesionAttentionConsistency: null,
  };
}

module.exports = {
  ruleEngineGrade, branchesAgree, evidenceSummaryText,
  classifyCameraFamily, runMatlabFallback,
};
