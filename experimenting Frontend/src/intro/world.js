// The rural scene: a hand-drawn field with a farmer at work.
//
// The static illustration is painted twice with the same random seed — once in
// watercolour, once in graphite greys — so the two frames line up stroke for
// stroke. The blink reveals the colour frame through a soft circle that grows
// out of the eye. Only the farmer, grass and birds are redrawn every frame.
import { rng, clamp, lerp, smoothstep, noise1, mixHex, ease } from '../lib/math.js';

const INK = '#231e18';

const COLOUR = {
  paper: '#f3eee4',
  skyTop: '#86add0',
  skyMid: '#bcd2dd',
  skyLow: '#f4d7a8',
  sun: '#f8cf73',
  hillFar: '#a3b6c6',
  hillMid: '#8ea893',
  treeLine: '#6d8f58',
  treeDark: '#436c3c',
  treeMid: '#6a954d',
  treeLight: '#9cbb66',
  trunk: '#6d4a30',
  soilFar: '#d6b98c',
  soil: '#bf966a',
  soilNear: '#a07650',
  soilWorked: '#7c5836',
  crop: '#6c9b43',
  cropLight: '#a5c263',
  hutWall: '#dcc196',
  thatch: '#b38b52',
  door: '#5b4330',
  skin: '#8a583a',
  kurta: '#e6e8e2',
  dhoti: '#efe7d5',
  turban: '#d65b27',
  gamcha: '#b8342a',
  wood: '#8a6843',
  blade: '#55575b',
  grassA: '#6e983e',
  grassB: '#b8a54e',
  grassC: '#89ae4b',
};

