// The breeze and the eye it becomes.
//
// Each eye strand runs along a "track": a flowing wind path that ends exactly
// where one of the eye's curves begins, followed by that curve. The strand
// slides along its track and its tail stops at the start of the curve, so the
// wind visibly lays itself down into the eyelids and the iris. Once a strand
// has settled it is drawn from the live eye geometry, which is what lets the
// eye look around, blink and later round out into the anatomical globe.
import { clamp, lerp, rng, smoothstep } from '../lib/math.js';

export const INK = '#1f1b16';

const bez = (a, b, c, d, s) => {
  const u = 1 - s;
  const k0 = u * u * u, k1 = 3 * u * u * s, k2 = 3 * u * s * s, k3 = s * s * s;
  return [k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0], k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1]];
};

/** Globe radius relative to the visible iris radius (12 mm / 5.85 mm). */
export const GLOBE_PER_IRIS = 12 / 5.85;

export function eyeGeometry(E) {
  const { x, y, w } = E;
  const b = E.blink || 0;
  const lk = E.look || 0;
  const g = E.globe || 0;
  const shift = lk * 0.045 * w;
  const P0 = [x - 0.5 * w, y + 0.015 * w];
  const P3 = [x + 0.5 * w, y - 0.005 * w];
  // Closed, the upper lid comes all the way down to meet the lower lid.
  const P1 = [x - 0.24 * w + shift, lerp(y - 0.34 * w, y + 0.166 * w, b)];
  const P2 = [x + 0.2 * w + shift, lerp(y - 0.355 * w, y + 0.153 * w, b)];
  const Q1 = [x - 0.22 * w + shift * 0.5, y + 0.2 * w - 0.03 * w * b];
  const Q2 = [x + 0.23 * w + shift * 0.5, y + 0.185 * w - 0.03 * w * b];
  // The crease sits just above the lid and drops with it into the closed lid's curve.
  const C0 = [x - 0.36 * w, y - 0.14 * w + 0.1 * w * b];
  const C1 = [x - 0.2 * w + shift, lerp(y - 0.4 * w, y - 0.1 * w, b)];
  const C2 = [x + 0.22 * w + shift, lerp(y - 0.41 * w, y - 0.11 * w, b)];
  const C3 = [x + 0.44 * w, y - 0.12 * w + 0.1 * w * b];
  const r = 0.205 * w;
  const ix = x + lk * 0.17 * w;
  const iy = y + 0.012 * w + (E.lookY || 0) * 0.05 * w;
  const Rg = E.globeR ?? r * GLOBE_PER_IRIS;
  const toGlobe = (p, s, sign) => {
    if (!g) return p;
    const a = Math.PI * s;
    return [lerp(p[0], ix - Rg * Math.cos(a), g), lerp(p[1], iy + sign * Rg * Math.sin(a), g)];
  };
  return {
    upper: (s) => toGlobe(bez(P0, P1, P2, P3, s), s, -1),
    lower: (s) => toGlobe(bez(P0, Q1, Q2, P3, s), s, 1),
    crease: (s) => bez(C0, C1, C2, C3, s),
    iris: { x: ix, y: iy, r },
    pupilR: r * (E.pupil || 0.42),
    globeR: Rg,
  };
}

function curveOf(geo, spec) {
  if (spec.curve === 'iris') {
    const { x, y, r } = geo.iris;
    const R = r + spec.off;
    // Starts at the top of the iris heading right — the direction the breeze
    // is already travelling when it arrives.
    return (s) => {
      const a = -Math.PI / 2 + Math.PI * 2 * 1.03 * s;
      return [x + R * Math.cos(a), y + R * Math.sin(a)];
    };
  }
  return geo[spec.curve];
}

function sample(fn, n, off = 0) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    let p = fn(s);
    if (off) {
      const a = fn(Math.max(0, s - 0.01));
      const b = fn(Math.min(1, s + 0.01));
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      p = [p[0] - (dy / l) * off, p[1] + (dx / l) * off];
    }
    pts.push(p);
  }
  return pts;
}

/**
 * Centripetal Catmull-Rom through ctrl[1..n-2]. Unlike the uniform form it
 * never loops or cusps when neighbouring points are unevenly spaced.
 */
