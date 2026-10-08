'use strict';

/**
 * matlabInterop.js -- the ONE place MATLAB-produced JSON is made JS-safe
 * (backend plan §Q).
 *
 * MATLAB has no null. Its "no value" is the empty array [], and jsonencode([])
 * emits JSON `[]`, not `null`. In JS that is an empty array: truthy, not
 * nullish, so `?? null` does not catch it, and node-postgres then writes it
 * as the Postgres array literal '{}' -- which fails outright on a boolean or
 * float column, and is silently stored as the text "{}" in a TEXT column.
 *
 * This has already caused three separate bugs here (ruleEngineGrade /
 * branchAgreement, then uncertaintyScore, then gradcamPath), each fixed at its
 * own call site. Instead of a fourth, every MATLAB response is normalised once,
 * at the boundary where it is parsed:
 *
 *   const body = fromMatlabDeep(JSON.parse(raw));
 *
 * Only EMPTY arrays become null. Non-empty arrays (quadrant counts, the
 * Grad-CAM matrix) and every scalar -- crucially 0 and false, which are real
 * results -- pass through untouched.
 */

/** [] -> null; undefined -> null; everything else unchanged. */
function fromMatlab(v) {
  if (Array.isArray(v) && v.length === 0) return null;
  return v ?? null;
}

/**
 * Recursively applies fromMatlab to every value in a parsed JSON tree.
 * Objects keep their keys; arrays keep their length unless empty (-> null).
 */
function fromMatlabDeep(v) {
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return v.map(fromMatlabDeep);
  }
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = fromMatlabDeep(val);
    return out;
  }
  return v === undefined ? null : v;
}

module.exports = { fromMatlab, fromMatlabDeep };