function toMono(hex, lift) {
  const n = parseInt(hex.slice(1), 16);
  const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  const v = Math.round((lift + (1 - lift) * l) * 255);
  const h = (x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0');
  return `#${h(v)}${h(v * 0.99)}${h(v * 0.96)}`;
}

const MONO = Object.fromEntries(Object.entries(COLOUR).map(([k, v]) => [k, toMono(v, 0.5)]));
MONO.paper = COLOUR.paper;
// Grass and figures read as pencil in the sketch, so keep them darker.
for (const k of ['grassA', 'grassB', 'grassC']) MONO[k] = toMono(COLOUR[k], 0.12);

// ── drawing helpers ────────────────────────────────────────────────────────

function smooth(ctx, p, close = false) {
  const n = p.length;
  if (n < 2) return;
  if (close) {
    const m0 = [(p[n - 1][0] + p[0][0]) / 2, (p[n - 1][1] + p[0][1]) / 2];
    ctx.moveTo(m0[0], m0[1]);
    for (let i = 0; i < n; i++) {
      const a = p[i];
      const b = p[(i + 1) % n];
      ctx.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    }
    ctx.closePath();
    return;
  }
  ctx.moveTo(p[0][0], p[0][1]);
  if (n === 2) {
    ctx.lineTo(p[1][0], p[1][1]);
    return;
  }
  for (let i = 1; i < n - 1; i++) {
    ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
  }
  ctx.lineTo(p[n - 1][0], p[n - 1][1]);
}

/** Ink line drawn twice with a slight tremor, like a pen going back over it. */
function sketch(ctx, pts, R, { w = 1.1, a = 0.85, j = 0.6, close = false, color = INK } = {}) {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let k = 0; k < 2; k++) {
    const jj = j * (k ? 1.5 : 0.45);
    ctx.globalAlpha = k ? a * 0.4 : a;
    ctx.lineWidth = k ? w * 0.65 : w;
    ctx.beginPath();
    smooth(ctx, pts.map(([x, y]) => [x + R.gauss() * jj, y + R.gauss() * jj]), close);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function deform(pts, amt, R, depth = 2) {
  let p = pts;
  for (let d = 0; d < depth; d++) {
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      out.push([a[0] + R.gauss() * amt * 0.3, a[1] + R.gauss() * amt * 0.3]);
      out.push([(a[0] + b[0]) / 2 + R.gauss() * amt, (a[1] + b[1]) / 2 + R.gauss() * amt]);
    }
    p = out;
    amt *= 0.55;
  }
  return p;
}

/** Watercolour wash: several translucent, slightly different fills. */
function wash(ctx, pts, color, R, { layers = 4, alpha = 0.22, spread = 4 } = {}) {
  ctx.fillStyle = color;
  for (let l = 0; l < layers; l++) {
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    smooth(ctx, deform(pts, spread, R), true);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function ellipsePts(cx, cy, rx, ry, n = 18, rot = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    out.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return out;
}

/** Short parallel pencil strokes inside a clip polygon. */
function hatch(ctx, poly, R, { angle = -0.9, gap = 5, a = 0.28, w = 0.8 } = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  ctx.save();
  ctx.beginPath();
  smooth(ctx, poly, true);
  ctx.clip();
  ctx.strokeStyle = INK;
  ctx.lineWidth = w;
  ctx.globalAlpha = a;
  const diag = Math.hypot(x1 - x0, y1 - y0);
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  ctx.beginPath();
  for (let s = -diag / 2; s < diag / 2; s += gap * R.range(0.8, 1.25)) {
    const px = cx - dy * s, py = cy + dx * s;
    const len = diag * 0.5 * R.range(0.7, 1);
    ctx.moveTo(px - dx * len + R.gauss(), py - dy * len);
    ctx.lineTo(px + dx * len, py + dy * len + R.gauss());
  }
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}

let grainTile = null;
function grain() {
  if (grainTile) return grainTile;
  const c = document.createElement('canvas');
  c.width = c.height = 180;
  const x = c.getContext('2d');
  const img = x.createImageData(180, 180);
  const R = rng(99);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 150 + R() * 105;
    img.data[i] = v;
    img.data[i + 1] = v * 0.98;
    img.data[i + 2] = v * 0.94;
    img.data[i + 3] = R() < 0.5 ? 18 : 6;
  }
  x.putImageData(img, 0, 0);
  grainTile = c;
  return c;
}

// ── layout ─────────────────────────────────────────────────────────────────

export function computeLayout(W, H) {
  const portrait = W / H < 0.9;
  const m = Math.min(W, H);
  const hy = H * 0.6;
  const ew = portrait ? Math.min(W * 0.6, H * 0.3, 300) : Math.min(W * 0.27, H * 0.36, 440);
  return {
    W,
    H,
    portrait,
    hy,
    eye: { x: W * 0.5, y: H * (portrait ? 0.28 : 0.3), w: ew },
    farmer: { x: W * (portrait ? 0.66 : 0.67), y: H * (portrait ? 0.87 : 0.855), h: H * (portrait ? 0.24 : 0.3) },
    // On a phone the tree stays low and to the side, clear of the name.
    tree: { x: W * (portrait ? -0.02 : 0.12), y: hy + H * 0.05, s: H * (portrait ? 0.24 : 0.44) },
    sun: { x: W * (portrait ? 0.84 : 0.8), y: hy - H * 0.16, r: m * 0.042 },
    hut: { x: W * 0.3, y: hy + H * 0.012, s: H * 0.05 },
    vpx: W * 0.53,
  };
}

// ── static illustration ───────────────────────────────────────────────────

function ridge(W, base, amp, seed, valley) {
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const u = i / 40;
    const v = valley ? Math.abs(u - 0.5) * 2 : 1;
    const y = base - amp * (0.35 + 0.65 * v ** 1.4) * (0.75 + 0.35 * noise1(u * 5, seed)) - amp * 0.12 * noise1(u * 17, seed + 3);
    pts.push([u * W * 1.1 - W * 0.05, y]);
  }
  return pts;
}

function paintScene(ctx, L, P) {
  const { W, H, hy } = L;
  const R = rng(20260914);
  const k = H / 900;

  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = P.paper;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'multiply';

  // Sky: a graded wash with a few uneven brush passes.
  const sky = ctx.createLinearGradient(0, 0, 0, hy);
  sky.addColorStop(0, P.skyTop);
  sky.addColorStop(0.55, P.skyMid);
  sky.addColorStop(1, P.skyLow);
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, hy + 6);
  for (let i = 0; i < 10; i++) {
    const y = R.range(0, hy * 0.7);
    const h = R.range(14, 46) * k;
    const x0 = R.range(-0.3, 0.5) * W;
    const x1 = x0 + R.range(0.4, 0.9) * W;
    wash(ctx, [[x0, y + h * 0.5], [lerp(x0, x1, 0.3), y], [x1, y + h * 0.4], [lerp(x0, x1, 0.6), y + h]], P.skyTop, R, {
      layers: 1,
      alpha: 0.05,
      spread: 14 * k,
    });
  }

  // Sun and its glow.
  const { sun } = L;
  ctx.globalCompositeOperation = 'source-over';
  const glow = ctx.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, sun.r * 7);
  glow.addColorStop(0, 'rgba(255, 244, 214, 0.75)');
  glow.addColorStop(1, 'rgba(255, 244, 214, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(sun.x - sun.r * 7, sun.y - sun.r * 7, sun.r * 14, sun.r * 14);
  ctx.globalCompositeOperation = 'multiply';
  wash(ctx, ellipsePts(sun.x, sun.y, sun.r, sun.r, 20), P.sun, R, { layers: 3, alpha: 0.5, spread: 1.5 * k });

  // Hills.
  const far = ridge(W, hy - H * 0.02, H * 0.12, 1, true);
  wash(ctx, [...far, [W * 1.05, hy + 4], [-W * 0.05, hy + 4]], P.hillFar, R, { layers: 3, alpha: 0.3, spread: 3 * k });
  const mid = ridge(W, hy + H * 0.005, H * 0.07, 7, true);
  wash(ctx, [...mid, [W * 1.05, hy + 6], [-W * 0.05, hy + 6]], P.hillMid, R, { layers: 3, alpha: 0.35, spread: 3 * k });

  // Field: soil graded from hazy distance to rich foreground.
  const soil = ctx.createLinearGradient(0, hy, 0, H);
  soil.addColorStop(0, P.soilFar);
  soil.addColorStop(0.45, P.soil);
  soil.addColorStop(1, P.soilNear);
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = soil;
  ctx.fillRect(0, hy, W, H - hy);
  ctx.globalAlpha = 1;

  // Crop rows converging on the horizon.
  const vp = [L.vpx, hy - H * 0.035];
  const rows = [];
  const spacing = Math.max(W, H * 1.2) / 13;
  for (let x = L.vpx - spacing * 16; x <= L.vpx + spacing * 16; x += spacing) rows.push(x);
  const rowAt = (xb, t) => {
    const y0 = hy + 3;
    const t0 = (y0 - vp[1]) / (H - vp[1]);
    const tt = lerp(t0, 1, t);
    return [lerp(vp[0], xb, tt), lerp(vp[1], H, tt)];
  };
  rows.forEach((xb, i) => {
    if (i % 2) return;
    const w0 = spacing * 0.28;
    const poly = [];
    for (let s = 0; s <= 12; s++) poly.push(rowAt(xb - w0, s / 12));
    for (let s = 12; s >= 0; s--) poly.push(rowAt(xb + w0, s / 12));
    wash(ctx, poly, P.crop, R, { layers: 2, alpha: 0.22, spread: 1.5 * k });
  });

  // Freshly worked soil in front of the farmer, and his shadow.
  const F = L.farmer;
  wash(ctx, ellipsePts(F.x - F.h * 0.42, F.y + F.h * 0.01, F.h * 0.55, F.h * 0.05, 20), P.soilWorked, R, {
    layers: 3,
    alpha: 0.28,
    spread: 4 * k,
  });
  wash(ctx, ellipsePts(F.x - F.h * 0.02, F.y + F.h * 0.005, F.h * 0.2, F.h * 0.025, 16), P.soilWorked, R, {
    layers: 2,
    alpha: 0.35,
    spread: 2 * k,
  });

  // Distant tree line and a hut.
  const clumps = [];
  for (let x = -10; x < W + 10; x += R.range(10, 26) * k) {
    if (Math.abs(x - L.eye.x) < L.eye.w * 0.25 && R() < 0.6) continue;
    const r = R.range(3, 9) * k;
    clumps.push([x, hy - r * 0.6, r]);
  }
  for (const [x, y, r] of clumps) wash(ctx, ellipsePts(x, y, r * 1.3, r, 10), P.treeLine, R, { layers: 2, alpha: 0.35, spread: 1.2 * k });

  const hut = L.hut;
  const hw = hut.s * 1.3;
  const wall = [[hut.x - hw / 2, hut.y], [hut.x + hw / 2, hut.y], [hut.x + hw / 2, hut.y - hut.s * 0.55], [hut.x - hw / 2, hut.y - hut.s * 0.55]];
  const roof = [[hut.x - hw * 0.68, hut.y - hut.s * 0.5], [hut.x + hw * 0.68, hut.y - hut.s * 0.5], [hut.x + hw * 0.18, hut.y - hut.s * 1.05], [hut.x - hw * 0.18, hut.y - hut.s * 1.05]];
  wash(ctx, wall, P.hutWall, R, { layers: 2, alpha: 0.5, spread: 0.8 * k });
  wash(ctx, roof, P.thatch, R, { layers: 3, alpha: 0.45, spread: 0.8 * k });

  // The big tree.
  const T = L.tree;
  const trunk = [
    [T.x - T.s * 0.05, T.y],
    [T.x - T.s * 0.022, T.y - T.s * 0.28],
    [T.x - T.s * 0.03, T.y - T.s * 0.5],
    [T.x + T.s * 0.03, T.y - T.s * 0.5],
    [T.x + T.s * 0.026, T.y - T.s * 0.28],
    [T.x + T.s * 0.06, T.y],
  ];
  wash(ctx, trunk, P.trunk, R, { layers: 3, alpha: 0.45, spread: 1.2 * k });
  const blobs = [];
  for (let i = 0; i < 22; i++) {
    const a = R.range(Math.PI * 1.02, Math.PI * 1.98);
    const d = Math.sqrt(R());
    blobs.push([
      T.x + T.s * 0.03 + Math.cos(a) * T.s * 0.34 * d,
      T.y - T.s * 0.56 + Math.sin(a) * T.s * 0.26 * d + T.s * 0.04,
      T.s * R.range(0.07, 0.12),
    ]);
  }
  blobs.sort((a, b) => a[1] - b[1]);
  for (const [x, y, r] of blobs) {
    const shade = (x - T.x) / (T.s * 0.35) + (y - (T.y - T.s * 0.6)) / (T.s * 0.3);
    const c = shade > 0.6 ? P.treeDark : shade < -0.4 ? P.treeLight : P.treeMid;
    wash(ctx, ellipsePts(x, y, r * 1.15, r, 14), c, R, { layers: 3, alpha: 0.3, spread: r * 0.12 });
  }
  wash(ctx, ellipsePts(T.x + T.s * 0.08, T.y + T.s * 0.005, T.s * 0.3, T.s * 0.03, 16), P.soilWorked, R, {
    layers: 2,
    alpha: 0.25,
    spread: 3 * k,
  });

  // ── ink pass ──
  ctx.globalCompositeOperation = 'source-over';

  // Clouds as a few quick horizontal wisps.
  for (let i = 0; i < 5; i++) {
    const cx = R.range(0.05, 0.95) * W;
    const cy = R.range(0.08, 0.36) * hy;
    if (Math.abs(cx - L.eye.x) < L.eye.w * 0.9 && Math.abs(cy - L.eye.y) < L.eye.w * 0.5) continue;
    const len = R.range(60, 150) * k;
    for (let j = 0; j < 3; j++) {
      const y = cy + j * 5 * k;
      const x0 = cx - len / 2 + R.range(-10, 20) * k;
      sketch(ctx, [[x0, y], [x0 + len * 0.4, y - 3 * k], [x0 + len * (0.8 - j * 0.15), y - 1 * k]], R, { w: 0.8, a: 0.28 });
    }
  }

  sketch(ctx, ellipsePts(sun.x, sun.y, sun.r, sun.r, 22), R, { w: 1, a: 0.55, close: true });
  sketch(ctx, far, R, { w: 0.9, a: 0.35 });
  sketch(ctx, mid, R, { w: 1, a: 0.5 });
  sketch(ctx, [[-10, hy + 1], [W * 0.5, hy - 1], [W + 10, hy + 1]], R, { w: 0.8, a: 0.3 });

  for (const [x, y, r] of clumps) {
    if (R() < 0.55) sketch(ctx, [[x - r * 1.2, y + r * 0.4], [x - r * 0.6, y - r * 0.8], [x + r * 0.5, y - r * 0.9], [x + r * 1.2, y + r * 0.3]], R, { w: 0.7, a: 0.4 });
  }

  sketch(ctx, wall, R, { w: 0.9, a: 0.7, close: true });
  sketch(ctx, roof, R, { w: 1, a: 0.75, close: true });
  for (let i = 1; i < 7; i++) {
    const u = i / 7;
    sketch(ctx, [lerp2(roof[3], roof[2], u), lerp2(roof[0], roof[1], u * 0.9 + 0.05)], R, { w: 0.6, a: 0.35 });
  }
  const door = [[hut.x - hw * 0.08, hut.y], [hut.x - hw * 0.08, hut.y - hut.s * 0.34], [hut.x + hw * 0.1, hut.y - hut.s * 0.34], [hut.x + hw * 0.1, hut.y]];
  ctx.fillStyle = P.door;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  smooth(ctx, door, true);
  ctx.fill();
  ctx.globalAlpha = 1;

  sketch(ctx, trunk.slice(0, 3), R, { w: 1.3, a: 0.8 });
  sketch(ctx, trunk.slice(3), R, { w: 1.3, a: 0.8 });
  for (let i = 0; i < 4; i++) {
    const a = -Math.PI / 2 + (i - 1.5) * 0.45;
    const x0 = T.x, y0 = T.y - T.s * 0.45;
    sketch(ctx, [[x0, y0], [x0 + Math.cos(a) * T.s * 0.1, y0 + Math.sin(a) * T.s * 0.12], [x0 + Math.cos(a) * T.s * 0.2, y0 + Math.sin(a) * T.s * 0.18]], R, { w: 1, a: 0.6 });
  }
  hatch(ctx, trunk, R, { angle: -1.2, gap: 3.2 * k, a: 0.22 });
  for (const [x, y, r] of blobs) {
    const a0 = R.range(Math.PI * 0.9, Math.PI * 1.3);
    const pts = [];
    for (let s = 0; s <= 8; s++) {
      const a = a0 + (s / 8) * Math.PI * 1.25;
      pts.push([x + Math.cos(a) * r * 1.1, y + Math.sin(a) * r * 0.95]);
    }
    sketch(ctx, pts, R, { w: 0.9, a: 0.55 });
  }

  // Furrows and crop tufts.
  rows.forEach((xb, i) => {
    const pts = [];
    for (let s = 0; s <= 10; s++) pts.push(rowAt(xb, s / 10));
    sketch(ctx, pts, R, { w: 0.7, a: i % 2 ? 0.22 : 0.12, j: 0.4 });
    if (i % 2) return;
    const n = 22;
    for (let s = 1; s < n; s++) {
      const t = (s / n) ** 1.7;
      const [x, y] = rowAt(xb + R.gauss() * spacing * 0.05 * t, t);
      if (x < -20 || x > W + 20) continue;
      if (Math.abs(x - (F.x - F.h * 0.4)) < F.h * 0.6 && Math.abs(y - F.y) < F.h * 0.08) continue;
      const sz = (2 + 16 * t) * k;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.5 + 0.7 * t;
      ctx.globalAlpha = 0.28 + 0.35 * t;
      ctx.beginPath();
      for (let b = -1; b <= 1; b++) {
        ctx.moveTo(x + b * sz * 0.12, y);
        ctx.quadraticCurveTo(x + b * sz * 0.2, y - sz * 0.5, x + b * sz * 0.45 + R.gauss() * sz * 0.08, y - sz);
      }
      ctx.stroke();
      if (t > 0.3) {
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = P.cropLight;
        ctx.beginPath();
        ctx.ellipse(x, y - sz * 0.45, sz * 0.4, sz * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  });
  ctx.globalAlpha = 1;

  // Hoe marks in the worked patch.
  for (let i = 0; i < 9; i++) {
    const x = F.x - F.h * R.range(0.05, 0.9);
    const y = F.y + F.h * R.range(-0.03, 0.04);
    sketch(ctx, [[x - F.h * 0.04, y], [x + F.h * 0.04, y + F.h * 0.004]], R, { w: 0.8, a: 0.35 });
  }

  // Paper grain and a gentle vignette over everything.
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = ctx.createPattern(grain(), 'repeat');
  ctx.fillRect(0, 0, W, H);
  const vig = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.35, W / 2, H * 0.45, Math.hypot(W, H) * 0.62);
  vig.addColorStop(0, 'rgba(255,255,255,0)');
  vig.addColorStop(1, 'rgba(200,185,165,0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
}

const lerp2 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

// ── farmer ─────────────────────────────────────────────────────────────────
// Local units: 1 = standing height, y up, facing left (forward is -x).

// Key poses of one hoe stroke. `top` is the end of the handle the hands hold;
// `ang` is the handle's direction (degrees, y up) from there to the blade.
const POSES = {
  raised: { hip: [0.05, 0.476], sh: [-0.09, 0.715], head: [-0.16, 0.795], top: [-0.2, 0.62], ang: 100 },
  down: { hip: [0.035, 0.452], sh: [-0.23, 0.58], head: [-0.335, 0.6], top: [-0.3, 0.36], ang: 207 },
  pulled: { hip: [0.06, 0.468], sh: [-0.15, 0.625], head: [-0.25, 0.672], top: [-0.17, 0.38], ang: 209 },
};
const HANDLE = 0.62;
const STROKE = 2.4; // seconds per stroke
const IMPACT = 0.47; // fraction of the stroke where the blade bites

/** Which two poses to blend at time t, and how far. */
function strokeAt(t) {
  const u = (((t % STROKE) + STROKE) % STROKE) / STROKE;
  if (u < 0.36) return ['pulled', 'raised', ease.inOutSine(u / 0.36)];
  if (u < IMPACT) return ['raised', 'down', ease.inCubic((u - 0.36) / (IMPACT - 0.36))];
  if (u < 0.53) return ['down', 'down', 0];
  if (u < 0.8) return ['down', 'pulled', ease.inOutSine((u - 0.53) / 0.27)];
  return ['pulled', 'pulled', 0];
}

function ik(s, h, l1, l2, pick) {
  const dx = h[0] - s[0];
  const dy = h[1] - s[1];
  const d = Math.min(Math.hypot(dx, dy), l1 + l2 - 1e-4);
  const a = Math.atan2(dy, dx);
  const off = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  const e1 = [s[0] + l1 * Math.cos(a + off), s[1] + l1 * Math.sin(a + off)];
  const e2 = [s[0] + l1 * Math.cos(a - off), s[1] + l1 * Math.sin(a - off)];
  return pick(e1, e2);
}

function limb(a, b, wa, wb) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return [
    [a[0] + nx * wa, a[1] + ny * wa],
    [b[0] + nx * wb, b[1] + ny * wb],
    [b[0] - nx * wb, b[1] - ny * wb],
    [a[0] - nx * wa, a[1] - ny * wa],
  ];
}

function farmerPose(t) {
  // Raise the hoe overhead, swing it down into the soil, draw the soil back
  // toward the feet, breathe, repeat.
  const [a, b, k] = strokeAt(t);
  const A = POSES[a];
  const B = POSES[b];
  const P = {};
  for (const key of ['hip', 'sh', 'head', 'top']) P[key] = lerp2(A[key], B[key], k);
  const ang = (lerp(A.ang, B.ang, k) * Math.PI) / 180;
  const d = [Math.cos(ang), Math.sin(ang)];
  P.dir = d;
  P.end = [P.top[0] + d[0] * HANDLE, P.top[1] + d[1] * HANDLE];
  // The blade sits roughly square to the handle, facing the farmer's side.
  const bn = ang + (63 * Math.PI) / 180;
  P.bladeN = [Math.cos(bn), Math.sin(bn)];
  P.tip = [P.end[0] + P.bladeN[0] * 0.075, P.end[1] + P.bladeN[1] * 0.075];
  P.handN = [P.top[0] + d[0] * 0.03, P.top[1] + d[1] * 0.03];
  P.handF = [P.top[0] + d[0] * 0.12, P.top[1] + d[1] * 0.12];
  P.footF = [-0.13, 0];
  P.footB = [0.15, 0];
  const front = (e1, e2) => (e1[0] < e2[0] ? e1 : e2);
  // Elbows tuck back and down, toward the ribs.
  const tuck = (e1, e2) => (e1[0] - e1[1] > e2[0] - e2[1] ? e1 : e2);
  P.kneeF = ik(P.hip, P.footF, 0.245, 0.25, front);
  P.kneeB = ik([P.hip[0] + 0.02, P.hip[1]], P.footB, 0.245, 0.25, front);
  P.shF = [P.sh[0] + 0.025, P.sh[1] + 0.012];
  P.elbowN = ik(P.sh, P.handN, 0.19, 0.18, tuck);
  P.elbowF = ik(P.shF, P.handF, 0.19, 0.18, tuck);
  return P;
}

/** Soil thrown up where the blade bites, fading within half a second. */
function drawClods(ctx, F, t, c) {
  const n = Math.floor(t / STROKE);
  let since = t - (n * STROKE + IMPACT * STROKE);
  let cycle = n;
  if (since < 0) {
    since += STROKE;
    cycle -= 1;
  }
  if (since > 0.55) return;
  const P = POSES.down;
  const ang = (P.ang * Math.PI) / 180;
  const end = [P.top[0] + Math.cos(ang) * HANDLE, P.top[1] + Math.sin(ang) * HANDLE];
  const bn = ang + (63 * Math.PI) / 180;
  const tip = [end[0] + Math.cos(bn) * 0.075, end[1] + Math.sin(bn) * 0.075];
  const R = rng(1000 + cycle);
  ctx.fillStyle = mixHex(MONO.soilWorked, COLOUR.soilWorked, c);
  for (let i = 0; i < 8; i++) {
    const a = R() < 0.5 ? R.range(1.75, 2.9) : R.range(0.35, 1.3);
    const v = R.range(0.22, 0.48);
    const x = tip[0] + Math.cos(a) * v * since;
    const y = Math.max(0, tip[1] + Math.sin(a) * v * since - 1.7 * since * since);
    ctx.globalAlpha = (1 - since / 0.55) * 0.85;
    ctx.beginPath();
    ctx.arc(F.x + x * F.h, F.y - y * F.h, F.h * R.range(0.004, 0.009), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawFarmer(ctx, F, t, c) {
  const P = farmerPose(t);
  const s = F.h;
  const X = (p) => [F.x + p[0] * s, F.y - p[1] * s];
  const col = (k) => mixHex(MONO[k], COLOUR[k], c);
  const lw = Math.max(0.8, s / 230);

  const shape = (pts, fill, { a = 1, stroke = true, closePath = true } = {}) => {
    ctx.beginPath();
    smooth(ctx, pts.map(X), closePath);
    ctx.globalAlpha = a;
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (stroke) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  };
  const joint = (p, r, fill) => {
    const [x, y] = X(p);
    ctx.beginPath();
    ctx.arc(x, y, r * s, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const skin = col('skin');
  const skinFar = mixHex(toMono(COLOUR.skin, 0.35), '#6c4128', c);

  // Far leg and far arm sit behind the body.
  shape(limb(P.kneeB, P.footB, 0.022, 0.017), skinFar);
  shape(limb(P.shF, P.elbowF, 0.028, 0.024), mixHex(toMono(COLOUR.kurta, 0.3), '#c9ccc5', c));
  shape(limb(P.elbowF, P.handF, 0.021, 0.016), skinFar);
  joint(P.handF, 0.022, skinFar);

  // Dhoti over both thighs.
  const hip = P.hip;
  const dhoti = [
    [hip[0] + 0.085, hip[1] + 0.02],
    [hip[0] - 0.07, hip[1] + 0.03],
    [P.kneeF[0] - 0.05, P.kneeF[1] - 0.02],
    [P.kneeF[0] - 0.01, P.kneeF[1] - 0.06],
    [P.kneeB[0] + 0.02, P.kneeB[1] - 0.07],
    [P.kneeB[0] + 0.06, P.kneeB[1] - 0.01],
  ];
  shape(dhoti, col('dhoti'));

  // Near shin and feet.
  shape(limb(P.kneeF, P.footF, 0.024, 0.018), skin);
  shape([[P.footF[0] + 0.02, 0.012], [P.footF[0] - 0.07, 0.004], [P.footF[0] - 0.068, -0.006], [P.footF[0] + 0.025, -0.006]], skin);
  shape([[P.footB[0] + 0.02, 0.012], [P.footB[0] - 0.065, 0.004], [P.footB[0] - 0.062, -0.006], [P.footB[0] + 0.024, -0.006]], skinFar);

  // Kurta torso, following the bent spine.
  const sp = [P.sh[0] - hip[0], P.sh[1] - hip[1]];
  const sl = Math.hypot(sp[0], sp[1]);
  const fwd = [-sp[1] / sl, sp[0] / sl]; // belly side
  const bk = [-fwd[0], -fwd[1]];
  const at = (u, n, d) => [lerp(hip[0], P.sh[0], u) + n[0] * d, lerp(hip[1], P.sh[1], u) + n[1] * d];
  const torso = [
    at(-0.18, bk, 0.085),
    at(0.35, bk, 0.092),
    at(0.9, bk, 0.075),
    at(1.08, bk, 0.035),
    at(1.08, fwd, 0.035),
    at(0.9, fwd, 0.06),
    at(0.45, fwd, 0.075),
    at(-0.14, fwd, 0.085),
  ];
  shape(torso, col('kurta'));
  hatch(ctx, torso.map(X).slice(0, 4).concat([X(at(0.4, [0, 0], 0))]), rng(3), { angle: -0.4, gap: Math.max(2, s * 0.012), a: 0.18, w: 0.7 });

  // Handle and blade, then the near arm over it.
  const [tx, ty] = X(P.top);
  const [ex, ey] = X(P.end);
  ctx.strokeStyle = INK;
  ctx.lineWidth = lw * 3.2;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.strokeStyle = col('wood');
  ctx.lineWidth = lw * 1.8;
  ctx.stroke();
  const d = P.dir;
  const n = P.bladeN;
  const bA = [P.end[0] - d[0] * 0.012, P.end[1] - d[1] * 0.012];
  const bB = [P.end[0] + d[0] * 0.03, P.end[1] + d[1] * 0.03];
  shape([bA, bB, [bB[0] + n[0] * 0.068, bB[1] + n[1] * 0.068], [bA[0] + n[0] * 0.08, bA[1] + n[1] * 0.08]], col('blade'), {
    closePath: true,
  });

  shape(limb(P.sh, P.elbowN, 0.034, 0.028), col('kurta'));
  shape(limb(P.elbowN, P.handN, 0.023, 0.018), skin);
  joint(P.handN, 0.024, skin);

  // Gamcha over the near shoulder.
  const g0 = [P.sh[0] + 0.03, P.sh[1] + 0.035];
  shape([g0, [P.sh[0] - 0.05, P.sh[1] + 0.02], [P.sh[0] - 0.035, P.sh[1] - 0.13], [P.sh[0] + 0.0, P.sh[1] - 0.12]], col('gamcha'));

  // Head, tilted down toward the work, under a turban.
  const hd = P.head;
  const tilt = Math.atan2(hd[1] - P.sh[1], hd[0] - P.sh[0]);
  const neck = limb(lerp2(P.sh, hd, 0.2), lerp2(P.sh, hd, 0.7), 0.022, 0.02);
  shape(neck, skin);
  const face = ellipsePts(hd[0], hd[1], 0.052, 0.06, 16, 0).map(([x, y]) => [x, y]);
  // A small nose bump on the forward side.
  const nose = [hd[0] + Math.cos(tilt) * 0.062, hd[1] + Math.sin(tilt) * 0.062 - 0.012];
  face.splice(8, 1, nose);
  shape(face, skin);
  const tb = ellipsePts(hd[0] + 0.012, hd[1] + 0.03, 0.066, 0.042, 16, 0.25);
  shape(tb, col('turban'));
  const knot = ellipsePts(hd[0] + 0.058, hd[1] + 0.012, 0.022, 0.026, 10);
  shape(knot, col('turban'));
  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = lw * 0.8;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    const [ax, ay] = X([hd[0] - 0.045, hd[1] + 0.025 + i * 0.016]);
    const [cx, cy] = X([hd[0] + 0.01, hd[1] + 0.06 + i * 0.01]);
    const [ex, ey] = X([hd[0] + 0.065, hd[1] + 0.03 + i * 0.008]);
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(cx, cy, ex, ey);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ── grass and birds ────────────────────────────────────────────────────────

function buildGrass(L) {
  const { W, H, farmer: F } = L;
  const R = rng(42);
  const n = Math.round(W / (L.portrait ? 4 : 4.6));
  const blades = [];
  for (let i = 0; i < n; i++) {
    const x = R() * W * 1.04 - W * 0.02;
    const edge = Math.abs(x / W - 0.5) * 2;
    const tall = 0.25 + 0.75 * edge ** 1.3;
    const h = H * (0.025 + 0.13 * tall * R.range(0.45, 1));
    blades.push({
      x,
      y: H + 2,
      h,
      w: R.range(1.1, 2.4) * Math.sqrt(h / (H * 0.08)),
      lean: R.range(-0.12, 0.22),
      ph: R() * Math.PI * 2,
      c: ['grassA', 'grassB', 'grassC'][Math.floor(R() * 3)],
      ear: edge > 0.45 && R() < 0.22,
    });
  }
  // A few short tufts around the farmer's feet so he stands in the crop, not on it.
  for (let i = 0; i < 26; i++) {
    const x = F.x + F.h * R.range(-0.5, 0.35);
    blades.push({
      x,
      y: F.y + F.h * R.range(0.0, 0.03),
      h: F.h * R.range(0.04, 0.09),
      w: R.range(0.9, 1.6),
      lean: R.range(-0.15, 0.2),
      ph: R() * Math.PI * 2,
      c: 'grassC',
      ear: false,
    });
  }
  blades.sort((a, b) => a.y - b.y);
  return blades;
}

function drawGrass(ctx, blades, t, gust, colourAt) {
  for (const b of blades) {
    const idle = 0.07 * Math.sin(t * 1.4 + b.ph + b.x * 0.004) + 0.03 * Math.sin(t * 2.3 + b.ph * 1.7);
    const bend = clamp(b.lean + idle + gust(b.x), -0.6, 0.85);
    const tipX = b.x + bend * b.h;
    const tipY = b.y - b.h * (1 - 0.35 * bend * bend);
    const cx = b.x + bend * b.h * 0.25;
    const cy = b.y - b.h * 0.6;
    const c = colourAt(b.x, b.y - b.h * 0.5);
    ctx.fillStyle = mixHex(MONO[b.c], COLOUR[b.c], c);
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    ctx.moveTo(b.x - b.w * 0.5, b.y);
    ctx.quadraticCurveTo(cx - b.w * 0.25, cy, tipX, tipY);
    ctx.quadraticCurveTo(cx + b.w * 0.35, cy, b.x + b.w * 0.5, b.y);
    ctx.fill();
    if (b.ear) {
      ctx.fillStyle = mixHex(MONO.grassB, '#c9a54a', c);
      const dx = (tipX - cx) / b.h;
      for (let e = 0; e < 5; e++) {
        const u = e * 0.035 * b.h;
        ctx.beginPath();
        ctx.ellipse(tipX - dx * u * 2, tipY + u, b.w * 0.9, b.w * 1.8, bend * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;
}

function buildBirds(L) {
  const R = rng(5);
  const T = L.tree;
  return Array.from({ length: 5 }, (_, i) => ({
    x0: T.x + T.s * R.range(-0.1, 0.25),
    y0: T.y - T.s * R.range(0.55, 0.75),
    vx: L.W * R.range(0.028, 0.045),
    vy: -L.H * R.range(0.012, 0.03),
    delay: i * 0.18 + R() * 0.2,
    f: R.range(2.6, 3.4),
    s: Math.max(5, L.H * R.range(0.007, 0.011)),
    ph: R() * 6,
  }));
}

function drawBirds(ctx, birds, t, L) {
  ctx.strokeStyle = INK;
  ctx.lineCap = 'round';
  for (const b of birds) {
    const u = t - b.delay;
    if (u < 0) continue;
    // Quick take-off that settles into a slow glide across the sky.
    const k = 1 - Math.exp(-u * 0.9);
    const x = b.x0 + b.vx * (u * 0.55 + k * 3);
    const y = b.y0 + b.vy * (k * 6) + Math.sin(u * 0.7 + b.ph) * L.H * 0.006;
    if (x > L.W + 40) continue;
    const flap = Math.sin(u * b.f * Math.PI * 2);
    ctx.globalAlpha = clamp(u * 3) * 0.85;
    ctx.lineWidth = Math.max(1, b.s * 0.16);
    ctx.beginPath();
    ctx.moveTo(x - b.s, y - b.s * 0.35 * flap);
    ctx.quadraticCurveTo(x - b.s * 0.45, y - b.s * 0.35 - b.s * 0.4 * flap, x, y);
    ctx.quadraticCurveTo(x + b.s * 0.45, y - b.s * 0.35 - b.s * 0.4 * flap, x + b.s, y - b.s * 0.35 * flap);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ── public ─────────────────────────────────────────────────────────────────

export function createWorld(container) {
  // Two layers: the illustration, repainted only while the colour spreads,
  // and the living things on top of it, redrawn every frame.
  const bgCanvas = container.querySelector('.world-bg');
  const fgCanvas = container.querySelector('.world-fg');
  const ctx = bgCanvas.getContext('2d');
  const fg = fgCanvas.getContext('2d');
  let L, dpr, frameMono, frameColour, temp, tctx, blades, birds;
  let bloom = { x: 0, y: 0, r: 0, soft: 1 };
  let painted = -1;

  const makeCanvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    return c;
  };

  function resize(W, H) {
    const px = W * H;
    dpr = Math.min(window.devicePixelRatio || 1, px > 1.6e6 ? 1.25 : 1.75);
    for (const c of [bgCanvas, fgCanvas]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    painted = -1;
    L = computeLayout(W, H);
    frameMono = makeCanvas(W, H);
    frameColour = makeCanvas(W, H);
    temp = makeCanvas(W, H);
    tctx = temp.getContext('2d');
    for (const [f, P] of [[frameMono, MONO], [frameColour, COLOUR]]) {
      const c = f.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintScene(c, L, P);
    }
    blades = buildGrass(L);
    birds = buildBirds(L);
    return L;
  }

  const colourAt = (x, y) => {
    if (bloom.r <= 0) return 0;
    const d = Math.hypot(x - bloom.x, y - bloom.y);
    return 1 - smoothstep(bloom.r - bloom.soft, bloom.r, d);
  };

  function paintBackground(full) {
    const { W, H } = L;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (bloom.r <= 0) ctx.drawImage(frameMono, 0, 0);
    else if (full) ctx.drawImage(frameColour, 0, 0);
    else {
      ctx.drawImage(frameMono, 0, 0);
      tctx.globalCompositeOperation = 'source-over';
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, temp.width, temp.height);
      tctx.drawImage(frameColour, 0, 0);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = tctx.createRadialGradient(bloom.x, bloom.y, Math.max(0, bloom.r - bloom.soft), bloom.x, bloom.y, bloom.r);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      tctx.fillStyle = g;
      tctx.fillRect(0, 0, W, H);
      tctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(temp, 0, 0);
    }
  }

  /**
   * @param {object} s
   * @param {number} s.t          scene clock (s)
   * @param {number} s.farmerT    the farmer's own clock (s)
   * @param {number} s.bloomR     radius of the colour reveal around the eye
   * @param {number} s.gustFront  x position of the breeze front, for the grass
   * @param {number} s.birdsT     seconds since the birds took off, or <0
   * @param {object} [s.focus]    darkness closing in around {x, y, r, soft}
   */
  function render(s) {
    const { W, H } = L;
    bloom = { x: L.eye.x, y: L.eye.y, r: s.bloomR, soft: Math.min(W, H) * 0.45 };
    const reach = Math.hypot(W, H) + bloom.soft;
    const full = s.bloomR > reach;
    const key = full ? Infinity : s.bloomR;
    if (key !== painted) {
      paintBackground(full);
      painted = key;
    }

    fg.setTransform(1, 0, 0, 1, 0, 0);
    fg.clearRect(0, 0, fgCanvas.width, fgCanvas.height);
    fg.setTransform(dpr, 0, 0, dpr, 0, 0);
    const F = L.farmer;
    const fc = colourAt(F.x - F.h * 0.1, F.y - F.h * 0.4);
    drawFarmer(fg, F, s.farmerT, fc);
    drawClods(fg, F, s.farmerT, fc);
    const gust = (x) => {
      const d = (x - s.gustFront) / (W * 0.16);
      const passed = clamp((s.gustFront - x) / (W * 0.4));
      return 0.5 * Math.exp(-d * d) + 0.1 * passed * (1 + 0.5 * Math.sin(s.t * 3 + x * 0.01));
    };
    drawGrass(fg, blades, s.t, gust, colourAt);
    if (s.birdsT >= 0) drawBirds(fg, birds, s.birdsT, L);

    // A band of warm light rides the edge of the colour as it spreads.
    if (s.bloomR > 0 && !full) {
      const a = 0.2 * Math.sqrt(1 - s.bloomR / reach);
      const r0 = Math.max(0, s.bloomR - bloom.soft * 0.95);
      const r1 = Math.max(r0 + 1, s.bloomR - bloom.soft * 0.05);
      const g = fg.createRadialGradient(bloom.x, bloom.y, r0, bloom.x, bloom.y, r1);
      g.addColorStop(0, 'rgba(255,228,176,0)');
      g.addColorStop(0.72, `rgba(255,226,170,${a.toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,226,170,0)');
      fg.fillStyle = g;
      fg.fillRect(0, 0, W, H);
    }

    // Moving into the eye: darkness closes in, the world narrows to the eye.
    if (s.focus) {
      const { x, y, r, soft } = s.focus;
      const g = fg.createRadialGradient(x, y, Math.max(0, r - soft), x, y, r);
      g.addColorStop(0, 'rgba(13,12,11,0)');
      g.addColorStop(1, 'rgba(13,12,11,1)');
      fg.fillStyle = g;
      fg.fillRect(0, 0, W, H);
    }
  }

  return { resize, render, get layout() { return L; } };
}
