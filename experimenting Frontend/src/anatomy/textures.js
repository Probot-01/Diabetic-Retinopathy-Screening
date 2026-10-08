// Procedural textures for the anatomical eye, painted on 2D canvases.
//
// Nothing here depends on WebGL, so the fundus can also serve as the retina
// backdrop when the 3D view is unavailable. Dimensions follow typical adult
// anatomy for a right eye (OD), seen from the front: nasal is to the right.
import { rng, clamp, lerp, noise1 } from '../lib/math.js';

/** Inner radius of the retina, mm. The fundus map spans pole → equator. */
export const RETINA_R = 10.8;
const EDGE_MM = (RETINA_R * Math.PI) / 2;

/** Optic disc centre relative to the fovea, mm (x nasal, y superior). */
export const DISC = { x: 4.5, y: 0.4 };
/** The disc's position in the fundus texture. */
export const DISC_UV = { x: 0.5 + DISC.x / (2 * EDGE_MM), y: 0.5 + DISC.y / (2 * EDGE_MM) };

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function smoothLine(x, pts) {
  x.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    x.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
  }
  const l = pts[pts.length - 1];
  x.lineTo(l[0], l[1]);
}

// ── fundus ─────────────────────────────────────────────────────────────────

/**
 * A healthy right-eye fundus. The canvas centre is the fovea and its edge is
 * the equator, in azimuthal-equidistant projection (distance from the centre
 * is proportional to arc length along the retina).
 */
