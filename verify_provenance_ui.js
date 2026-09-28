#!/usr/bin/env node
'use strict';

/**
 * verify_provenance_ui.js
 *
 * The UI half of the standing rule that every case records which engine
 * produced each ML output and no engine switch is silent.
 * verify_engine_provenance.js checks that the BACKEND stores and serves it;
 * this checks that Case Detail actually SHOWS it, because for most of this
 * project's life the data was stored, served, and then thrown away at the last
 * step by a screen that rendered one of the seven entries.
 *
 * It renders central-system/frontend ProvenancePanel with react-dom/server
 * against a REAL case read from Postgres -- not a fixture -- and asserts:
 *
 *   1. Every recorded engine is named, and every `detail` string appears
 *      VERBATIM. The contract says detail is free text for a human and must
 *      not be parsed; printing it unchanged is what makes that true.
 *   2. A null entry reads NOT RECORDED and the panel names no engine for it.
 *      "Not recorded" and "ran on the primary engine" are different claims.
 *   3. A pre-migration-0019 case (all four entries null -- 67 real rows are
 *      like this) makes the panel claim NOTHING: the word MATLAB must not
 *      appear anywhere in the output.
 *   4. `fallback: true` is visible twice: on its own row and as a panel-level
 *      warning. The contract asks for exactly this.
 *   5. MATLAB COMPILER FORWARD-COMPATIBILITY. `engine: "matlab"` covers both
 *      `matlab -batch` and the compiled MATLAB executable, and only `detail`
 *      distinguishes them. This renders a compiled-executable entry and
 *      asserts the panel reports the change through `detail` with no code
 *      change here -- so nobody is tempted to add a "matlab-compiled" engine
 *      value to the contract's fixed enum when the pipeline is compiled.
 *
 *   node verify_provenance_ui.js
 *
 * Exits 0 on pass, 1 on failure. SKIPs (still 0) when the database is
 * unreachable or no graded case carries provenance yet -- both are
 * environment facts, not regressions.
 */

const path = require('path');
const { pathToFileURL } = require('url');

const FRONTEND = path.join(__dirname, 'central-system', 'frontend');
const PANEL = 'src/components/screens/ProvenancePanel.jsx';

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}

/** True when `html` contains `needle` as literal text (entities decoded). */
function hasText(html, needle) {
  const decoded = html
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&mdash;/g, '—').replace(/&#8212;/g, '—')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  return decoded.includes(needle.replace(/\s+/g, ' '));
}

async function loadRealCase() {
  let ing;
  try {
    ing = require('./central-system/backend/services/ingestionService');
  } catch (e) {
    return { skip: `central backend not loadable: ${e.message}` };
  }
  const pool = require('./central-system/backend/db/pgClient');
  try {
    // The newest graded case that actually has provenance stored. Cases graded
    // before migration 0019 have none, and they are the subject of check 3.
    const r = await pool.query(
      `SELECT c.case_id FROM cases c
         JOIN grading_results gr ON gr.case_id = c.case_id
        WHERE c.status = 'graded' AND gr.engine_provenance IS NOT NULL
        ORDER BY gr.graded_at DESC NULLS LAST LIMIT 1`);
    if (r.rowCount === 0) {
      return { skip: 'no graded case carries engine provenance yet (grade one case, then re-run)' };
    }
    return { detail: await ing.getCaseDetail(r.rows[0].case_id) };
  } catch (e) {
    return { skip: `database unreachable: ${e.message}` };
  } finally {
    try { await pool.end(); } catch { /* already closed */ }
  }
}

/** Every non-null entry in an engineProvenance object, flattened with a label. */
function flatten(p) {
  const out = [];
  if (p.classifier) out.push(['classifier', p.classifier]);
  if (p.ruleEngine) out.push(['ruleEngine', p.ruleEngine]);
  if (p.qualityGate) out.push(['qualityGate', p.qualityGate]);
  if (p.segmentation) {
    for (const [k, v] of Object.entries(p.segmentation)) if (v) out.push([`segmentation.${k}`, v]);
  }
  return out;
}

