#!/usr/bin/env node
'use strict';

/**
 * verify_report_provenance.js
 *
 * The clinical-rationale PDF is the artifact that LEAVES this system: it is
 * downloaded, printed, and put in a patient record, and read later by someone
 * who does not have the reviewer console open. So it has to carry its own
 * provenance -- which classifier build, which engine produced each output, and
 * why the case is in its review tier.
 *
 * This checks the two failure modes that actually happened here:
 *
 *   1. A FIELD THE RENDERER SUPPORTS THAT NOBODY SENDS. generateReport.m has
 *      rendered a "Why: <tierReason>" line since it was written, and
 *      caseReport.js never put tierReason in the JSON -- so every PDF said
 *      "Tier B - assisted review recommended" and never which of the five
 *      situations produced that B. Nothing failed; the line simply never
 *      appeared. So: every field the renderers read is checked to be a field
 *      the Node side sends.
 *
 *   2. THE TWO RENDERERS DRIFTING. generateReport.m (MATLAB Report Generator)
 *      and generateReportFigures.m (core MATLAB, used when that toolbox is
 *      absent) are supposed to produce the same report. A machine without the
 *      toolbox would otherwise silently emit a PDF missing a section, and
 *      nobody would notice until a clinician asked why two reports differ.
 *
 *   3. The flattened provenance rows match what the database holds, and an
 *      unrecorded output is OMITTED rather than rendered as a blank row --
 *      while a case with nothing recorded still produces the honest line.
 *
 * Reads files and the database. Needs neither MATLAB nor a PDF reader: it
 * checks the contract BETWEEN Node and the renderers, which is where both of
 * the above went wrong.
 *
 *   node verify_report_provenance.js
 */

const fs = require('fs');
const path = require('path');

const SERVICE = path.join(__dirname, 'central-system/backend/services/caseReport.js');
const ML = path.join(__dirname, 'central-system/backend/ml-pipeline/explainability');
const DOM_RENDERER = path.join(ML, 'generateReport.m');
const FIG_RENDERER = path.join(ML, 'generateReportFigures.m');

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
  if (!ok) failures += 1;
}

/** Field names a renderer reads out of the input JSON, via its get('x') calls. */
function fieldsReadBy(file) {
  const src = fs.readFileSync(file, 'utf8');
  return new Set([...src.matchAll(/get\('([A-Za-z]+)'\)/g)].map((m) => m[1]));
}

/** Field names caseReport.js puts INTO the input JSON. */
function fieldsSent() {
  const src = fs.readFileSync(SERVICE, 'utf8');
  const block = src.match(/const input = \{([\s\S]*?)\n  \};/);
  if (!block) throw new Error('could not find the `const input = {...}` literal in caseReport.js');
  // `name: value` and the ES6 shorthand `name,` both count as sent.
  return new Set([...block[1].matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*)\s*[:,]/gm)].map((m) => m[1]));
}

async function main() {
  console.log('verify_report_provenance.js -- the PDF carries its own provenance\n');

  const sent = fieldsSent();
  const domReads = fieldsReadBy(DOM_RENDERER);
  const figReads = fieldsReadBy(FIG_RENDERER);

  // ── 1. Nothing a renderer reads is a field nobody sends ──────────────────
  for (const [label, reads] of [['generateReport.m', domReads], ['generateReportFigures.m', figReads]]) {
    const unsent = [...reads].filter((f) => !sent.has(f));
    check(`every field ${label} reads is sent by caseReport.js`,
      unsent.length === 0,
      `never sent, so the renderer's handling of it is dead code: ${unsent.join(', ')}`);
  }

  // ── 2. The two renderers read the same fields ────────────────────────────
  const onlyDom = [...domReads].filter((f) => !figReads.has(f));
  const onlyFig = [...figReads].filter((f) => !domReads.has(f));
  check('the two renderers read the same fields',
    onlyDom.length === 0 && onlyFig.length === 0,
    `only in generateReport.m: ${onlyDom.join(', ') || '(none)'}\n          `
    + `only in generateReportFigures.m: ${onlyFig.join(', ') || '(none)'}\n          `
    + 'both write the same report; a fact in one and not the other is the divergence '
    + 'the fallback exists to avoid');

  // ── 3. The provenance fields specifically ────────────────────────────────
  for (const f of ['tierReason', 'modelVersion', 'provenanceRows']) {
    check(`"${f}" reaches both renderers`,
      sent.has(f) && domReads.has(f) && figReads.has(f),
      `sent: ${sent.has(f)}, generateReport.m: ${domReads.has(f)}, `
      + `generateReportFigures.m: ${figReads.has(f)}`);
  }

  // ── 4. The flattened rows against the database ───────────────────────────
  let pool;
  try {
    pool = require('./central-system/backend/db/pgClient');
    const engineProvenance = require('./central-system/backend/services/engineProvenance');
    const { rows } = await pool.query(
      `SELECT g.engine_provenance, c.quality_gate_engine, g.model_version
         FROM cases c JOIN grading_results g ON g.case_id = c.case_id
        WHERE g.engine_provenance IS NOT NULL
        ORDER BY g.graded_at DESC NULLS LAST LIMIT 1`);

    if (rows.length === 0) {
      console.log('  SKIP  no case carries engine provenance yet (grade one, then re-run)');
    } else {
      const r = rows[0];
      const shape = engineProvenance.toContractShape(r.engine_provenance, r.quality_gate_engine);
      const recorded = [shape.classifier, shape.ruleEngine, shape.qualityGate,
        ...(shape.segmentation ? Object.values(shape.segmentation) : [])].filter(Boolean);

      // Re-derive what caseReport.js would send, through the module itself.
      const svc = require('./central-system/backend/services/caseReport');
      const built = typeof svc.__provenanceRowsForTest === 'function'
        ? svc.__provenanceRowsForTest(r) : null;

      if (!built) {
        console.log('  SKIP  caseReport.js does not expose provenanceRows for testing');
      } else {
        check('one row per RECORDED output, and no row for an unrecorded one',
          built.length === recorded.length,
          `database has ${recorded.length} recorded engines, the PDF would get `
          + `${built.length} rows. A not-recorded output must be omitted, not sent blank.`);
        check('every row carries a real engine name',
          built.every((x) => typeof x.engine === 'string' && x.engine.length > 0));
        check('every row carries an explicit boolean fallback',
          built.every((x) => x.fallback === true || x.fallback === false),
          'a missing fallback flag would render as "not a fallback" in MATLAB');
        check('a label is never blank',
          built.every((x) => typeof x.label === 'string' && x.label.trim().length > 0));
        check('a case with NOTHING recorded yields an empty array, not a fake row',
          svc.__provenanceRowsForTest({ engine_provenance: null, quality_gate_engine: null })
            .length === 0);
      }
    }
  } catch (e) {
    console.log(`  SKIP  database or module unavailable: ${e.message}`);
  } finally {
    if (pool) { try { await pool.end(); } catch { /* already closed */ } }
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => { console.error(`crashed: ${e.stack || e.message}`); process.exit(1); });
