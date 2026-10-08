import React from 'react';

/**
 * LesionAttentionMetric -- does the Grad-CAM look where the lesions are?
 *
 * Replaces a plain 0-1 bar, which could not show this honestly.
 * `lesionAttentionConsistency.m`'s own header is explicit about why:
 *
 *   "A RAW OVERLAP FRACTION IS NOT INTERPRETABLE. '70% of the attention is on
 *    lesions' sounds excellent and can be terrible. If lesions cover 70% of the
 *    retina, a heatmap of pure noise scores 0.70 too. The number only means
 *    something against its chance level... a UI showing '0.70' beside a green
 *    tick would be actively misleading."
 *
 * So this shows the comparison, not the fraction: what the attention scored,
 * what a RANDOM heatmap would have scored on this same eye, and the ratio
 * between them. The pass/fail comes from `lesionAttentionFlagged`, which the
 * backend computes next to the maths -- not from a threshold invented here.
 * The bar that used to sit in this slot coloured anything under 0.6 red, a
 * number with no basis: a perfectly good heatmap on an eye with few lesions
 * scores far below 0.6 and should not be red.
 *
 * Three distinct states, kept distinct:
 *   - not computed        the score is null AND nothing was flagged
 *   - undefined, flagged  no score, but flagged -- Grad-CAM produced no energy
 *                         at all, which is itself a reason to review
 *   - measured            score, chance level and enrichment all present
 *
 * A low result is a reason to REVIEW, never to change a grade: the lesion masks
 * are themselves model output with their own error rate, so a disagreement
 * between two imperfect models says a human should look, not which one is wrong.
 */

const pct = (v) => `${(v * 100).toFixed(1)}%`;

export const LesionAttentionMetric = ({ caseData }) => {
  const c = caseData || {};
  const score = c.lesionAttentionConsistencyScore;
  const chance = c.lesionAttentionChanceLevel;
  const enrichment = c.lesionAttentionEnrichment;
  const flagged = c.lesionAttentionFlagged;

  const haveScore = typeof score === 'number' && typeof chance === 'number'
    && typeof enrichment === 'number';

  // Not computed at all, and nothing to say about it.
  if (!haveScore && flagged !== true) {
    return (
      <div className="u-mb-4" data-testid="lesion-attention-not-computed">
        <div className="u-flex u-justify-between u-items-center" style={{ marginBottom: 'var(--sp-1)' }}>
          <span className="t-label">LESION-ATTENTION CONSISTENCY</span>
          <span className="t-mono" style={{ fontWeight: 700, fontSize: 'var(--fs-small)', opacity: 0.4 }}>
            NOT COMPUTED
          </span>
        </div>
        <p className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.55 }}>
          Needs both a Grad-CAM map and segmented lesion masks. Not a score of zero.
        </p>
      </div>
    );
  }

  // Flagged with no score: the heatmap carried no energy inside the retina.
  if (!haveScore) {
    return (
      <div className="u-mb-4" data-testid="lesion-attention-no-energy">
        <div className="u-flex u-justify-between u-items-center" style={{ marginBottom: 'var(--sp-1)' }}>
          <span className="t-label">LESION-ATTENTION CONSISTENCY</span>
          <span className="badge badge--fail">&#9888; NO ATTENTION TO CHECK</span>
        </div>
        <p className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.7 }}>
          Grad-CAM produced no attention inside the retina, so there is nothing to compare
          against the lesions. That is itself a reason to review this case.
        </p>
      </div>
    );
  }

  const ok = flagged === false;
  const colour = ok ? 'var(--c-success)' : 'var(--c-crimson)';
  // The bar shows ENRICHMENT against chance, capped for display at 3x. A bar
  // of the raw score would be the misleading thing this component replaces.
  const barPct = Math.max(0, Math.min(100, (enrichment / 3) * 100));

  return (
    <div className="u-mb-4" data-testid="lesion-attention-metric">
      <div className="u-flex u-justify-between u-items-center" style={{ marginBottom: 'var(--sp-1)' }}>
        <span className="t-label">LESION-ATTENTION CONSISTENCY</span>
        <span className="t-mono" style={{ fontWeight: 700, fontSize: 'var(--fs-small)', color: colour }}>
          {enrichment.toFixed(2)}&times; CHANCE
        </span>
      </div>

      <div className="bar" style={{ position: 'relative' }}>
        <div className="bar__fill" style={{ width: `${barPct}%`, background: colour }} />
        {/* Where chance sits on this bar. Left of it, the heatmap has told us
            nothing a uniform map would not have. */}
        <div
          title="Chance level: a random heatmap scores here."
          style={{
            position: 'absolute', left: `${(1 / 3) * 100}%`, top: 0, bottom: 0,
            width: 2, background: 'var(--c-text, #2C1810)', opacity: 0.55,
          }}
        />
      </div>

      <p className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.7, marginTop: 'var(--sp-1)' }}>
        {pct(score)} of the model&#8217;s attention fell on lesions, where a random heatmap
        on this eye would score {pct(chance)}.{' '}
        {ok
          ? 'The model looked where the lesions are.'
          : 'That is at or below chance — the heatmap does not explain this grade, '
            + 'so the case is worth a closer look. It is not a reason to change the grade: '
            + 'the lesion masks are model output too.'}
      </p>
    </div>
  );
};