async function main() {
  console.log('verify_provenance_ui.js -- Case Detail shows which engine produced each output\n');

  const real = await loadRealCase();
  if (real.skip) {
    console.log(`SKIP: ${real.skip}`);
    console.log('\nNothing was verified. This is an environment fact, not a pass.');
    return 0;
  }
  const caseDetail = real.detail;
  console.log(`Real case ${caseDetail.caseId} (status ${caseDetail.status}, model ${caseDetail.modelVersion})\n`);

  // Vite transforms the JSX and resolves React for us; no test framework and no
  // new dependency is added to the frontend for this.
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
  const server = await createServer({
    root: FRONTEND,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null },
    // react/react-dom are CommonJS; let Node require them instead of putting
    // them through the SSR transform, which chokes on their `module` guard.
    ssr: { external: ['react', 'react-dom', 'react-dom/server'] },
  });

  let html;
  try {
    const { ProvenancePanel } = await server.ssrLoadModule(PANEL);
    const fromFrontend = (m) => require(require.resolve(m, { paths: [FRONTEND] }));
    const React = fromFrontend('react');
    const { renderToStaticMarkup } = fromFrontend('react-dom/server');
    const render = (c) => renderToStaticMarkup(React.createElement(ProvenancePanel, { caseData: c }));

    // ── 1. Real case: every recorded engine named, every detail verbatim ────
    html = render(caseDetail);
    const entries = flatten(caseDetail.engineProvenance || {});
    check('the real case has recorded engines to show', entries.length > 0,
      `engineProvenance was ${JSON.stringify(caseDetail.engineProvenance)}`);

    for (const [label, e] of entries) {
      check(`${label}: engine "${e.engine}" is named`,
        hasText(html, e.engine.toUpperCase()));
      if (e.detail) {
        check(`${label}: detail printed verbatim`, hasText(html, e.detail),
          `expected the exact string: ${e.detail}`);
      }
    }
    check('modelVersion is shown',
      hasText(html, String(caseDetail.modelVersion).toUpperCase()),
      `expected ${caseDetail.modelVersion}; a reviewer cannot otherwise tell which build graded the case`);

    // ── 2. A null entry says NOT RECORDED and names no engine ───────────────
    const oneNull = { ...caseDetail, engineProvenance: { ...caseDetail.engineProvenance, qualityGate: null } };
    const nullHtml = render(oneNull);
    check('a null entry reads NOT RECORDED', hasText(nullHtml, 'NOT RECORDED'));
    check('a null quality gate is not filled in from configuration',
      !hasText(nullHtml, 'qualityGateMain.m'),
      'the panel printed a quality-gate detail for an entry that has none');

    // ── 3. A pre-0019 case claims nothing at all ────────────────────────────
    const preMigration = {
      ...caseDetail,
      status: 'graded',
      modelVersion: null,
      engineProvenance: { classifier: null, segmentation: null, ruleEngine: null, qualityGate: null },
    };
    const preHtml = render(preMigration);
    check('a case graded before provenance existed names NO engine',
      !hasText(preHtml, 'MATLAB') && !hasText(preHtml, 'PYTHON'),
      'the panel named an engine for a case that never recorded one -- provenance must be '
      + 'reported, never inferred from the current configuration');
    check('a pre-migration case says WHY it is blank',
      hasText(preHtml, 'migration 0019'));

    // ── 4. fallback: true is visible on the row and at panel level ──────────
    const withFallback = {
      ...caseDetail,
      engineProvenance: {
        ...caseDetail.engineProvenance,
        classifier: { engine: 'js-fallback', fallback: true, detail: 'JS fallback under MATLAB_ALLOW_FALLBACK' },
      },
    };
    const fbHtml = render(withFallback);
    check('fallback: true raises the panel-level warning',
      fbHtml.includes('provenance-fallback-warning'));
    check('fallback: true names the output that fell back',
      hasText(fbHtml, 'NON-PRIMARY ENGINE ANSWERED FOR: CLASSIFIER'));
    check('fallback: true is also flagged on its own row', hasText(fbHtml, 'FALLBACK'));
    check('no fallback warning when every engine is primary',
      !html.includes('provenance-fallback-warning'),
      'the real case has no fallback, so the banner must not appear');

    // ── 4b. The camera cross-check's three states (migration 0021) ─────────
    // null must not read as agreement: classifyCameraFamily.m returns
    // "no mismatch" both when the two agree and when there was nothing to
    // compare, and only one of those says anything about this camera.
    const crossCheck = (over) => render({ ...caseDetail, ...over });

    const disagrees = crossCheck({
      cameraMismatch: true, cameraExpectedFamily: 'portable_handheld',
      cameraFamilyDetected: 'desktop_tabletop',
    });
    check('a camera disagreement is called out', hasText(disagrees, 'DISAGREES'));
    check('and names both sides of the comparison',
      hasText(disagrees, 'implies a portable handheld') && hasText(disagrees, 'read as a desktop tabletop'),
      'a mismatch the reader cannot inspect is an assertion, not evidence');

    const agrees = crossCheck({
      cameraMismatch: false, cameraExpectedFamily: 'desktop_tabletop',
      cameraFamilyDetected: 'desktop_tabletop',
    });
    check('a checked-and-agreed camera says AGREES', hasText(agrees, 'AGREES'));

    const unchecked = crossCheck({ cameraMismatch: null, cameraExpectedFamily: null });
    check('an unrunnable cross-check says NOT CHECKED', hasText(unchecked, 'NOT CHECKED'));
    check('and does NOT claim the two agree',
      !hasText(unchecked, 'AGREES'),
      'null means nobody could check; rendering it as agreement invents a verification');

    // ── 4c. A failed case must not read like a graded one ───────────────
    // api-contracts.md: "a case with status: error must not be
    // indistinguishable from a graded one". Every ML field is null on a failed
    // case AND on one still grading, so without the banner the two render
    // identically -- blanks the reader cannot interpret.
    const { CaseStatusBanner } = await server.ssrLoadModule('src/components/screens/CaseStatusBanner.jsx');
    const banner = (over) => renderToStaticMarkup(
      React.createElement(CaseStatusBanner, { caseData: { ...caseDetail, ...over } }));

    const gradedBanner = banner({ status: 'graded' });
    check('a graded case shows no status banner', gradedBanner === '',
      'the banner is for cases that have no grade; a graded one speaks for itself');

    const failedBanner = banner({ status: 'error', failureCode: 'matlab_unavailable', failedAt: '2026-09-27T05:00:00.000Z' });
    const processingBanner = banner({ status: 'processing', failureCode: null, failedAt: null });
    check('a FAILED case says so', hasText(failedBanner, 'GRADING FAILED'));
    check('a failed case says the blanks are missing results, not findings',
      hasText(failedBanner, 'missing results, not findings'),
      'an empty grade next to an empty lesion count reads as "nothing found" unless '
      + 'the page says otherwise');
    check('a failed case carries its code', hasText(failedBanner, 'matlab_unavailable'));
    check('a STILL-GRADING case says something different from a failed one',
      hasText(processingBanner, 'NOT GRADED YET') && failedBanner !== processingBanner,
      'these are the two states the contract requires to be distinguishable');
    check('the failure MESSAGE is not shown, only the code',
      !hasText(failedBanner, 'failureReason') && !hasText(failedBanner, 'stack'),
      'the message can quote internal paths; the contract serves it to admins only');
    check('an unknown status claims nothing', banner({ status: 'something_new' }) === '',
      'saying something definite about a state we were not told is the mistake '
      + 'this component exists to correct');

    // ── 5. MATLAB Compiler forward-compatibility ────────────────────────────
    // When the pipeline moves to the compiled executable, the contract's engine
    // enum does not change: `matlab` still covers it, and `detail` says which.
    // This asserts the panel needs no edit for that switch.
    const COMPILED_DETAIL = 'compiled MATLAB executable (runCasePipeline in netraSetuPipeline.exe, ctfroot)';
    const compiled = {
      ...caseDetail,
      engineProvenance: {
        ...caseDetail.engineProvenance,
        ruleEngine: { engine: 'matlab', fallback: false, detail: COMPILED_DETAIL },
      },
    };
    const compiledHtml = render(compiled);
    check('a compiled-executable entry still reports engine MATLAB',
      hasText(compiledHtml, 'MATLAB'));
    check('the compiled executable is reported through detail, unedited',
      hasText(compiledHtml, COMPILED_DETAIL),
      'the panel must print detail verbatim; that is what makes the compiler switch '
      + 'visible without adding a "matlab-compiled" engine value to the contract enum');
    check('switching to the compiler does not make the panel claim a fallback',
      !compiledHtml.includes('provenance-fallback-warning'),
      'the compiled executable is the primary engine, not a fallback');
  } finally {
    await server.close();
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error(`\nverify_provenance_ui.js crashed: ${e.stack || e.message}`); process.exit(1); });
