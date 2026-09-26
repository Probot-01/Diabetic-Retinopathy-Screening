'use strict';

/**
 * qualityGateFallback.js
 *
 * Pure-Node/JS re-implementation of quality-gate-matlab/qualityGateMain.m and
 * its four assess*.m helpers, used ONLY when MATLAB (and no compiled
 * QUALITY_GATE_EXE) is available on this machine.
 *
 * WHY THIS EXISTS: MATLAB is not installed on every dev machine on this team
 * (no license, no disk space), but the demo cannot depend on that. This module
 * ports the same decision logic and the same thresholds
 * (quality-gate-matlab/cameraPresets.json's 'default' preset) using `sharp`
 * for pixel access instead of the Image Processing Toolbox. It is NOT
 * pixel-identical to the MATLAB path (no exact regionprops/bwconvhull
 * equivalent here — see assessFovAndOcclusion below), but it runs the same
 * priority-ordered decision chain against the same six sub-scores, so a
 * genuinely blurry/dark/badly-framed image is still rejected for the right
 * reason instead of the whole gate silently no-op'ing to 'pass'.
 *
 * qualityGateClient.js calls this ONLY when spawning MATLAB fails to launch at
 * all (ENOENT — the interpreter is not on this machine). A real MATLAB error
 * (bad image, licence problem, non-zero exit) is NOT routed here — that stays
 * a real failure, unchanged, for the teammate who actually has MATLAB.
 */

const sharp = require('sharp');

// Same constants as cameraPresets.json's "default" preset — this module does
// not do per-camera presets, matching today's real behaviour (every device id
// falls back to 'default' anyway; see qualityGateMain.m's getPresetOrDefault).
const FOCUS_THRESHOLD = 0.17;
const ILLUMINATION_THRESHOLD = 0.4;

// Same normalisation constants as the MATLAB functions.
const FOCUS_NORM_CONST = 70;
const ILLUMINATION_TARGET = 100;
const FOV_TARGET_COVERAGE = 0.6;

/**
 * loadGrayscale(buffer)
 *
 * Decodes to raw 8-bit greyscale pixels via sharp (libvips), which is what
 * every score below operates on — the same starting point as MATLAB's
 * rgb2gray(imread(...)).
 */
async function loadGrayscale(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate() // respect EXIF orientation, same as a camera-facing MATLAB imread would see on screen
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { pixels: data, width: info.width, height: info.height };
}

/**
 * laplacianVariance(pixels, width, height)
 *
 * fspecial('laplacian', 0.2) applied with replicate-edge padding, then the
 * variance of the filtered image — assessFocus.m's algorithm exactly.
 */
function laplacianVariance(pixels, width, height) {
  // fspecial('laplacian', alpha) for alpha = 0.2:
  const a = 0.2;
  const corner = a / (a + 1);      // 0.1667
  const edge = (1 - a) / (a + 1);  // 0.6667
  const center = -4 / (a + 1);     // -3.3333

  const at = (x, y) => {
    const cx = Math.min(width - 1, Math.max(0, x));
    const cy = Math.min(height - 1, Math.max(0, y));
    return pixels[cy * width + cx];
  };

  let sum = 0;
  let sumSq = 0;
  const n = width * height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v =
        corner * at(x - 1, y - 1) + edge * at(x, y - 1) + corner * at(x + 1, y - 1) +
        edge   * at(x - 1, y)     + center * at(x, y)   + edge   * at(x + 1, y) +
        corner * at(x - 1, y + 1) + edge * at(x, y + 1) + corner * at(x + 1, y + 1);
      sum += v;
      sumSq += v * v;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function assessFocus(pixels, width, height) {
  const v = laplacianVariance(pixels, width, height);
  return { score: Math.min(1, v / FOCUS_NORM_CONST) };
}

function assessIllumination(pixels) {
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) sum += pixels[i];
  const mu = sum / pixels.length;
  return { score: Math.max(0, 1 - Math.abs(mu - ILLUMINATION_TARGET) / ILLUMINATION_TARGET) };
}

/**
 * retinalDiscMask(pixels, width, height)
 *
 * Approximates assessFOV.m's disc-detection: threshold at 15/255, fill holes,
 * keep only the largest connected component. Implemented as:
 *   1. background flood-fill from every border pixel with intensity <= 15
 *      (this both finds the background AND performs the hole-fill in one
 *      pass — any dark pixel NOT reached from the border is an enclosed
 *      "hole", i.e. a vessel or lesion inside the disc, and stays foreground).
 *   2. connected-component flood fill over the remaining foreground to find
 *      the largest component.
 *
 * This is not bwconvhull/regionprops, but it is the same three ideas
 * (threshold, fill interior holes, take the largest blob) and gives a
 * reasonable coveragePercent for a real fundus photo. Also reused as the
 * "disc" for the occlusion approximation below (see assessGlareMotionOcclusion).
 */
