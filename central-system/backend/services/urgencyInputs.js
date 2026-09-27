'use strict';

/**
 * urgencyInputs.js -- which of the urgency score's clinical inputs were
 * actually measured, and which were substituted.
 *
 * calculateUrgencyScore.m records, per input, where its value came from:
 *
 *   "provenance": {
 *     "patientAge":    "measured",
 *     "hba1c":         "assumed from glycemicControl='moderate'",
 *     "yearsDiabetic": "assumed from yearsSinceDiagnosis='lt1'"
 *   }
 *
 * An "assumed" value is a BUCKET MIDPOINT standing in for a number nobody
 * measured: the questionnaire asks for glycemic control as poor/moderate/good,
 * and the model needs an HbA1c, so 'moderate' becomes 7.5. That is a
 * reasonable thing for the model to do and an unreasonable thing to hide --
 * a score of 79 resting on two substituted values is a different claim from
 * the same 79 computed from three real ones, and on a queue row they looked
 * identical.
 *
 * Measured on real rows in this database: of the cases carrying an urgency
 * score, some have all three inputs measured and some have two of three
 * assumed, with no way for the reviewer to tell them apart.
 *
 * This is deliberately NOT a quality score or a confidence number. It returns
 * the NAMES, because "which input was substituted" is the thing a clinician
 * can reason about -- a stood-in HbA1c means something different from a
 * stood-in disease duration -- and a single blended number would destroy
 * exactly that.
 */

/** Inputs the model takes, in the order a reader should see them. */
const INPUT_ORDER = ['patientAge', 'yearsDiabetic', 'hba1c'];

/** Human labels; the keys are the engine's, and are not shown raw. */
const INPUT_LABELS = {
  patientAge: 'age',
  yearsDiabetic: 'years diabetic',
  hba1c: 'HbA1c',
};

/**
 * assumedInputs(urgencyInputs) -> string[] | null
 *
 * The input names that were SUBSTITUTED rather than measured, in reading
 * order. Returns:
 *   []     every input was measured
 *   [...]  these were assumed
 *   null   not known -- no urgency was computed, or the row predates the
 *          provenance being recorded. NOT the same as "all measured", which
 *          is why it is null and not [].
 */
function assumedInputs(urgencyInputs) {
  const p = urgencyInputs && typeof urgencyInputs === 'object' ? urgencyInputs.provenance : null;
  if (!p || typeof p !== 'object') return null;
  const out = [];
  for (const key of INPUT_ORDER) {
    const v = p[key];
    if (typeof v !== 'string') continue;
    // "measured" is the only value that means measured; anything else is a
    // substitution, and treating an unrecognised string as measured would be
    // the failure this module exists to prevent.
    if (v.trim().toLowerCase() !== 'measured') out.push(key);
  }
  return out;
}

/** assumedInputs() as a human phrase, e.g. "HbA1c and years diabetic". */
function assumedInputsText(names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const labels = names.map((n) => INPUT_LABELS[n] || n);
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

module.exports = { INPUT_ORDER, INPUT_LABELS, assumedInputs, assumedInputsText };
