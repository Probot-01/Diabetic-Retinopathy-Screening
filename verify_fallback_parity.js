'use strict';

/**
 * verify_fallback_parity.js
 *
 * matlabFallback.js is a JS port of ruleEngineGrade.m, used when MATLAB cannot
 * be spawned at all. A port that has silently drifted is worse than no port:
 * the same image would get a different grade depending only on whether MATLAB
 * happened to be installed on the machine that graded it, and nothing would
 * error.
 *
 * So this runs BOTH engines over the same grid of cases and compares grade,
 * lower-bound bookkeeping, the assessed flags and the full limitation text.
 *
 * The grid deliberately covers the §I fovea-unreliable interaction, which is
 * where the drift was found: the JS port ignored the flag entirely, so a
 * flagged case was still graded on criteria (a) and (b).
 *
 *   node verify_fallback_parity.js
 *
 * Needs MATLAB on PATH. Without it the script says so and exits non-zero
 * rather than passing vacuously.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fallback = require('./central-system/backend/services/matlabFallback');

const GRADING_DIR = path.join(__dirname,
  'central-system', 'backend', 'ml-pipeline', 'grading');

// null = the field is absent, i.e. NOT ASSESSED. [false,false,false,false] is
// a different thing: assessed, found nothing. Both must be exercised.
const VB = [null, [false, false, false, false], [true, true, false, false], [true, true, true, true]];
const IRMA = [null, [false, false, false, false], [true, false, false, false]];
const RED = [
  [0, 0, 0, 0],
  [1, 1, 0, 0],
  [4, 4, 4, 4],       // criterion (a) fires
  [9, 1, 0, 0],       // moderate by total
  [3, 3, 3, 2],       // just misses (a)
];
const BRIGHT = [[0, 0, 0, 0], [2, 0, 0, 0]];
const NV = [0, 0.3, 0.95];

const cases = [];
for (const red of RED) {
  for (const bright of BRIGHT) {
    for (const nv of NV) {
      for (const vb of VB) {
        for (const irma of IRMA) {
          for (const foveaUnreliable of [false, true]) {
            cases.push({ red, bright, nv, vb, irma, foveaUnreliable });
          }
        }
      }
    }
  }
}

function jsOpts(c) {
  const opts = {};
  if (c.vb) opts.venousBeadingQuadrants = c.vb;
  if (c.irma) opts.irmaQuadrants = c.irma;
  if (c.foveaUnreliable) opts.foveaUnreliable = true;
  return opts;
}

function runJs() {
  return cases.map((c) => {
    const { grade, evidence } = fallback.ruleEngineGrade(c.red, c.bright, c.nv, jsOpts(c));
    return {
      grade,
      isLowerBound: evidence.isLowerBound,
      cappedFrom: evidence.cappedFrom === null ? -1 : evidence.cappedFrom,
      venousBeadingAssessed: evidence.venousBeadingAssessed,
      irmaAssessed: evidence.irmaAssessed,
      foveaUnreliable: evidence.foveaUnreliable,
      criterion: evidence.criterion,
      limitation: evidence.limitation,
    };
  });
}

function runMatlab(inPath, outPath) {
  fs.writeFileSync(inPath, JSON.stringify(cases.map((c) => ({
    red: c.red,
    bright: c.bright,
    nv: c.nv,
    // [] is MATLAB's own "absent"; jsondecode turns JSON null into [] anyway,
    // and quadrantFlags() treats an empty value as not assessed.
    vb: c.vb === null ? [] : c.vb,
    irma: c.irma === null ? [] : c.irma,
    foveaUnreliable: c.foveaUnreliable,
  }))), 'utf8');

  const script = `
cases = jsondecode(fileread('${inPath.replace(/\\/g, '/')}'));
out = cell(numel(cases), 1);
for k = 1:numel(cases)
    c = cases(k);
    opts = struct();
    if ~isempty(c.vb),   opts.venousBeadingQuadrants = logical(c.vb(:)'); end
    if ~isempty(c.irma), opts.irmaQuadrants          = logical(c.irma(:)'); end
    if c.foveaUnreliable, opts.foveaUnreliable = true; end
    [g, ev] = ruleEngineGrade(c.red(:)', c.bright(:)', c.nv, opts);
    if isempty(ev.cappedFrom), capped = -1; else, capped = ev.cappedFrom; end
    out{k} = struct('grade', g, 'isLowerBound', logical(ev.isLowerBound), ...
        'cappedFrom', capped, ...
        'venousBeadingAssessed', logical(ev.venousBeadingAssessed), ...
        'irmaAssessed', logical(ev.irmaAssessed), ...
        'foveaUnreliable', logical(ev.foveaUnreliable), ...
        'criterion', ev.criterion, 'limitation', ev.limitation);
end
fid = fopen('${outPath.replace(/\\/g, '/')}', 'w');
fwrite(fid, jsonencode([out{:}]));
fclose(fid);
`;

  // Written to a real .m file and run with run(), NOT joined onto one -batch
  // line: a joined line needs a separator after every `end`, and the one that
  // is missing reports itself as "Illegal use of reserved keyword".
  const scriptPath = path.join(path.dirname(inPath), 'runFallbackParity.m');
  fs.writeFileSync(scriptPath, script, 'utf8');
  // addpath, not just cwd: run() switches the current folder to the script's
  // own, so the grading folder has to be on the path or ruleEngineGrade is
  // simply not found from there.
  execFileSync('matlab',
    ['-batch', `addpath('${GRADING_DIR.replace(/\\/g, '/')}'); `
      + `run('${scriptPath.replace(/\\/g, '/')}')`],
    { cwd: GRADING_DIR, stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

function describe(c) {
  return `red=[${c.red}] bright=[${c.bright}] nv=${c.nv} `
    + `vb=${c.vb ? `[${c.vb.map(Number)}]` : 'absent'} `
    + `irma=${c.irma ? `[${c.irma.map(Number)}]` : 'absent'} `
    + `foveaUnreliable=${c.foveaUnreliable}`;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-parity-'));
  const js = runJs();

  let ml;
  try {
    ml = runMatlab(path.join(tmp, 'cases.json'), path.join(tmp, 'out.json'));
  } catch (err) {
    console.error('could not run MATLAB, so nothing was compared:');
    console.error(err.stderr ? err.stderr.toString() : err.message);
    return 1;
  }

  const FIELDS = ['grade', 'isLowerBound', 'cappedFrom', 'venousBeadingAssessed',
    'irmaAssessed', 'foveaUnreliable', 'criterion', 'limitation'];

  let failed = 0;
  for (let i = 0; i < cases.length; i += 1) {
    for (const f of FIELDS) {
      // MATLAB writes — as a unicode escape through jsonencode on some
      // releases; compare the decoded text, not the bytes that carried it.
      const a = typeof js[i][f] === 'string' ? js[i][f].trim() : js[i][f];
      const b = typeof ml[i][f] === 'string' ? ml[i][f].trim() : ml[i][f];
      if (a !== b) {
        failed += 1;
        console.log(`MISMATCH ${f}\n  case: ${describe(cases[i])}\n  js:     ${JSON.stringify(a)}\n  matlab: ${JSON.stringify(b)}`);
      }
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${cases.length} cases x ${FIELDS.length} fields, ${failed} mismatched`);
  if (failed === 0) console.log('JS fallback and ruleEngineGrade.m agree');

  failed += evidenceTextUsesRuleOpts(cases);

  return failed === 0 ? 0 : 1;
}

/**
 * The evidence PROSE must describe the same rule engine that produced the grade.
 *
 * The fields compared above are ruleEngineGrade's own outputs. evidenceSummaryText
 * re-runs the rule engine a second time to build its sentences, and it used to do
 * so WITHOUT ruleOpts -- so on a fovea-unreliable case the grade said "Moderate
 * NPDR" while the text under it said "Severe NPDR, ETDRS 4-2-1(a) structure",
 * citing quadrant reasoning the grade had deliberately skipped. Every field above
 * still matched, because none of them is the prose.
 *
 * Invariant: the criterion sentence in the text must be the criterion the rule
 * engine reports for the SAME inputs and the SAME opts.
 */