export function fundusCanvas(size) {
  const c = canvas(size);
  const x = c.getContext('2d');
  const R = rng(1906);
  const k = size / 2 / EDGE_MM; // px per mm
  const cx = size / 2;
  const cy = size / 2;
  const P = (mx, my) => [cx + mx * k, cy - my * k];

  const bg = x.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  bg.addColorStop(0, '#a63e1b');
  bg.addColorStop(0.18, '#b6481f');
  bg.addColorStop(0.45, '#aa411b');
  bg.addColorStop(0.75, '#862d13');
  bg.addColorStop(1, '#4a1509');
  x.fillStyle = bg;
  x.fillRect(0, 0, size, size);

  // Fine tissue grain, so the surface never reads as flat plastic.
  const tile = canvas(256);
  const tx = tile.getContext('2d');
  const img = tx.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 205 + R() * 50;
    img.data[i] = v;
    img.data[i + 1] = v * 0.93;
    img.data[i + 2] = v * 0.9;
    img.data[i + 3] = 255;
  }
  tx.putImageData(img, 0, 0);
  x.globalCompositeOperation = 'multiply';
  x.globalAlpha = 0.45;
  x.fillStyle = x.createPattern(tile, 'repeat');
  x.fillRect(0, 0, size, size);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';

  // Choroidal mottling and the faint choroidal vessels seen toward the periphery.
  for (let i = 0; i < 1400; i++) {
    const [px, py] = [R() * size, R() * size];
    x.fillStyle = R() < 0.5 ? 'rgba(96,22,8,0.05)' : 'rgba(236,128,66,0.035)';
    x.beginPath();
    x.arc(px, py, k * R.range(0.25, 1.1), 0, Math.PI * 2);
    x.fill();
  }
  x.lineCap = 'round';
  for (let i = 0; i < 160; i++) {
    const a = R() * Math.PI * 2;
    const d = R.range(5, 17);
    let [mx, my] = [Math.cos(a) * d, Math.sin(a) * d];
    let dir = a + R.gauss() * 0.8;
    const pts = [];
    for (let s = 0; s < 10; s++) {
      pts.push(P(mx, my));
      dir += R.gauss() * 0.35;
      mx += Math.cos(dir) * 0.9;
      my += Math.sin(dir) * 0.9;
    }
    x.strokeStyle = `rgba(110,26,12,${R.range(0.05, 0.1) * clamp((d - 4) / 8)})`;
    x.lineWidth = k * R.range(0.2, 0.45);
    x.beginPath();
    smoothLine(x, pts);
    x.stroke();
  }

  // Macula, fovea and the foveal light reflex.
  const [fx, fy] = P(0, 0);
  let g = x.createRadialGradient(fx, fy, 0, fx, fy, k * 3);
  g.addColorStop(0, 'rgba(78,18,6,0.62)');
  g.addColorStop(0.35, 'rgba(92,24,10,0.38)');
  g.addColorStop(1, 'rgba(92,24,10,0)');
  x.fillStyle = g;
  x.fillRect(fx - k * 3, fy - k * 3, k * 6, k * 6);
  g = x.createRadialGradient(fx, fy, 0, fx, fy, k * 0.8);
  g.addColorStop(0, 'rgba(58,12,4,0.55)');
  g.addColorStop(1, 'rgba(58,12,4,0)');
  x.fillStyle = g;
  x.fillRect(fx - k, fy - k, k * 2, k * 2);
  // The foveal light reflex: a faint, soft glint rather than a crisp dot,
  // which would read as an interface mark sitting behind the role choice.
  g = x.createRadialGradient(fx, fy, 0, fx, fy, k * 0.16);
  g.addColorStop(0, 'rgba(255,236,214,0.28)');
  g.addColorStop(1, 'rgba(255,236,214,0)');
  x.fillStyle = g;
  x.fillRect(fx - k * 0.2, fy - k * 0.2, k * 0.4, k * 0.4);

  // Optic disc: pale rim, peripapillary halo.
  const [dx, dy] = P(DISC.x, DISC.y);
  g = x.createRadialGradient(dx, dy, k * 0.7, dx, dy, k * 1.5);
  g.addColorStop(0, 'rgba(232,170,118,0.45)');
  g.addColorStop(1, 'rgba(232,170,118,0)');
  x.fillStyle = g;
  x.fillRect(dx - k * 1.6, dy - k * 1.6, k * 3.2, k * 3.2);
  x.save();
  x.translate(dx, dy);
  x.scale(0.88, 0.96);
  g = x.createRadialGradient(0, 0, 0, 0, 0, k);
  g.addColorStop(0, '#f0c48e');
  g.addColorStop(0.6, '#e8a874');
  g.addColorStop(0.9, '#d98c5c');
  g.addColorStop(1, 'rgba(200,110,70,0)');
  x.fillStyle = g;
  x.beginPath();
  x.arc(0, 0, k, 0, Math.PI * 2);
  x.fill();
  x.strokeStyle = 'rgba(70,18,8,0.22)';
  x.lineWidth = k * 0.06;
  x.beginPath();
  x.arc(0, 0, k * 1.02, 0, Math.PI * 2);
  x.stroke();
  x.restore();

  // Vessels. Arteries are narrower and brighter, with a thin central light
  // reflex; veins are wider and darker. Each generation of branches is
  // narrower than its parent, and none enter the foveal avascular zone.
  const vessels = [];
  const grow = (pts, w0, type, gen, r) => {
    const w1 = Math.max(0.018, w0 * 0.62);
    vessels.push({ pts, w0, w1, type });
    if (gen >= 4) return;
    let i = Math.floor(r.range(6, 14));
    while (i < pts.length - 4) {
      const cw = lerp(w0, w1, i / (pts.length - 1)) * r.range(0.55, 0.8);
      if (cw >= 0.02) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[i + 1];
        let dir = Math.atan2(by - ay, bx - ax) + (r() < 0.5 ? -1 : 1) * r.range(0.5, 1.05);
        let [mx, my] = [ax, ay];
        const child = [[mx, my]];
        const len = r.range(2, 7) * (1 - gen * 0.18);
        const bend = r.gauss() * 0.04;
        for (let s = 0; s < len / 0.25; s++) {
          dir += bend + r.gauss() * 0.07;
          mx += Math.cos(dir) * 0.25;
          my += Math.sin(dir) * 0.25;
          const d = Math.hypot(mx, my);
          if (d < 0.75 || d > EDGE_MM * 0.97) break;
          child.push([mx, my]);
        }
        if (child.length > 4) grow(child, cw, type, gen + 1, r);
      }
      i += Math.floor(r.range(8, 18) * (gen ? 0.7 : 1));
    }
  };
  // Smooth a trunk through its waypoints, then add a little natural tortuosity.
  const trunk = (way, off, seed) => {
    const pts = [];
    const c = [way[0], ...way, way[way.length - 1]];
    for (let i = 1; i < c.length - 2; i++) {
      const [p0, p1, p2, p3] = [c[i - 1], c[i], c[i + 1], c[i + 2]];
      const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 0.25));
      for (let j = 0; j < n; j++) {
        const t = j / n, t2 = t * t, t3 = t2 * t;
        pts.push([0, 1].map((q) =>
          0.5 * (2 * p1[q] + (-p0[q] + p2[q]) * t + (2 * p0[q] - 5 * p1[q] + 4 * p2[q] - p3[q]) * t2 + (-p0[q] + 3 * p1[q] - 3 * p2[q] + p3[q]) * t3),
        ));
      }
    }
    return pts.map(([px, py], i) => {
      const t = i / (pts.length - 1);
      const out = Math.sign(py || 1) * off * Math.min(1, t * 4);
      return [px, py + out + noise1(i * 0.08, seed) * 0.12 * Math.min(1, t * 3)];
    });
  };
  // The temporal arcades leave the disc steeply, then arch around the macula
  // about 4 mm above and below the fovea; the nasal vessels fan out radially.
  const arcades = [
    // superior temporal
    [[4.5, 0.5], [4.6, 1.5], [4.1, 2.8], [3.0, 3.8], [1.2, 4.4], [-1.0, 4.6], [-3.5, 4.4], [-6.5, 3.8], [-9.5, 3.2], [-13, 2.6], [-15.5, 2.2]],
    // inferior temporal
    [[4.5, 0.3], [4.6, -0.8], [4.1, -2.2], [3.0, -3.3], [1.2, -3.9], [-1.0, -4.1], [-3.5, -3.9], [-6.5, -3.4], [-9.5, -2.9], [-13, -2.4], [-15.5, -2.0]],
    // superior nasal
    [[4.7, 0.9], [5.4, 2.0], [6.2, 3.6], [7.4, 5.6], [9, 8], [10.5, 11], [11.5, 13.2]],
    // inferior nasal
    [[4.7, 0.0], [5.4, -1.1], [6.2, -2.8], [7.4, -4.8], [9, -7.2], [10.5, -10], [11.5, -12.4]],
  ];
  arcades.forEach((a, i) => {
    const big = i < 2;
    grow(trunk(a, 0.22, 11 + i), big ? 0.13 : 0.1, 'vein', 0, rng(11 + i));
    grow(trunk(a, -0.14, 51 + i), big ? 0.095 : 0.075, 'artery', 0, rng(51 + i));
  });
  // Fine macular branches from the arcades, stopping short of the fovea.
  for (let i = 0; i < 16; i++) {
    const up = i % 2 ? 1 : -1;
    let [mx, my] = [R.range(-3.4, 2.4), up * R.range(3.3, 3.8)];
    let dir = Math.atan2(-my, -mx * 0.3) + R.gauss() * 0.3;
    const pts = [[mx, my]];
    for (let s = 0; s < 12; s++) {
      dir += R.gauss() * 0.12;
      mx += Math.cos(dir) * 0.22;
      my += Math.sin(dir) * 0.22;
      if (Math.hypot(mx, my) < 0.8) break;
      pts.push([mx, my]);
    }
    if (pts.length > 4) vessels.push({ pts, w0: 0.03, w1: 0.018, type: i % 3 ? 'artery' : 'vein' });
  }

  const STYLE = {
    vein: { core: '#64140d', halo: 'rgba(96,20,10,0.16)' },
    artery: { core: '#a02816', halo: 'rgba(160,44,22,0.14)' },
  };
  const drawVessel = (v, pass) => {
    const px = v.pts.map(([a, b]) => P(a, b));
    const n = px.length;
    const step = 6;
    for (let i = 0; i < n - 1; i += step) {
      const j = Math.min(n - 1, i + step);
      const u = (i + j) / 2 / (n - 1);
      const w = lerp(v.w0, v.w1, u) * k * (u > 0.85 ? lerp(1, 0.4, (u - 0.85) / 0.15) : 1);
      const st = STYLE[v.type];
      if (pass === 0) {
        x.strokeStyle = st.halo;
        x.lineWidth = w * 2.2;
      } else if (pass === 1) {
        x.strokeStyle = st.core;
        x.lineWidth = Math.max(0.7, w);
      } else {
        if (v.type !== 'artery' || v.w0 < 0.05) return;
        x.strokeStyle = 'rgba(255,186,146,0.24)';
        x.lineWidth = Math.max(0.5, w * 0.24);
      }
      x.beginPath();
      smoothLine(x, px.slice(i, j + 1));
      x.stroke();
    }
  };
  x.lineJoin = 'round';
  x.lineCap = 'round';
  const veins = vessels.filter((v) => v.type === 'vein');
  const arteries = vessels.filter((v) => v.type === 'artery');
  for (const pass of [0, 1]) for (const v of veins) drawVessel(v, pass);
  for (const pass of [0, 1, 2]) for (const v of arteries) drawVessel(v, pass);

  // Masks for the living retina, read by the retina's shader at half
  // resolution: arteries in red, veins in green, and the nerve fibre layer.
  const ms = Math.round(size / 2);
  const vesselMask = canvas(ms);
  const vm = vesselMask.getContext('2d');
  vm.fillStyle = '#000';
  vm.fillRect(0, 0, ms, ms);
  vm.globalCompositeOperation = 'lighter';
  vm.lineCap = 'round';
  vm.lineJoin = 'round';
  const Q = (mx, my) => [ms / 2 + mx * k * 0.5, ms / 2 - my * k * 0.5];
  for (const v of vessels) {
    vm.strokeStyle = v.type === 'artery' ? '#ff0000' : '#00ff00';
    const px = v.pts.map(([a, b]) => Q(a, b));
    for (let i = 0; i < px.length - 1; i += 6) {
      const j = Math.min(px.length - 1, i + 6);
      vm.lineWidth = Math.max(1, lerp(v.w0, v.w1, (i + j) / 2 / (px.length - 1)) * k * 0.65);
      vm.beginPath();
      smoothLine(vm, px.slice(i, j + 1));
      vm.stroke();
    }
  }
  c.vesselMask = vesselMask;
  c.fibreMask = nerveFibreMask(ms, k * 0.5);

  // The cup, so the vessels appear to emerge from the centre of the disc.
  x.save();
  x.translate(dx - k * 0.08, dy);
  x.scale(0.33, 0.38);
  g = x.createRadialGradient(0, 0, 0, 0, 0, k);
  g.addColorStop(0, 'rgba(246,220,178,0.8)');
  g.addColorStop(0.7, 'rgba(240,206,160,0.55)');
  g.addColorStop(1, 'rgba(236,196,150,0)');
  x.fillStyle = g;
  x.beginPath();
  x.arc(0, 0, k, 0, Math.PI * 2);
  x.fill();
  x.restore();

  // Periphery falls off toward the equator.
  g = x.createRadialGradient(cx, cy, size * 0.3, cx, cy, size * 0.5);
  g.addColorStop(0, 'rgba(40,8,3,0)');
  g.addColorStop(1, 'rgba(40,8,3,0.55)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return c;
}