function catmull(ctrl) {
  const out = [];
  const knot = (a, b) => Math.max(1e-4, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5);
  const mix = (a, b, ta, tb, t) => {
    const u = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  for (let i = 1; i < ctrl.length - 2; i++) {
    const [p0, p1, p2, p3] = [ctrl[i - 1], ctrl[i], ctrl[i + 1], ctrl[i + 2]];
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const per = clamp(Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 7), 3, 80);
    for (let j = 0; j < per; j++) {
      const t = t1 + ((t2 - t1) * j) / per;
      const a1 = mix(p0, p1, 0, t1, t);
      const a2 = mix(p1, p2, t1, t2, t);
      const a3 = mix(p2, p3, t2, t3, t);
      const b1 = mix(a1, a2, 0, t2, t);
      const b2 = mix(a2, a3, t1, t3, t);
      out.push(mix(b1, b2, t1, t2, t));
    }
  }
  out.push(ctrl[ctrl.length - 2]);
  return out;
}

function makeTrack(pts, approachCount) {
  const n = pts.length;
  const cum = new Float32Array(n);
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    nx[i] = -dy / l;
    ny[i] = dx / l;
  }
  return { pts, cum, nx, ny, total: cum[n - 1], approachLen: cum[Math.max(0, approachCount - 1)] };
}

/** Points of the track between arc lengths a and b, with an optional wave. */
function between(track, a, b, wave) {
  const { pts, cum, nx, ny } = track;
  const out = [];
  const n = pts.length;
  const at = (s) => {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < s) lo = mid; else hi = mid;
    }
    const f = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
    return { i: lo, f };
  };
  const push = (i, f, s) => {
    const j = Math.min(n - 1, i + 1);
    let x = lerp(pts[i][0], pts[j][0], f);
    let y = lerp(pts[i][1], pts[j][1], f);
    if (wave) {
      const d = wave(s);
      x += lerp(nx[i], nx[j], f) * d;
      y += lerp(ny[i], ny[j], f) * d;
    }
    out.push([x, y]);
  };
  const A = at(a), B = at(b);
  push(A.i, A.f, a);
  for (let i = A.i + 1; i <= B.i; i++) push(i, 0, cum[i]);
  push(B.i, B.f, b);
  return out;
}

