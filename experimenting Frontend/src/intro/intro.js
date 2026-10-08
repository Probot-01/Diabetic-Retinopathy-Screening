// Opening sequence: farmer → breeze → eye → looks → name → blink → colour.
import { createWorld } from './world.js';
import { createEyeLayer, INK } from './eye.js';
import { clamp, lerp, phase, ease, smoothstep, mixHex, smoothDamp } from '../lib/math.js';

/** Timeline in seconds. */
export const T = {
  sceneIn: 1.1,
  breeze: 1.5,
  fill: 4.55,
  brand: 4.9,
  look1: 5.3,
  look2: 6.2,
  settle: 7.1,
  blink: 7.65,
  bloom: 1.9,
  tagline: 9.0,
  cue: 9.7,
  done: 9.9,
};

function lookAt(t) {
  const s1 = phase(t, T.look1, 0.24, ease.outCubic);
  const s2 = phase(t, T.look2, 0.3, ease.outCubic);
  const s3 = phase(t, T.settle, 0.28, ease.outCubic);
  return {
    look: lerp(lerp(lerp(0, -1, s1), 1, s2), 0, s3),
    lookY: -0.12 * s1 * (1 - s2) + 0.06 * s2 * (1 - s3),
  };
}

function blinkAt(t, t0) {
  const d = t - t0;
  if (d < 0) return 0;
  if (d < 0.1) return ease.inOutSine(d / 0.1);
  if (d < 0.16) return 1;
  if (d < 0.4) return 1 - ease.outCubic((d - 0.16) / 0.24);
  return 0;
}