/**
 * The retinal nerve fibre layer: fibres from the temporal retina arch above
 * and below the macula to reach the disc; the rest run roughly straight in.
 * Red is fibre strength, green a per-fibre phase so signals don't march in step.
 */
function nerveFibreMask(ms, kk) {
  const c = canvas(ms);
  const x = c.getContext('2d');
  const R = rng(88);
  x.fillStyle = '#000';
  x.fillRect(0, 0, ms, ms);
  x.lineCap = 'round';
  const Q = (mx, my) => [ms / 2 + mx * kk, ms / 2 - my * kk];
  const fibre = (pts) => {
    x.strokeStyle = `rgb(${Math.round(R.range(90, 255))},${Math.round(R() * 255)},0)`;
    x.lineWidth = Math.max(1, kk * R.range(0.03, 0.06));
    x.beginPath();
    smoothLine(x, pts.map(([a, b]) => Q(a, b)));
    x.stroke();
  };
  for (let i = 0; i < 110; i++) {
    const sgn = i % 2 ? 1 : -1;
    const x0 = -R.range(1.5, 15);
    const y0 = sgn * R.range(0.15, 8) * Math.min(1, -x0 / 4 + 0.2);
    const bulge = sgn * (Math.abs(y0) + 2.2 + -x0 * 0.1);
    const end = [DISC.x - 0.8, DISC.y + sgn * R.range(0.2, 0.8)];
    const mid = [(x0 + end[0]) / 2, bulge];
    const pts = [];
    for (let s = 0; s <= 24; s++) {
      const t = s / 24;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const d = t * t;
      pts.push([a * x0 + b * mid[0] + d * end[0], a * y0 + b * mid[1] + d * end[1]]);
    }
    fibre(pts);
  }
  for (let i = 0; i < 70; i++) {
    const ang = R.range(-1.9, 1.9);
    const r0 = R.range(4, 15);
    const sx = DISC.x + Math.cos(ang) * r0;
    const sy = DISC.y + Math.sin(ang) * r0;
    const ex = DISC.x + Math.cos(ang) * 0.95;
    const ey = DISC.y + Math.sin(ang);
    const bend = R.gauss() * 0.6;
    fibre([[sx, sy], [(sx + ex) / 2 + bend, (sy + ey) / 2 - bend * 0.5], [ex, ey]]);
  }
  return c;
}