function evidenceTextUsesRuleOpts(cases) {
  const { ruleEngineGrade, evidenceSummaryText } = require(
    './central-system/backend/services/matlabFallback');

  let bad = 0;
  let checked = 0;
  for (const c of cases) {
    for (const opts of [{}, { foveaUnreliable: true },
      { venousBeadingQuadrants: [true, true, false, false] },
      { irmaQuadrants: [true, false, false, false] }]) {
      const inputs = {
        redByQuadrant: c.red, brightByQuadrant: c.bright, nvSuspicionScore: c.nv,
      };
      const { evidence } = ruleEngineGrade(c.red, c.bright, c.nv, opts);
      const text = evidenceSummaryText(inputs, opts);
      checked += 1;
      if (evidence.criterion && !text.includes(evidence.criterion.trim())) {
        bad += 1;
        if (bad <= 3) {
          console.log(`MISMATCH evidence prose\n  case: ${describe(c)}`
            + `\n  opts:      ${JSON.stringify(opts)}`
            + `\n  criterion: ${evidence.criterion}`
            + `\n  text:      ${text.slice(0, 160)}`);
        }
      }
    }
  }
  console.log(`\n${checked} evidence-text checks, ${bad} mismatched`);
  if (bad === 0) console.log('evidence prose cites the criterion that actually fired');
  return bad;
}

process.exit(main());
