#!/usr/bin/env node
'use strict';

/**
 * verify_urgency_inputs.js
 *
 * The urgency model needs an HbA1c. The questionnaire records glycemic control
 * as poor/moderate/good. So 'moderate' becomes 7.5 -- a bucket midpoint
 * standing in for a number nobody measured. calculateUrgencyScore.m records
 * that faithfully in urgency_inputs.provenance, and until now the reviewer
 * never saw it: a score of 79 built on two substituted values and a 55 built
 * on three real ones rendered as identical bare numbers on the queue.
 *
 * Checks:
 *   1. assumedInputs() tells the three states apart -- measured, substituted,
 *      and NOT RECORDED. The third is null, never [], because [] is a positive
 *      claim that everything was measured.
 *   2. An unrecognised provenance string counts as SUBSTITUTED, not measured.
 *      Only the literal "measured" means measured; defaulting the other way
 *      would silently launder a value the engine did not vouch for.
 *   3. Against the real database: every row carrying an urgency score resolves
 *      to a list, and the shape the queue's SQL produces is the shape the
 *      helper expects.
 *   4. The queue route actually selects and serves the field.
 *   5. THE DUPLICATION GUARD. The frontend keeps its own label map, because
 *      labels are presentation and belong with the translated strings. That
 *      means two lists of input KEYS exist. They must name the same inputs --
 *      otherwise the backend starts reporting a fourth input and the queue
 *      renders the raw key `yearsDiabetic` at a clinician.
 *
 *   node verify_urgency_inputs.js
 */

const fs = require('fs');
const path = require('path');

const SERVICE = path.join(__dirname, 'central-system/backend/services/urgencyInputs');
const ROUTE = path.join(__dirname, 'central-system/backend/routes/ophthalmologistQueue.js');
const QUEUE_PAGE = path.join(__dirname,
  'central-system/frontend/src/components/screens/ReviewQueuePage.jsx');

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
  if (!ok) failures += 1;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  console.log('verify_urgency_inputs.js -- measured values vs substituted ones\n');

  const u = require(SERVICE);

  // ── 1. The three states ─────────────────────────────────────────────────
  check('all measured -> []',
    eq(u.assumedInputs({ provenance: { patientAge: 'measured', yearsDiabetic: 'measured', hba1c: 'measured' } }), []));
  check('substituted inputs are named, in reading order',
    eq(u.assumedInputs({
      provenance: {
        hba1c: "assumed from glycemicControl='moderate'",
        patientAge: 'measured',
        yearsDiabetic: "assumed from yearsSinceDiagnosis='lt1'",
      },
    }), ['yearsDiabetic', 'hba1c']),
    'order follows INPUT_ORDER, not whatever order the JSON happened to have');
  check('no provenance recorded -> null, NOT []',
    u.assumedInputs(null) === null && u.assumedInputs({}) === null,
    '[] says "everything was measured", which is a claim; null says nobody recorded it');

  // ── 2. Unrecognised strings are not laundered into "measured" ────────────
  check('an unrecognised provenance string counts as SUBSTITUTED',
    eq(u.assumedInputs({ provenance: { hba1c: 'imputed by some future method', patientAge: 'measured', yearsDiabetic: 'measured' } }), ['hba1c']),
    'only the literal "measured" may mean measured; anything else is a value '
    + 'the engine did not vouch for');
  check('"MEASURED" in any case still means measured',
    eq(u.assumedInputs({ provenance: { hba1c: ' Measured ', patientAge: 'measured', yearsDiabetic: 'measured' } }), []));

  check('the phrase reads as English',
    u.assumedInputsText(['yearsDiabetic', 'hba1c']) === 'years diabetic and HbA1c'
    && u.assumedInputsText(['hba1c']) === 'HbA1c'
    && u.assumedInputsText([]) === null);

  // ── 4. The route serves it ──────────────────────────────────────────────
  const route = fs.readFileSync(ROUTE, 'utf8');
  check('the queue route selects the provenance',
    /urgency_inputs\s*->\s*'provenance'/.test(route),
    'without this the field is always null on the queue');
  check('the queue route serves urgencyAssumedInputs',
    /urgencyAssumedInputs\s*:/.test(route));

  // ── 5. Duplication guard: the two key lists must agree ──────────────────
  const page = fs.readFileSync(QUEUE_PAGE, 'utf8');
  const block = page.match(/const URGENCY_INPUT_LABELS = \{([\s\S]*?)\};/);
  if (!block) {
    check('the queue page has a label map to compare', false,
      'URGENCY_INPUT_LABELS not found in ReviewQueuePage.jsx');
  } else {
    const feKeys = [...block[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]).sort();
    const beKeys = [...u.INPUT_ORDER].sort();
    check('the frontend labels exactly the inputs the backend reports',
      eq(feKeys, beKeys),
      `backend: ${beKeys.join(', ')}\n          frontend: ${feKeys.join(', ')}\n          `
      + 'an input the frontend does not label renders as its raw key to a clinician');
  }

  // ── 3. Against the real database ────────────────────────────────────────
  let pool;
  try {
    pool = require('./central-system/backend/db/pgClient');
    const { rows } = await pool.query(
      `SELECT urgency_score, urgency_inputs -> 'provenance' AS prov
         FROM grading_results WHERE urgency_score IS NOT NULL`);
    if (rows.length === 0) {
      console.log('  SKIP  no case carries an urgency score in this database');
    } else {
      const resolved = rows.map((r) => u.assumedInputs(r.prov ? { provenance: r.prov } : null));
      check(`every scored case resolves to a list (${rows.length} rows)`,
        resolved.every((x) => Array.isArray(x)),
        'a row with a score but no provenance would show no marker and no '
        + '"not recorded" note either');
      const anyAssumed = resolved.some((x) => x.length > 0);
      const anyClean = resolved.some((x) => x.length === 0);
      check('the distinction is real in this data, not just in theory',
        anyAssumed && anyClean,
        `assumed-input rows: ${resolved.filter((x) => x.length).length}, `
        + `fully-measured rows: ${resolved.filter((x) => !x.length).length}. `
        + 'If every row is the same, this check proves nothing about the other case.');
      for (const [i, r] of rows.entries()) {
        const bad = Object.keys(r.prov || {}).filter((k) => !u.INPUT_ORDER.includes(k));
        if (bad.length) {
          check(`row ${i}: provenance names only known inputs`, false,
            `unknown inputs in the database: ${bad.join(', ')}. The backend records `
            + 'them and nothing shows them.');
        }
      }
    }
  } catch (e) {
    console.log(`  SKIP  database unavailable: ${e.message}`);
  } finally {
    if (pool) { try { await pool.end(); } catch { /* already closed */ } }
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => { console.error(`crashed: ${e.stack || e.message}`); process.exit(1); });