export function createIntro({ world: worldCanvas, ink: inkCanvas, brand: brandEl, reduced, debugT }) {
  const world = createWorld(worldCanvas);
  const eyeLayer = createEyeLayer(inkCanvas);
  const nameEl = brandEl.querySelector('.brand__name');
  let t = reduced ? T.done + 0.01 : 0;
  let speed = 1;
  let L = null;
  let nameBox = null;
  let idleBlinks = [];
  const gaze = { x: 0, y: 0, tx: 0, ty: 0, vx: { v: 0 }, vy: { v: 0 } };
  // Style writes are skipped when nothing changed.
  const written = new Map();
  const put = (el, name, value) => {
    const key = `${el.id}|${name}`;
    if (written.get(key) === value) return;
    written.set(key, value);
    if (name.startsWith('--')) el.style.setProperty(name, value);
    else el.style[name] = value;
  };
  // Reduced motion rests him mid-stroke with the hoe raised.
  let farmerClock = reduced ? 0.36 * 2.4 : 0;
  const frozen = debugT != null;
  if (frozen) t = debugT;

  function resize(W, H) {
    L = world.resize(W, H);
    const size = Math.max(40, L.eye.w * 0.27);
    brandEl.style.setProperty('--brand-size', `${size}px`);
    brandEl.style.setProperty('--bx', `${L.eye.x}px`);
    brandEl.style.setProperty('--by', `${L.eye.y + L.eye.w * 0.27}px`);
    const r = nameEl.getBoundingClientRect();
    nameBox = { left: r.left, right: r.right, width: r.width, y: r.bottom - size * 0.06 };
    eyeLayer.resize(W, H, L, nameBox, T);
    worldCanvas.style.transformOrigin = `${L.eye.x}px ${L.eye.y}px`;
    return L;
  }

  /** Called when the visitor scrolls, taps or presses a key mid-intro. */
  function hurry() {
    if (t < T.done && !frozen) speed = 4;
  }

  /** Jump straight to the end of the intro (the skip link). */
  function finish() {
    if (!frozen) t = Math.max(t, T.done);
  }

  function nextIdleBlink(from) {
    // Natural resting blink rate, a few seconds apart.
    idleBlinks.push(from + 3.2 + Math.random() * 3.5);
  }

  /**
   * Advances the intro and draws it.
   * @param {number} dt
   * @param {object} [o] overrides from the scroll story (eye geometry, fades)
   */
  function update(dt, o = {}) {
    if (!frozen) t += dt * speed;
    if (t >= T.done) speed = 1;
    const { W, H } = L;

    const bloomT = t - (T.blink + 0.12);
    const maxR = Math.hypot(W, H) * 1.05 + Math.min(W, H) * 0.45;
    const bloomR = bloomT <= 0 ? 0 : maxR * ease.outCubic(clamp(bloomT / T.bloom));

    let blink = blinkAt(t, T.blink);
    if (!reduced && t > T.done) {
      if (!idleBlinks.length) nextIdleBlink(t);
      const b = idleBlinks[idleBlinks.length - 1];
      blink = Math.max(blink, blinkAt(t, b));
      if (t > b + 0.5) nextIdleBlink(t);
    }

    const { look, lookY } = lookAt(t);
    // Once the intro is over the eye follows the visitor's pointer, in quick
    // saccade-like jumps rather than a smooth chase.
    const following = t > T.done && !reduced && !(o.handoff > 0) && o.gaze;
    const want = following ? [clamp(o.gaze.x * 1.15, -0.95, 0.95), clamp(o.gaze.y, -0.8, 0.8)] : [0, 0];
    if (Math.hypot(want[0] - gaze.tx, want[1] - gaze.ty) > (following ? 0.14 : 0)) {
      gaze.tx = want[0];
      gaze.ty = want[1];
    }
    gaze.x = smoothDamp(gaze.x, gaze.tx, gaze.vx, 0.06, dt);
    gaze.y = smoothDamp(gaze.y, gaze.ty, gaze.vy, 0.06, dt);
    const drift = t > T.done && !reduced && !following ? 0.03 * Math.sin(t * 0.37) : 0;
    const eye = {
      ...L.eye,
      look: look + drift + gaze.x,
      lookY: lookY + gaze.y,
      // The upper lid comes down a little with the eye when it looks down.
      blink: Math.min(1, blink + Math.max(0, gaze.y) * 0.14),
      pupil: lerp(0.44, 0.36, smoothstep(0, 1.4, bloomT)) + 0.008 * Math.sin(t * 1.9),
      globe: 0,
    };

    // Hand-off to the anatomical eye: the drawing glides to the centre, grows
    // to the 3D eye's size and its lids round out into the globe's outline.
    const h = o.handoff || 0;
    const ready = o.threeReady || o.fallback;
    if (h > 0) {
      const k = ease.inOutCubic(clamp(h / 0.7));
      eye.x = lerp(eye.x, o.target.x, k);
      eye.y = lerp(eye.y, o.target.y, k);
      eye.w = lerp(eye.w, o.target.w, k);
      eye.look *= 1 - k;
      eye.lookY *= 1 - k;
      eye.blink *= 1 - clamp(h * 5);
      eye.globe = smoothstep(0.3, 0.85, h);
      eye.globeR = lerp(eye.w * 0.205 * (12 / 5.85), o.target.globeR, k);
    }
    // A long crossfade: the drawing dissolves while the 3D eye fades in
    // beneath it, exactly aligned.
    const handFade = ready ? smoothstep(0.74, 0.96, h) : 0;
    const lineFade = ready ? smoothstep(0.8, 1, h) : 0;

    // The farmer keeps his own unhurried clock: fast-forwarding the story must
    // not make him work at five times speed.
    if (!reduced && !frozen) farmerClock += dt;

    // Darkness closes in around the eye as we move into it. The world layer is
    // scaled about the eye's original spot, so map the drawn eye's current
    // screen position back into the world's own coordinates.
    const hScale = 1 + 0.14 * ease.inOutSine(h);
    let focus = null;
    if (h > 0) {
      const k = ease.inOutSine(smoothstep(0.02, 0.72, h));
      const r0 = Math.hypot(W, H) * 1.25;
      const r1 = (o.target ? o.target.globeR : L.eye.w * 0.42) * 1.3;
      const r = r0 * Math.pow(r1 / r0, k);
      const ox = L.eye.x;
      const oy = L.eye.y;
      focus = { x: ox + (eye.x - ox) / hScale, y: oy + (eye.y - oy) / hScale, r: r / hScale, soft: Math.max(40, r * 0.45) / hScale };
    }

    world.render({
      focus,
      t: reduced ? 2 : t,
      farmerT: frozen ? t : farmerClock,
      bloomR,
      gustFront: lerp(-0.25 * W, 1.35 * W, clamp((t - T.breeze - 0.3) / 2.6)),
      birdsT: reduced ? -1 : bloomT - 0.35,
    });

    const res = eyeLayer.render({
      t,
      eye,
      fill: phase(t, T.fill, 0.6, ease.inOutSine) * (1 - handFade),
      colour: clamp(bloomT / 0.35),
      ink: h > 0 ? mixHex(INK, '#efe8dc', smoothstep(0.2, 0.65, h)) : INK,
      lineAlpha: 1 - lineFade,
    });

    // Scene fades up from the paper, and away again as we move into the eye.
    const sceneIn = phase(t, 0, T.sceneIn, ease.inOutSine);
    put(worldCanvas, 'opacity', (sceneIn * (1 - smoothstep(0.55, 0.9, h))).toFixed(3));
    put(worldCanvas, 'transform', h > 0 ? `scale(${hScale.toFixed(4)})` : '');

    const reveal = nameBox ? clamp((res.brandHead - nameBox.left) / nameBox.width) : 1;
    put(brandEl, '--reveal', reveal.toFixed(4));
    put(brandEl, '--tag-o', phase(t, T.tagline, 0.9, ease.inOutSine).toFixed(3));
    put(brandEl, '--brand-o', (1 - smoothstep(0, 0.3, h)).toFixed(3));
    return { t, done: t >= T.done, eye, layout: L };
  }

  return { resize, update, hurry, finish, get t() { return t; }, get layout() { return L; } };
}