// ── iris, unwrapped ────────────────────────────────────────────────────────
// u runs around the iris; v runs from the root (v=0, canvas bottom) to the
// pupil margin (v=1, canvas top).

export function irisCanvas(w = 1024, h = 256) {
  const c = canvas(w, h);
  const x = c.getContext('2d');
  const R = rng(77);
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#4a2914');
  g.addColorStop(0.12, '#6a3d1d');
  g.addColorStop(0.36, '#b17a40');
  g.addColorStop(0.5, '#8d5a2d');
  g.addColorStop(0.85, '#6b4121');
  g.addColorStop(1, '#3a2211');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  for (let i = 0; i < 520; i++) {
    const u = R() * w;
    const light = R() < 0.4;
    x.strokeStyle = light ? `rgba(226,176,108,${R.range(0.12, 0.3)})` : `rgba(40,18,6,${R.range(0.12, 0.3)})`;
    x.lineWidth = R.range(0.8, 2.6);
    x.beginPath();
    const wob = R.range(-6, 6);
    x.moveTo(u, h * R.range(0.08, 0.3));
    x.quadraticCurveTo(u + wob, h * 0.6, u + R.range(-3, 3), h * R.range(0.85, 1));
    x.stroke();
  }
  // Collarette: the wavy ridge between pupillary and ciliary zones.
  x.strokeStyle = 'rgba(224,170,100,0.6)';
  x.lineWidth = 5;
  x.beginPath();
  for (let u = 0; u <= w; u += 8) {
    const y = h * 0.36 + Math.sin((u / w) * Math.PI * 2 * 11) * 6 + R.gauss() * 1.5;
    u ? x.lineTo(u, y) : x.moveTo(u, y);
  }
  x.stroke();
  // Crypts and contraction furrows.
  for (let i = 0; i < 38; i++) {
    x.fillStyle = `rgba(36,14,4,${R.range(0.3, 0.55)})`;
    x.beginPath();
    x.ellipse(R() * w, h * R.range(0.4, 0.62), R.range(4, 10), R.range(2, 5), 0, 0, Math.PI * 2);
    x.fill();
  }
  x.strokeStyle = 'rgba(40,18,6,0.25)';
  x.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const y = h * (0.7 + i * 0.07);
    x.beginPath();
    x.moveTo(0, y);
    for (let u = 0; u <= w; u += 16) x.lineTo(u, y + R.gauss() * 1.2);
    x.stroke();
  }
  // Pupillary ruff.
  x.fillStyle = '#1f0f06';
  x.fillRect(0, 0, w, 5);
  return c;
}

