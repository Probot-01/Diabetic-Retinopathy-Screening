#!/usr/bin/env node
/**
 * Mobile quality gate vs MATLAB: do they make the same decision?
 *
 *   node --experimental-strip-types verify_mobile_quality_gate_parity.mjs
 *
 * The Expo app runs its own port of quality-gate-matlab/qualityGateMain.m
 * (phc-local-app/mobile/netrasetu/lib/quality/qualityGate.ts), because MATLAB
 * Runtime cannot run on a phone. Two implementations of one decision drift --
 * the desktop's JS fallback did, and was switched off for it -- so this runs
 * both on the same pixels and compares:
 *
 *   - status and reason: must be identical (that is what the technician acts on)
 *   - each of the seven sub-scores: reported with its difference; a score
 *     that differs by more than SCORE_TOL fails
 *
 * Fixtures: every image in demo_images/ and datasets/, plus synthetic
 * degradations of one of them built to trip each rejection branch (blur, dark,
 * glare, motion, small field of view, eyelash occlusion). All are written as
 * lossless RGB PNG first, so MATLAB's imread and the app's decoder (fast-png)
 * see identical pixels and any difference is the algorithm's. Each is run
 * under both camera presets ('default' and 'mobile_lens').
 *
 * Needs MATLAB + Image Processing Toolbox on PATH (`matlab -batch`). Reports
 * SKIP, not PASS, when MATLAB is missing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sharp = require(path.join(ROOT, 'phc-local-app/backend/node_modules/sharp'));
const GATE_DIR = path.join(ROOT, 'phc-local-app/backend/quality-gate-matlab');
const MOBILE = path.join(ROOT, 'phc-local-app/mobile');
const { decode } = await import(pathToFileURL(path.join(MOBILE, 'node_modules/fast-png/lib/index.js')).href);
const gate = await import(pathToFileURL(path.join(MOBILE, 'netrasetu/lib/quality/qualityGate.ts')).href);

const SCORE_TOL = 0.01;
const PRESETS = ['default', 'mobile_lens'];
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'netrasetu-qg-parity-'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ── Fixtures ────────────────────────────────────────────────────────────────
async function toPng(src, name, fn) {
  const file = path.join(OUT, `${name}.png`);
  let img = sharp(src).rotate().removeAlpha().toColourspace('srgb');
  if (fn) img = await fn(img);
  await img.png({ compressionLevel: 6 }).toFile(file);
  return file;
}

async function buildFixtures() {
  const sources = [];
  for (const dir of ['demo_images', 'datasets']) {
    const d = path.join(ROOT, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) {
      if (/\.(jpe?g|png|webp|bmp)$/i.test(f)) sources.push({ src: path.join(d, f), name: `${dir}_${path.parse(f).name}` });
    }
  }
  const files = [];
  for (const s of sources) files.push(await toPng(s.src, s.name));

  // Degradations of one good image, each aimed at one branch of the chain.
  const base = path.join(ROOT, 'demo_images/1_quality_pass.jpg');
  const meta = await sharp(base).metadata();
  const W = meta.width, H = meta.height;
  files.push(await toPng(base, 'synthetic_blur', (i) => i.blur(8)));
  files.push(await toPng(base, 'synthetic_dark', (i) => i.linear(0.25, 0)));
  // Between the two presets' thresholds: retake under 'default', not under
  // 'mobile_lens' -- the only fixtures where the preset changes the answer.
  files.push(await toPng(base, 'synthetic_preset_mild_blur', (i) => i.blur(1.1)));
  files.push(await toPng(base, 'synthetic_preset_mild_dark', (i) => i.linear(0.38, 0)));
  files.push(await toPng(base, 'synthetic_motion', (i) =>
    // Horizontal motion blur. sharp needs odd sides >= 3, so a 31x3 kernel
    // whose top and bottom rows are zero.
    i.convolve({ width: 31, height: 3, kernel: [...new Array(31).fill(0), ...new Array(31).fill(1 / 31), ...new Array(31).fill(0)] })));
  files.push(await toPng(base, 'synthetic_small_fov', async (i) => {
    const small = await i.resize(Math.round(W * 0.55), Math.round(H * 0.55)).png().toBuffer();
    return sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .composite([{ input: small, gravity: 'centre' }]);
  }));
  files.push(await toPng(base, 'synthetic_glare', async (i) => {
    const cw = Math.round(W * 0.42), ch = Math.round(H * 0.42);
    return i.composite([{ input: { create: { width: cw, height: ch, channels: 3, background: { r: 255, g: 255, b: 255 } } }, gravity: 'centre' }]);
  }));
  files.push(await toPng(base, 'synthetic_eyelash', async (i) => {
    // A dark, roughly square shadow over the upper disc, as a drooping eyelid
    // casts. Square so it adds horizontal and vertical edges equally and does
    // not trip the (earlier) motion check instead.
    const side = Math.round(Math.min(W, H) * 0.5);
    return i.composite([{ input: { create: { width: side, height: side, channels: 3, background: { r: 3, g: 2, b: 2 } } },
      top: Math.round(H * 0.12), left: Math.round((W - side) / 2) }]);
  }));
  return files;
}

// ── MATLAB side ─────────────────────────────────────────────────────────────
function runMatlab(files) {
  const listFile = path.join(OUT, 'files.txt');
  const resultFile = path.join(OUT, 'matlab_results.json');
  fs.writeFileSync(listFile, files.join('\n'));
  const script = [
    `addpath('${GATE_DIR.replace(/\\/g, '/')}');`,
    `files = splitlines(strtrim(fileread('${listFile.replace(/\\/g, '/')}')));`,
    `presets = {${PRESETS.map((p) => `'${p}'`).join(', ')}};`,
    'out = {};',
    'for i = 1:numel(files)',
    '  for p = 1:numel(presets)',
    '    r = qualityGateMain(char(files{i}), presets{p});',
    '    out{end+1} = struct(\'file\', files{i}, \'preset\', presets{p}, \'status\', r.status, \'reason\', string(r.reason), \'scores\', r.scores);',
    '  end',
    'end',
    `fid = fopen('${resultFile.replace(/\\/g, '/')}', 'w'); fwrite(fid, jsonencode(out)); fclose(fid);`,
  ].join('\n');
  execFileSync('matlab', ['-batch', script], { stdio: 'inherit', timeout: 20 * 60 * 1000 });
  return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
}

// ── App side ────────────────────────────────────────────────────────────────
function runPort(file, preset) {
  const png = decode(fs.readFileSync(file));
  const g = gate.toGray(png.data, png.width, png.height, png.channels, png.depth);
  return gate.runQualityGateOnGray(g, preset);
}

// ── Main ────────────────────────────────────────────────────────────────────
console.log('\n--- Mobile quality gate (TS port) vs MATLAB qualityGateMain.m ---');
try {
  execFileSync('matlab', ['-batch', 'exit'], { stdio: 'ignore', timeout: 5 * 60 * 1000 });
} catch {
  console.log('  SKIP  MATLAB is not on PATH; nothing to compare against');
  process.exit(0);
}

const files = await buildFixtures();
console.log(`  ${files.length} images x ${PRESETS.length} presets, fixtures in ${OUT}`);
const matlab = runMatlab(files);

const worst = {};
for (const m of matlab) {
  const name = `${path.parse(m.file).name} [${m.preset}]`;
  const js = runPort(m.file, m.preset);
  // MATLAB encodes the empty reason ([]) as '' or [] -- normalise to null,
  // as qualityGateClient.parseGateOutput does in production.
  const mReason = !m.reason || m.reason === '' || (Array.isArray(m.reason) && m.reason.length === 0) ? null : m.reason;
  m.reason = mReason;
  const same = m.status === js.status && mReason === js.reason;
  check(`${name}: ${m.status}${mReason ? `/${mReason}` : ''}`, same,
    `matlab=${m.status}/${mReason}  port=${js.status}/${js.reason}`);
  for (const [k, a] of Object.entries(m.scores)) {
    const d = Math.abs(Number(a) - js.scores[k]);
    worst[k] = Math.max(worst[k] ?? 0, d);
    if (d > SCORE_TOL) check(`${name}: ${k}`, false, `matlab=${Number(a).toFixed(5)} port=${js.scores[k].toFixed(5)} diff=${d.toFixed(5)}`);
  }
}

console.log('\n  Largest per-score difference across all images:');
for (const [k, d] of Object.entries(worst)) console.log(`    ${k.padEnd(18)} ${d.toExponential(2)}`);
const reasons = new Set(matlab.map((m) => (m.reason ? 'retake/' + m.reason : m.status)));
console.log(`  Decisions exercised: ${[...reasons].join(', ')}`);
const byFile = new Map();
for (const m of matlab) byFile.set(m.file, [...(byFile.get(m.file) ?? []), `${m.status}/${m.reason}`]);
const presetSensitive = [...byFile.values()].filter((v) => new Set(v).size > 1).length;
check(`the camera preset changes the MATLAB decision on ${presetSensitive} image(s) (presets are exercised)`, presetSensitive > 0);

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
