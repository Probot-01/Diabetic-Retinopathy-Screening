'use strict';

/**
 * engineProvenance.js -- which engine produced each ML output of a case.
 *
 * Standing rule (CLAUDE.md): every case records which engine produced each ML
 * output -- matlab / python / js-fallback -- and no engine switch is silent.
 *
 * One entry per output: { engine, fallback, detail }
 *   engine    'matlab' | 'python' | 'js-fallback'; the quality gate may also
 *             be 'js-device' (mobile on-device gate)
 *   fallback  true only when the output came from a NON-primary engine because
 *             an explicit env flag allowed it (MATLAB_ALLOW_FALLBACK,
 *             SEG_ALLOW_PYTHON_FALLBACK, QUALITY_GATE_ALLOW_FALLBACK). Without
 *             the flag there is no fallback: the case fails or is retried.
 *   detail    free text for a human: which script or session, and why.
 *
 * An output nobody reported is null -- "not recorded" -- never guessed from
 * the current configuration. Provenance inferred after the fact is exactly
 * what this exists to replace.
 *
 * Stored in grading_results.engine_provenance and cases.quality_gate_engine
 * (migration 0019); served as engineProvenance on GET /api/v1/cases/:caseId.
 */

const ENGINES = new Set(['matlab', 'python', 'js-fallback']);
// The quality gate alone may also be 'js-device': the mobile app's on-device
// TypeScript port of qualityGateMain.m, which is that client's PRIMARY gate --
// not a fallback, so it is not 'js-fallback'. Never valid for a grading output.
const QUALITY_GATE_ENGINES = new Set([...ENGINES, 'js-device']);
const DETAIL_MAX = 300;

function engineEntry(engine, detail, fallback = false) {
  return { engine, fallback: !!fallback, detail: detail ?? null };
}

/**
 * A reported entry made safe to store and serve, or null when it is not one.
 * `allowed` is the engine set for that output (default: the grading outputs').
 */
function normaliseEngineEntry(e, allowed = ENGINES) {
  if (!e || typeof e !== 'object' || !allowed.has(e.engine)) return null;
  return engineEntry(e.engine,
    typeof e.detail === 'string' ? e.detail.slice(0, DETAIL_MAX) : null,
    e.fallback === true);
}

const SEGMENTATION_MODELS = ['vessel', 'localization', 'hardExudate', 'redLesion'];

/**
 * toContractShape(gradingProvenance, qualityGateEngine) -> engineProvenance
 *
 * The case-detail response field. Every key is always present; a value is
 * null when that output was not recorded (not graded yet, graded before
 * migration 0019, or segmentation did not run).
 */
function toContractShape(gradingProvenance, qualityGateEngine) {
  const g = gradingProvenance && typeof gradingProvenance === 'object' ? gradingProvenance : {};
  let segmentation = null;
  if (g.segmentation && typeof g.segmentation === 'object') {
    segmentation = {};
    for (const m of SEGMENTATION_MODELS) segmentation[m] = normaliseEngineEntry(g.segmentation[m]);
  }
  return {
    classifier:   normaliseEngineEntry(g.classifier),
    segmentation,
    ruleEngine:   normaliseEngineEntry(g.ruleEngine),
    qualityGate:  normaliseEngineEntry(qualityGateEngine, QUALITY_GATE_ENGINES),
  };
}

module.exports = {
  ENGINES, QUALITY_GATE_ENGINES, SEGMENTATION_MODELS, engineEntry, normaliseEngineEntry, toContractShape,
};