// ── sclera, choroid, muscle, nerve ─────────────────────────────────────────
// Lathe UVs: u runs around the axis (0 = inferior, 0.25 = nasal), v runs along
// the profile. Canvas top is v = 1.

export function scleraCanvas(kind, w = 1024, h = 512) {
  const c = canvas(w, h);
  const x = c.getContext('2d');
  const R = rng(kind === 'anterior' ? 3 : 4);
  const g = x.createLinearGradient(0, 0, 0, h);
  if (kind === 'anterior') {
    g.addColorStop(0, '#eef0ef');
    g.addColorStop(0.5, '#f3eee6');
    g.addColorStop(1, '#f1e8dc');
  } else {
    g.addColorStop(0, '#f1e8dc');
    g.addColorStop(1, '#eadcc7');
  }
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) {
    x.fillStyle = R() < 0.5 ? 'rgba(200,170,150,0.05)' : 'rgba(255,255,255,0.08)';
    x.beginPath();
    x.arc(R() * w, R() * h, R.range(3, 18), 0, Math.PI * 2);
    x.fill();
  }
  x.lineCap = 'round';
  const vessel = (u, v, dir, len, width, color) => {
    for (const wrap of [0, w, -w]) {
      let px = u + wrap;
      let py = v;
      let a = dir;
      x.strokeStyle = color;
      x.lineWidth = width;
      x.beginPath();
      x.moveTo(px, py);
      for (let s = 0; s < len; s++) {
        a += R.gauss() * 0.25;
        px += Math.cos(a) * 6;
        py += Math.sin(a) * 6;
        x.lineTo(px, py);
      }
      x.stroke();
    }
  };
  if (kind === 'anterior') {
    // Fine episcleral vessels running back from the limbus.
    for (let i = 0; i < 26; i++) vessel(R() * w, R.range(0, 20), Math.PI / 2 + R.gauss() * 0.3, R.range(12, 30), R.range(0.8, 1.6), `rgba(186,64,52,${R.range(0.18, 0.35)})`);
  } else {
    // Four vortex veins leave just behind the equator, one per oblique quadrant.
    for (const u of [0.125, 0.375, 0.625, 0.875]) {
      for (let j = 0; j < 3; j++) vessel(u * w + R.gauss() * 10, R.range(40, 70), -Math.PI / 2 + R.gauss() * 0.6, R.range(6, 12), R.range(1.5, 2.6), 'rgba(92,70,110,0.35)');
    }
    // Posterior ciliary vessels gathered toward the back of the globe.
    for (let i = 0; i < 18; i++) vessel(R() * w, h - R.range(0, 40), -Math.PI / 2 + R.gauss() * 0.4, R.range(8, 20), R.range(0.8, 1.5), `rgba(170,70,60,${R.range(0.15, 0.3)})`);
  }
  return c;
}

