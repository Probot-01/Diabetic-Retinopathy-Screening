#!/usr/bin/env node
'use strict';

/**
 * The PHC quality gate has TWO implementations. This checks they agree.
 *
 *   quality-gate-matlab/qualityGateMain.m  -- the real one, compiled to
 *                                             dist/qualityGate.exe
 *   services/qualityGateFallback.js        -- a pure-JS reimplementation used
 *                                             when neither MATLAB nor the exe
 *                                             is present on a PHC machine
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Two implementations of one decision drift. That is not a hypothetical here:
 * the central system had exactly this shape and it drifted twice in one day --
 * the JS rule-engine fallback ignored ruleOpts and printed "Severe NPDR" under
 * a Moderate grade, and the same fallback reported a different sourceFormat
 * vocabulary from MATLAB. Both were invisible until something compared them.
 *
 * The central side has verify_fallback_parity.js (720 cases) for that reason.
 * The PHC side had nothing, so the only guarantee that a clinic running
 * without MATLAB retook the same photographs was that both files had been
 * written from the same spec.
 *
 * What a divergence costs here: the gate decides RETAKE while the patient is
 * still in the chair. A fallback that is more lenient sends unusable images to
 * be graded; one that is stricter makes a worker re-photograph a healthy eye.
 *
 *   node verify_quality_gate_parity.js
 *
 * Needs the compiled exe (or MATLAB). Reports SKIP rather than passing
 * vacuously when neither is available -- a parity check that silently checks
 * nothing is worse than no parity check at all.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const PHC = path.join(ROOT, 'phc-local-app', 'backend');
const EXE = path.join(PHC, 'quality-gate-matlab', 'dist', 'qualityGate.exe');

const { runQualityGateFallback } = require(
  path.join(PHC, 'services', 'qualityGateFallback.js'));

// Scores are floating point through two completely different numeric stacks
// (MATLAB's image toolbox vs a hand-written JS convolution), so exact equality
// is the wrong test. This is the tolerance the central parity check uses for
// the same reason.
const TOL = 1e-3;

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail) console.log(`        ${detail}`);
  }
}

function imagesToTest() {
  const dirs = [
    path.join(ROOT, 'datasets'),
    path.join(ROOT, 'demo_images'),
  ];
  const out = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (/\.(jpe?g|png|bmp)$/i.test(f)) out.push(path.join(d, f));
    }
  }
  return out;
}

function runExe(imagePath) {
  const stdout = execFileSync(EXE, [imagePath, 'unknown'],
    { encoding: 'utf8', timeout: 120000 });
  // The CLI prints the JSON result; tolerate any banner lines around it.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < 0) {
    throw new Error(`no JSON in exe output: ${stdout.slice(0, 200)}`);
  }
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  // Normalise exactly as qualityGateClient.parseGateOutput does, because that
  // is what production consumes. MATLAB encodes [] (empty matrix) as a JSON
  // empty ARRAY, not null, so a raw comparison reports a difference that the
  // real code path does not have. Compare what the app sees, not what the
  // process printed.
  const r = parsed.reason;
  parsed.reason = (r === null || r === undefined
    || (Array.isArray(r) && r.length === 0)) ? null : r;
  return parsed;
}

async function main() {
  console.log('\n--- PHC quality gate: MATLAB vs the JS fallback ---');

  if (!fs.existsSync(EXE)) {
    console.log(`  SKIP  ${EXE} is not built, so there is nothing to compare`);
    console.log('        Build it: matlab -batch "cd(\'phc-local-app/backend/'
      + 'quality-gate-matlab\'); buildQualityGateExe()"');
    return 0;
  }

  const images = imagesToTest();
  if (images.length === 0) {
    console.log('  SKIP  no images found under datasets/ or demo_images/');
    return 0;
  }

  // ── IS THE FALLBACK EVEN ON? ─────────────────────────────────────────────
  // It is currently switched OFF on purpose: its scores diverged from the
  // compiled gate, so runQualityGateFallback throws instead of returning a
  // verdict nobody measured. That is the right call -- see the long note in
  // qualityGateFallback.js -- and it means there are two implementations to
  // compare only when someone revives it.
  //
  // Reported as SKIP, not FAIL. A red line here should mean "the two
  // implementations disagree", and a deliberate switch-off is not that. The
  // check stays in the repo so that reviving the fallback cannot quietly
  // bypass it.
  try {
    await runQualityGateFallback(fs.readFileSync(images[0]));
  } catch (err) {
    if (/switched off/i.test(err.message)) {
      console.log('  SKIP  the JS fallback is switched off by design, so there is');
      console.log('        no second implementation to compare against.');
      console.log('        Reviving it means getting this to zero mismatches first.');
      return 0;
    }
    // Any other error is a real failure and falls through to the loop below,
    // which reports it per image.
  }

  let compared = 0;
  for (const img of images) {
    let exe;
    try {
      exe = runExe(img);
    } catch (err) {
      check(`${path.basename(img)}: exe ran`, false, err.message.slice(0, 200));
      continue;
    }

    let js;
    try {
      // Takes a BUFFER, not a path, and is async -- unlike the exe, which is
      // driven by file path. Same decision, two different call shapes.
      js = await runQualityGateFallback(fs.readFileSync(img));
    } catch (err) {
      check(`${path.basename(img)}: fallback ran`, false, err.message.slice(0, 200));
      continue;
    }

    compared += 1;
    const name = path.basename(img);

    // The DECISION is what the worker acts on -- it matters more than any
    // individual score, and it is what a drift would change.
    check(`${name}: same status`, exe.status === js.status,
      `matlab='${exe.status}' js='${js.status}'`);
    check(`${name}: same reason`, (exe.reason ?? null) === (js.reason ?? null),
      `matlab='${exe.reason}' js='${js.reason}'`);

    const keys = Object.keys(exe.scores || {});
    for (const k of keys) {
      const a = Number(exe.scores[k]);
      const b = Number((js.scores || {})[k]);
      const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= TOL;
      check(`${name}: ${k} within ${TOL}`, ok,
        `matlab=${a} js=${b} diff=${Math.abs(a - b)}`);
    }
  }

  console.log(`\n${compared} image(s) compared, ${failures} mismatched`);
  if (failures === 0 && compared > 0) {
    console.log('the compiled quality gate and the JS fallback agree');
  }
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