function retinalDiscMask(pixels, width, height) {
  const n = width * height;
  const THRESH = 15;
  // 0 = unknown/background, 1 = foreground-candidate, 2 = confirmed background
  const isDark = new Uint8Array(n);
  for (let i = 0; i < n; i++) isDark[i] = pixels[i] <= THRESH ? 1 : 0;

  const background = new Uint8Array(n); // 1 = reachable from border while dark
  const stack = [];
  const pushIfDarkAndUnvisited = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = y * width + x;
    if (isDark[idx] && !background[idx]) {
      background[idx] = 1;
      stack.push(idx);
    }
  };
  for (let x = 0; x < width; x++) { pushIfDarkAndUnvisited(x, 0); pushIfDarkAndUnvisited(x, height - 1); }
  for (let y = 0; y < height; y++) { pushIfDarkAndUnvisited(0, y); pushIfDarkAndUnvisited(width - 1, y); }

  while (stack.length) {
    const idx = stack.pop();
    const x = idx % width;
    const y = (idx / width) | 0;
    pushIfDarkAndUnvisited(x - 1, y);
    pushIfDarkAndUnvisited(x + 1, y);
    pushIfDarkAndUnvisited(x, y - 1);
    pushIfDarkAndUnvisited(x, y + 1);
  }

  // Foreground (filled) = everything that is not confirmed dark-background.
  const filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) filled[i] = background[i] ? 0 : 1;

  // Largest connected component over `filled`, iterative flood fill.
  const visited = new Uint8Array(n);
  let bestMask = null;
  let bestArea = 0;
  for (let start = 0; start < n; start++) {
    if (!filled[start] || visited[start]) continue;
    const compStack = [start];
    visited[start] = 1;
    const comp = [];
    while (compStack.length) {
      const idx = compStack.pop();
      comp.push(idx);
      const x = idx % width;
      const y = (idx / width) | 0;
      const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (filled[nIdx] && !visited[nIdx]) {
          visited[nIdx] = 1;
          compStack.push(nIdx);
        }
      }
    }
    if (comp.length > bestArea) {
      bestArea = comp.length;
      bestMask = comp;
    }
  }

  const discMask = new Uint8Array(n);
  if (bestMask) for (const idx of bestMask) discMask[idx] = 1;
  return { discMask, discArea: bestArea, totalPixels: n };
}

function assessFOVFromDisc(discArea, totalPixels) {
  const coveragePercent = totalPixels > 0 ? discArea / totalPixels : 0;
  return { coveragePercent, score: Math.min(1, coveragePercent / FOV_TARGET_COVERAGE) };
}

/**
 * assessGlareMotionOcclusion — glare + motion match assessGlareMotionOcclusion.m
 * exactly (both are simple pixel-wise / finite-difference statistics).
 * Occlusion reuses the disc mask from assessFOV above (see retinalDiscMask's
 * docstring) instead of a separate convex-hull-of-bright-region computation —
 * an approximation of the same "dark pixels inside the retinal disc" idea.
 */
function assessGlareMotionOcclusion(pixels, width, height, discMask, discArea) {
  // ── Glare: central 50%x50% ROI, fraction > 250 ──────────────────────────
  const r1 = Math.round(0.25 * height), r2 = Math.round(0.75 * height);
  const c1 = Math.round(0.25 * width), c2 = Math.round(0.75 * width);
  let saturated = 0, roiCount = 0;
  for (let y = r1; y < r2; y++) {
    for (let x = c1; x < c2; x++) {
      const v = pixels[y * width + x];
      roiCount++;
      if (v > 250) saturated++;
    }
  }
  const glareScore = roiCount > 0 ? saturated / roiCount : 0;

  // ── Motion: variance of horizontal vs vertical finite differences ───────
  let sumH = 0, sumSqH = 0, sumV = 0, sumSqV = 0;
  const n = width * height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = pixels[y * width + x];
      const left = pixels[y * width + Math.max(0, x - 1)];
      const up = pixels[Math.max(0, y - 1) * width + x];
      const dh = v - left;
      const dv = v - up;
      sumH += dh; sumSqH += dh * dh;
      sumV += dv; sumSqV += dv * dv;
    }
  }
  const meanH = sumH / n, meanV = sumV / n;
  const varH = sumSqH / n - meanH * meanH;
  const varV = sumSqV / n - meanV * meanV;
  const denom = Math.max(varH, varV);
  const motionScore = denom < 1e-10 ? 0 : Math.abs(varH - varV) / denom;

  // ── Occlusion: dark (<20) pixels inside the disc mask, over disc area ───
  let darkInDisc = 0;
  if (discArea > 0) {
    for (let i = 0; i < n; i++) {
      if (discMask[i] && pixels[i] < 20) darkInDisc++;
    }
  }
  const occlusionScore = discArea > 0 ? darkInDisc / discArea : 0;

  return { glareScore, motionScore, occlusionScore };
}

/**
 * runQualityGateFallback(imageBuffer)
 *
 * Explicitly refused: the JS algorithms diverged from the MATLAB path and gave
 * silently different decisions, so this tier is switched off.
 *
 * It THROWS rather than returning a verdict. It used to return
 * { status: 'retake', reason: 'MATLAB_UNAVAILABLE' } -- a made-up result: no
 * check had run, so the image had not failed anything, and 'MATLAB_UNAVAILABLE'
 * is not one of the contract's six quality reasons. A technician would have
 * been told to retake a photograph that may have been fine, over and over. A
 * throw is reported truthfully: POST /captures answers 503 quality_gate_failed,
 * the image is kept, and the capture can be re-checked once MATLAB (or the
 * compiled gate, QUALITY_GATE_EXE) is available.
 */
async function runQualityGateFallback(imageBuffer) { // eslint-disable-line no-unused-vars
  throw new Error(
    'the JS quality-gate fallback is switched off (its decisions diverged from the MATLAB gate), '
    + 'so no quality check could run. Install MATLAB or build the compiled gate (QUALITY_GATE_EXE).');
}

module.exports = { runQualityGateFallback };