export function choroidCanvas(w = 1024, h = 512) {
  const c = canvas(w, h);
  const x = c.getContext('2d');
  const R = rng(8);
  x.fillStyle = '#4b140c';
  x.fillRect(0, 0, w, h);
  x.lineCap = 'round';
  for (let i = 0; i < 700; i++) {
    let px = R() * w;
    let py = R() * h;
    let a = Math.PI / 2 + R.gauss() * 0.9;
    x.strokeStyle = R() < 0.7 ? `rgba(168,44,26,${R.range(0.25, 0.5)})` : `rgba(30,6,3,${R.range(0.2, 0.4)})`;
    x.lineWidth = R.range(1, 4.5);
    x.beginPath();
    x.moveTo(px, py);
    for (let s = 0; s < 8; s++) {
      a += R.gauss() * 0.4;
      px += Math.cos(a) * 9;
      py += Math.sin(a) * 9;
      x.lineTo(px, py);
    }
    x.stroke();
  }
  return c;
}

/** Soft, tileable surface irregularity, used as a bump map. */
export function microCanvas(size = 256) {
  const c = canvas(size);
  const x = c.getContext('2d');
  const R = rng(5);
  x.fillStyle = '#808080';
  x.fillRect(0, 0, size, size);
  for (let i = 0; i < 700; i++) {
    const px = R() * size;
    const py = R() * size;
    const r = R.range(2, 10);
    const v = R() < 0.5 ? 255 : 0;
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(${v},${v},${v},0.14)`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    x.fillStyle = g;
    // Draw near-edge blobs again on the far side so the tile wraps seamlessly.
    for (const dx of px < r ? [0, size] : px > size - r ? [0, -size] : [0]) {
      for (const dy of py < r ? [0, size] : py > size - r ? [0, -size] : [0]) {
        x.save();
        x.translate(dx, dy);
        x.fillRect(px - r, py - r, r * 2, r * 2);
        x.restore();
      }
    }
  }
  return c;
}

export function fibreCanvas(w = 64, h = 256) {
  const c = canvas(w, h);
  const x = c.getContext('2d');
  const R = rng(12);
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, w, h);
  for (let i = 0; i < 90; i++) {
    const u = R() * w;
    x.strokeStyle = R() < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.4)';
    x.lineWidth = R.range(0.6, 1.6);
    x.beginPath();
    x.moveTo(u, 0);
    x.lineTo(u + R.gauss() * 2, h);
    x.stroke();
  }
  return c;
}

/** Cut face of the optic nerve: fascicles, with the central retinal artery and vein. */
export function nerveCapCanvas(size = 256) {
  const c = canvas(size);
  const x = c.getContext('2d');
  const R = rng(21);
  const r = size / 2;
  x.fillStyle = '#e9dcc4';
  x.beginPath();
  x.arc(r, r, r, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = '#d7c6a8';
  x.beginPath();
  x.arc(r, r, r * 0.8, 0, Math.PI * 2);
  x.fill();
  for (let i = 0; i < 110; i++) {
    const a = R() * Math.PI * 2;
    const d = Math.sqrt(R()) * r * 0.74;
    x.fillStyle = `rgba(246,236,214,${R.range(0.6, 0.95)})`;
    x.beginPath();
    x.arc(r + Math.cos(a) * d, r + Math.sin(a) * d, R.range(5, 10), 0, Math.PI * 2);
    x.fill();
  }
  x.fillStyle = '#b8322a';
  x.beginPath();
  x.arc(r - r * 0.09, r, r * 0.07, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = '#4a2a4e';
  x.beginPath();
  x.arc(r + r * 0.1, r + r * 0.02, r * 0.085, 0, Math.PI * 2);
  x.fill();
  return c;
}
