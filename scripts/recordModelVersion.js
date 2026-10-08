'use strict';

/**
 * recordModelVersion.js
 *
 * Write a trained model's validation metrics into `model_versions`.
 *
 *   node scripts/recordModelVersion.js <versionId> <sensitivity> <specificity> <kappa> [--promote]
 *
 * Example, from calibrateBranchA.m's output:
 *   node scripts/recordModelVersion.js branchA_v1 0.860294 0.938202 0.868803 --promote
 *
 * ── WHY THIS MATTERS MORE THAN IT LOOKS ─────────────────────────────────────
 * These three columns are the continual-learning promotion gate (Task 7.2).
 * continualLearningService.js refuses to promote a retrained model unless it
 * holds up against the live one on sensitivity, specificity AND kappa — but a
 * gate with nothing to compare against is not a gate. Until this row is
 * populated, the safety mechanism is inert while looking installed, which is
 * the worst of both.
 *
 * ── WHY THE NUMBERS ARE PASSED IN RATHER THAN COMPUTED HERE ─────────────────
 * They come from evaluateMetrics.m on the held-out test split. Recomputing
 * them in JavaScript would create a second implementation of the metric maths
 * that can disagree with the first — and the whole point of Task 9.1 was that
 * there is exactly one place those numbers are defined.
 *
 * ── NULL IS A MEANINGFUL VALUE HERE ─────────────────────────────────────────
 * An unmeasurable metric must arrive as NULL, never 0. The gate treats a
 * missing metric as "refuse to promote"; a 0 reads as a measured catastrophe.
 * Passing the string "null" writes SQL NULL.
 */

const path = require('path');
const pool = require(path.resolve(__dirname, '..', 'central-system', 'backend', 'db', 'pgClient'));

function parseMetric(raw, name) {
  if (raw === undefined) throw new Error(`${name} is required`);
  if (String(raw).toLowerCase() === 'null') return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number or 'null', got '${raw}'`);
  if (v < 0 || v > 1) throw new Error(`${name} must be in [0,1] (kappa may be negative — pass 'null' if unmeasured), got ${v}`);
  return v;
}

async function main() {
  const [versionId, sensRaw, specRaw, kappaRaw] = process.argv.slice(2);
  const promote = process.argv.includes('--promote');

  if (!versionId) {
    console.error('usage: node scripts/recordModelVersion.js <versionId> <sens> <spec> <kappa> [--promote]');
    process.exit(2);
  }

  const sensitivity = parseMetric(sensRaw, 'sensitivity');
  const specificity = parseMetric(specRaw, 'specificity');
  // Kappa can legitimately be negative (worse than chance), so it is not
  // range-checked the same way — but it must still be a real number.
  const kappa = String(kappaRaw).toLowerCase() === 'null' ? null : Number(kappaRaw);
  if (kappa !== null && !Number.isFinite(kappa)) {
    throw new Error(`kappa must be a number or 'null', got '${kappaRaw}'`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Exactly one promoted version is an invariant the service depends on, so
    // demotion happens in the SAME transaction as promotion. Two rows briefly
    // marked promoted would be read by anything polling in between.
    if (promote) {
      await client.query(
        'UPDATE model_versions SET promoted = false WHERE version_id <> $1', [versionId]);
    }

    await client.query(`
      INSERT INTO model_versions
        (version_id, trained_at, validation_sensitivity, validation_specificity,
         validation_kappa, promoted, promoted_at)
      VALUES ($1, now(), $2, $3, $4, $5, CASE WHEN $5 THEN now() ELSE NULL END)
      ON CONFLICT (version_id) DO UPDATE SET
        validation_sensitivity = EXCLUDED.validation_sensitivity,
        validation_specificity = EXCLUDED.validation_specificity,
        validation_kappa       = EXCLUDED.validation_kappa,
        promoted               = EXCLUDED.promoted,
        promoted_at            = COALESCE(model_versions.promoted_at, EXCLUDED.promoted_at),
        trained_at             = COALESCE(model_versions.trained_at, EXCLUDED.trained_at)
    `, [versionId, sensitivity, specificity, kappa, promote]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(`
    SELECT version_id, validation_sensitivity AS sens, validation_specificity AS spec,
           validation_kappa AS kappa, promoted
    FROM model_versions ORDER BY promoted DESC, version_id
  `);
  console.table(rows);
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