function strokeStrand(ctx, pts, w, alpha, color, taper) {
  const n = pts.length;
  if (n < 2 || alpha <= 0.002) return;
  const chunks = Math.min(14, n - 1);
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  for (let c = 0; c < chunks; c++) {
    const i0 = Math.floor((c * (n - 1)) / chunks);
    const i1 = Math.floor(((c + 1) * (n - 1)) / chunks);
    const u = (c + 0.5) / chunks;
    const tw = clamp(Math.min(u / taper, (1 - u) / taper));
    ctx.lineWidth = w * (0.2 + 0.8 * tw);
    ctx.beginPath();
    ctx.moveTo(pts[i0][0], pts[i0][1]);
    for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function makeIrisTexture(r, dpr, colourful) {
  const size = Math.ceil(r * 2 * dpr) + 2;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  x.scale(size / (r * 2), size / (r * 2));
  const R = rng(31);
  const g = x.createRadialGradient(r, r, r * 0.28, r, r, r);
  const stops = colourful
    ? ['#c08a4a', '#9a6534', '#74461f', '#3e2513']
    : ['#d2ccc2', '#b4ada2', '#958d82', '#5f5850'];
  g.addColorStop(0, stops[0]);
  g.addColorStop(0.4, stops[1]);
  g.addColorStop(0.82, stops[2]);
  g.addColorStop(1, stops[3]);
  x.fillStyle = g;
  x.beginPath();
  x.arc(r, r, r, 0, Math.PI * 2);
  x.fill();
  // Radial stromal fibres.
  x.lineCap = 'round';
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * Math.PI * 2 + R.gauss() * 0.01;
    const r0 = r * R.range(0.3, 0.4);
    const r1 = r * R.range(0.78, 0.98);
    const bend = R.gauss() * 0.05;
    x.strokeStyle = i % 3 === 0 ? (colourful ? 'rgba(236,190,120,0.35)' : 'rgba(255,255,255,0.35)') : colourful ? 'rgba(50,25,10,0.28)' : 'rgba(30,26,22,0.3)';
    x.lineWidth = r * R.range(0.008, 0.02);
    x.beginPath();
    x.moveTo(r + Math.cos(a) * r0, r + Math.sin(a) * r0);
    x.quadraticCurveTo(r + Math.cos(a + bend) * (r0 + r1) / 2, r + Math.sin(a + bend) * (r0 + r1) / 2, r + Math.cos(a) * r1, r + Math.sin(a) * r1);
    x.stroke();
  }
  // Collarette.
  x.strokeStyle = colourful ? 'rgba(224,176,108,0.55)' : 'rgba(250,248,240,0.5)';
  x.lineWidth = r * 0.03;
  x.beginPath();
  for (let i = 0; i <= 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const rr = r * (0.55 + 0.03 * Math.sin(a * 9 + 1) + 0.015 * R.gauss());
    i ? x.lineTo(r + Math.cos(a) * rr, r + Math.sin(a) * rr) : x.moveTo(r + Math.cos(a) * rr, r + Math.sin(a) * rr);
  }
  x.stroke();
  // Crypts.
  for (let i = 0; i < 12; i++) {
    const a = R() * Math.PI * 2;
    const d = r * R.range(0.6, 0.8);
    x.fillStyle = colourful ? 'rgba(45,22,8,0.35)' : 'rgba(40,36,32,0.3)';
    x.beginPath();
    x.ellipse(r + Math.cos(a) * d, r + Math.sin(a) * d, r * 0.05, r * 0.022, a, 0, Math.PI * 2);
    x.fill();
  }
  // Dark limbal ring.
  x.strokeStyle = colourful ? 'rgba(34,18,8,0.75)' : 'rgba(28,24,20,0.7)';
  x.lineWidth = r * 0.07;
  x.beginPath();
  x.arc(r, r, r * 0.965, 0, Math.PI * 2);
  x.stroke();
  return c;
}

export function createEyeLayer(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 1, H = 1, dpr = 1, L = null;
  let specs = [], winds = [], brand = null, irisTex = null, lastSettle = 0;

  function resize(w, h, layout, brandBox, T) {
    W = w;
    H = h;
    L = layout;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const E = L.eye;
    const base = eyeGeometry({ ...E });
    const R = rng(11);
    const k = E.w / 320;
    const few = L.portrait;
    const defs = [];
    const add = (curve, n, off0, off1, w0, w1, a0, a1, delay = 0) => {
      for (let i = 0; i < n; i++) {
        defs.push({
          curve,
          off: lerp(off0, off1, n > 1 ? i / (n - 1) : 0.5) * k + R.gauss() * 0.3 * k,
          w: Math.max(0.6, R.range(w0, w1) * k),
          a: R.range(a0, a1),
          delay,
        });
      }
    };
    add('upper', few ? 4 : 6, -2.8, 1.2, 0.7, 1.5, 0.6, 0.95);
    defs[few ? 2 : 4].w = 2.6 * Math.max(0.8, k);
    defs[few ? 2 : 4].a = 1;
    add('lower', few ? 3 : 4, -0.6, 1.8, 0.7, 1.4, 0.55, 0.9);
    add('crease', 2, 0, 2.6, 0.6, 1.0, 0.3, 0.5, 0.15);
    add('iris', few ? 3 : 4, -1.2, 1.6, 0.8, 1.6, 0.6, 0.95, 0.3);

    // The breeze travels as one loose bundle: it comes in low over the field,
    // rises toward the eye and narrows as it goes. Near the eye every strand
    // peels off onto its own curve, like a stream parting around a stone.
    const corner = base.upper(0);
    const startY = H * (L.portrait ? 0.5 : 0.46);
    const flowAt = (spread) => [
      [-W * 0.5, startY + spread],
      [-W * 0.2, startY + spread],
      [W * 0.03, startY + spread * 0.95 + H * 0.015],
      [lerp(W * 0.03, corner[0], 0.55), lerp(startY, corner[1], 0.35) + spread * 0.55 - H * 0.01],
      [corner[0] - E.w * 0.35, corner[1] + E.w * 0.05 + spread * 0.14],
    ];

    // Strands keep their vertical order all the way in, so none cross:
    // whatever lands highest on the eye travels highest in the bundle.
    const targets = defs.map((d) => sample(curveOf(base, d), 56, d.curve === 'iris' ? 0 : d.off));
    const order = defs.map((_, i) => i).sort((a, b) => targets[a][0][1] - targets[b][0][1] || defs[a].off - defs[b].off);
    const spreads = [];
    order.forEach((idx, rank) => {
      spreads[idx] = H * lerp(-0.11, 0.11, rank / Math.max(1, order.length - 1)) + R.gauss() * H * 0.008;
    });

    lastSettle = 0;
    specs = defs.map((d, i) => {
      const curve = targets[i];
      const p = curve[0];
      const q = curve[2];
      const tl = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const tan = [(q[0] - p[0]) / tl, (q[1] - p[1]) / tl];
      const lead = E.w * 0.08;
      const via = d.curve === 'iris' ? [[corner[0] + E.w * 0.06, corner[1] - E.w * 0.02]] : [];
      const ctrl = [...flowAt(spreads[i]), ...via, [p[0] - tan[0] * lead, p[1] - tan[1] * lead], p, [p[0] + tan[0] * lead, p[1] + tan[1] * lead]];
      const approach = catmull(ctrl);
      const track = makeTrack(approach.concat(curve.slice(1)), approach.length);
      const start = T.breeze + R.range(0, 0.45) + d.delay;
      const dur = R.range(2.5, 2.85);
      lastSettle = Math.max(lastSettle, start + dur);
      return { ...d, track, start, dur, len: W * R.range(0.32, 0.46), phase: R() * 6, amp: H * R.range(0.003, 0.009) };
    });

    // Loose strands that ride the same breeze but carry on past the eye.
    winds = Array.from({ length: few ? 4 : 7 }, (_, i) => {
      const spread = R.gauss() * H * 0.08;
      const rise = i % 2 === 1;
      const y2 = rise ? corner[1] + (i % 4 === 1 ? -1 : 1) * E.w * R.range(0.45, 0.7) : startY + H * R.range(0.02, 0.18);
      const ctrl = [
        [-W * 0.5, startY + spread],
        [-W * 0.2, startY + spread],
        [W * 0.12, lerp(startY + spread, y2, 0.4)],
        [W * 0.5, y2],
        [W * 0.85, y2 + R.gauss() * H * 0.03],
        [W * 1.3, y2 + R.gauss() * H * 0.04],
        [W * 1.5, y2],
      ];
      return {
        track: makeTrack(catmull(ctrl), 0),
        start: T.breeze - 0.3 + i * 0.22 + R() * 0.4,
        dur: R.range(3.0, 4.0),
        len: W * R.range(0.3, 0.45),
        w: R.range(0.6, 1.1),
        a: R.range(0.22, 0.42),
        phase: R() * 6,
        amp: H * R.range(0.004, 0.012),
      };
    });

    if (brandBox) {
      const by = brandBox.y;
      const ctrl = [
        [-W * 0.4, by + 10],
        [-W * 0.15, by + 8],
        [brandBox.left - W * 0.04, by + 3],
        [(brandBox.left + brandBox.right) / 2, by + 5],
        [brandBox.right + W * 0.04, by + 1],
        [W * 1.25, by - 12],
        [W * 1.45, by - 16],
      ];
      brand = { track: makeTrack(catmull(ctrl), 0), start: T.brand, dur: 2.1, len: W * 0.3 };
    }

    irisTex = [makeIrisTexture(base.iris.r, dpr, false), makeIrisTexture(base.iris.r, dpr, true)];
  }

  function openingPath(geo) {
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const p = geo.upper(i / 40);
      i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
    }
    for (let i = 40; i >= 0; i--) {
      const p = geo.lower(i / 40);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
  }

  function drawFills(geo, S) {
    const { iris } = geo;
    const w = S.eye.w;
    ctx.save();
    openingPath(geo);
    ctx.globalAlpha = S.fill;
    ctx.fillStyle = '#fcf9f3';
    ctx.fill();
    ctx.clip();

    const [mono, col] = irisTex;
    const d = iris.r * 2;
    ctx.drawImage(mono, iris.x - iris.r, iris.y - iris.r, d, d);
    if (S.colour > 0) {
      ctx.globalAlpha = S.fill * S.colour;
      ctx.drawImage(col, iris.x - iris.r, iris.y - iris.r, d, d);
    }
    ctx.globalAlpha = S.fill;
    const pg = ctx.createRadialGradient(iris.x, iris.y, geo.pupilR * 0.8, iris.x, iris.y, geo.pupilR * 1.12);
    pg.addColorStop(0, '#0d0a08');
    pg.addColorStop(1, 'rgba(13,10,8,0)');
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.arc(iris.x, iris.y, geo.pupilR * 1.12, 0, Math.PI * 2);
    ctx.fill();

    // Lid shadow across the top of the globe.
    const top = S.eye.y - w * 0.3;
    const sh = ctx.createLinearGradient(0, top, 0, S.eye.y + w * 0.05);
    sh.addColorStop(0, `rgba(70,50,35,${0.28 * (1 - S.eye.globe)})`);
    sh.addColorStop(1, 'rgba(70,50,35,0)');
    ctx.fillStyle = sh;
    ctx.fillRect(S.eye.x - w, top, w * 2, w * 0.4);

    // Catchlights from the sun on the right.
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.ellipse(iris.x + iris.r * 0.3, iris.y - iris.r * 0.32, iris.r * 0.13, iris.r * 0.11, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = S.fill * 0.35;
    ctx.beginPath();
    ctx.arc(iris.x - iris.r * 0.24, iris.y + iris.r * 0.3, iris.r * 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * @returns {{ brandHead: number, settled: boolean }}
   */
  function render(S) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const geo = eyeGeometry(S.eye);
    const t = S.t;
    const la = S.lineAlpha ?? 1;

    if (S.fill > 0) drawFills(geo, S);

    for (const sp of specs) {
      const u = clamp((t - sp.start) / sp.dur);
      if (u <= 0) continue;
      const alpha = sp.a * la * (sp.curve === 'crease' ? 1 - (S.eye.globe || 0) : 1);
      if (u < 1) {
        const tr = sp.track;
        const head = tr.total * (1 - (1 - u) ** 2.3);
        const tail = clamp(head - sp.len, 0, tr.approachLen);
        const wave = (s) => sp.amp * (1 - smoothstep(tr.approachLen * 0.5, tr.approachLen, s)) * Math.sin(s * 0.018 - t * 3.2 + sp.phase);
        const settle = smoothstep(tr.approachLen, tr.total, head);
        const mid = Math.min(head, tr.approachLen);
        if (mid > tail) strokeStrand(ctx, between(tr, tail, mid, wave), sp.w, alpha, S.ink, lerp(0.4, 0.12, settle));
        if (head > tr.approachLen) {
          const pts = between(tr, tr.approachLen, head);
          if (sp.curve === 'iris') {
            ctx.save();
            openingPath(geo);
            ctx.clip();
          }
          strokeStrand(ctx, pts, sp.w, alpha, S.ink, lerp(0.4, 0.08, settle));
          if (sp.curve === 'iris') ctx.restore();
        }
        continue;
      }
      const fn = curveOf(geo, sp);
      const pts = sample(fn, 56, sp.curve === 'iris' ? 0 : sp.off);
      if (sp.curve === 'iris') {
        ctx.save();
        openingPath(geo);
        ctx.clip();
      }
      strokeStrand(ctx, pts, sp.w, alpha, S.ink, 0.08);
      if (sp.curve === 'iris') ctx.restore();
    }

    for (const wd of winds) {
      const u = clamp((t - wd.start) / wd.dur);
      if (u <= 0 || u >= 1) continue;
      const tr = wd.track;
      const head = tr.total * u;
      const wave = (s) => wd.amp * Math.sin(s * 0.015 - t * 3 + wd.phase);
      strokeStrand(ctx, between(tr, Math.max(0, head - wd.len), head, wave), wd.w, wd.a * la, S.ink, 0.45);
    }

    let brandHead = -Infinity;
    if (brand) {
      const u = clamp((t - brand.start) / brand.dur);
      if (u > 0 && u < 1) {
        const tr = brand.track;
        const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
        const head = tr.total * e;
        const pts = between(tr, Math.max(0, head - brand.len), head);
        strokeStrand(ctx, pts, 1.1, 0.55 * la, S.ink, 0.45);
        brandHead = pts[pts.length - 1][0];
      } else if (u >= 1) brandHead = Infinity;
    }
    return { brandHead, settled: t >= lastSettle };
  }

  return { resize, render, get settleTime() { return lastSettle; } };
}
