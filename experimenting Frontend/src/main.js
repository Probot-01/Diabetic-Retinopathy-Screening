import '@fontsource/instrument-serif/400.css';
import '@fontsource-variable/inter';
import './styles.css';
import { createIntro, T } from './intro/intro.js';
import { ROLE_URLS } from './config.js';
import { clamp, phase, ease, smoothstep, mixHex, smoothDamp } from './lib/math.js';
import { frontMetrics } from './lib/frame.js';
import { fundusCanvas } from './anatomy/textures.js';

/** Length of the scrolled story, in viewport heights. */
const SCREENS = 10;

/** Chapter marks on the progress rail, in story screens. */
const CHAPTERS = [
  { s: 0, label: 'The field' },
  { s: 2.0, label: 'The eye' },
  { s: 5.6, label: 'Inside' },
  { s: 7.6, label: 'The retina' },
  { s: SCREENS, label: 'Enter' },
];

const $ = (s) => document.querySelector(s);
const root = document.documentElement;
const params = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || params.has('reduced');
const debugS = params.has('s') ? Number(params.get('s')) : null;
const debugView = params.has('s') || params.has('t');
// ?live runs the real timeline but keeps ticking in a hidden tab (for testing).
const liveTest = params.has('live');

// A story starts at its beginning: don't let a reload drop the visitor
// mid-way with the intro unplayed.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
scrollTo(0, 0);

for (const a of document.querySelectorAll('.role')) {
  const url = ROLE_URLS[a.dataset.role];
  if (url) {
    a.href = url;
  } else {
    // Not configured: say so instead of linking somewhere guessed.
    a.removeAttribute('href');
    a.setAttribute('aria-disabled', 'true');
    a.title = `Not configured: set VITE_${a.dataset.role === 'nurse' ? 'NURSE' : 'OPHTHALMOLOGIST'}_URL in .env`;
    a.style.opacity = '0.45';
    a.style.cursor = 'not-allowed';
  }
}
root.style.setProperty('--track-h', `${(SCREENS + 1) * 100}vh`);

function webglAvailable() {
  if (params.has('nogl')) return false;
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const small = Math.min(innerWidth, innerHeight) < 600;
const weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
const quality = small || weak ? 'mid' : 'high';

const els = {
  world: $('#world'),
  ink: $('#ink'),
  gl: $('#gl-host'),
  veil: $('#veil'),
  enter: $('#enter'),
  brand: $('#brand'),
  status: $('#status'),
};

// Style writes are cached, so values that haven't changed never touch the DOM.
const written = new WeakMap();
function put(el, name, value) {
  let m = written.get(el);
  if (!m) written.set(el, (m = new Map()));
  if (m.get(name) === value) return;
  m.set(name, value);
  if (name.startsWith('--')) el.style.setProperty(name, value);
  else el.style[name] = value;
}

let intro;
try {
  intro = createIntro({
    world: els.world,
    ink: els.ink,
    brand: els.brand,
    reduced,
    debugT: params.has('t') ? Number(params.get('t')) : debugS != null ? T.done + 1 : null,
  });
} catch (err) {
  degrade(err);
}

// ── 3D, loaded while the intro plays and built once it has finished ─────────

let fundus = null;
let anatomy = null;
let anatomyState = webglAvailable() ? 'idle' : 'fallback';
let anatomyModule = null;

function loadModule() {
  if (anatomyModule || anatomyState === 'fallback') return;
  anatomyModule = import('./anatomy/anatomy.js').catch((err) => {
    console.warn('[netrsetu] 3D code failed to load:', err);
    return null;
  });
}

let retried = false;
async function buildAnatomy() {
  if (anatomyState !== 'idle') return;
  anatomyState = 'building';
  // The build may be asked for before the intro has requested the code
  // (an early scroll), so make sure the request is under way.
  loadModule();
  try {
    const mod = await anatomyModule;
    if (!mod) throw new Error('the 3D code did not load');
    const t0 = performance.now();
    fundus = fundus || fundusCanvas(quality === 'high' ? 2048 : 1024);
    const t1 = performance.now();
    anatomy = await mod.createAnatomy({ host: els.gl, labelsEl: $('#labels'), leadersEl: $('#leaders'), quality, fundus, reduced });
    anatomy.resize(size.w, size.h);
    anatomyState = 'ready';
    console.info(`[netrsetu] 3D ready (${quality}): fundus ${Math.round(t1 - t0)} ms, scene ${Math.round(performance.now() - t1)} ms`);
  } catch (err) {
    // One more attempt before settling for the flat version: a dropped
    // request shouldn't cost the visitor the whole anatomy chapter.
    if (!retried) {
      retried = true;
      anatomyModule = null;
      anatomyState = 'idle';
      console.warn('[netrsetu] 3D view failed to build, retrying:', err);
      return;
    }
    console.warn('[netrsetu] 3D view unavailable, using the 2D retina:', err);
    anatomyState = 'fallback';
  }
}

// Without WebGL the retina is shown as the same fundus, drawn flat.
let flatRetina = null;
function ensureFlatRetina() {
  if (flatRetina) return;
  fundus = fundus || fundusCanvas(1024);
  flatRetina = fundus;
  flatRetina.className = 'layer flat-retina';
  els.gl.appendChild(flatRetina);
}

// ── sizing ──────────────────────────────────────────────────────────────────

// Mobile browsers resize the viewport as the URL bar slides; repainting the
// illustration for that would stutter, so only react to real size changes.
let size = { w: 0, h: 0 };
function fit(force = false) {
  const w = innerWidth;
  const h = innerHeight;
  // A hidden or still-opening tab can report a zero-sized viewport.
  if (w < 2 || h < 2) return;
  if (!force && w === size.w && Math.abs(h - size.h) < 140) return;
  size = { w, h };
  intro?.resize(w, h);
  anatomy?.resize(w, h);
  const hyp = Math.hypot(w, h);
  els.veil.style.background = `radial-gradient(circle at 50% 50%, rgba(22,3,2,0) ${hyp * 0.3}px, rgba(22,3,2,0.55) ${hyp * 0.42}px, rgba(9,1,1,0.97) ${hyp * 0.56}px)`;
}
fit(true);
document.fonts?.ready.then(() => fit(true));
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fit, 120);
});

// ── input ───────────────────────────────────────────────────────────────────

for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
  addEventListener(ev, () => intro?.hurry(), { passive: true });
}

const pointer = { x: 0, y: 0, active: false };
addEventListener(
  'pointermove',
  (e) => {
    if (e.pointerType !== 'mouse') return;
    pointer.x = (e.clientX / innerWidth) * 2 - 1;
    pointer.y = (e.clientY / innerHeight) * 2 - 1;
    pointer.active = true;
  },
  { passive: true },
);
root.addEventListener('mouseleave', () => {
  pointer.active = false;
});

const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
const scrollS = () => clamp(scrollY / maxScroll()) * SCREENS;

let story = 0;
let snapTo = null;

$('[data-skip]').addEventListener('click', (ev) => {
  ev.preventDefault();
  intro?.finish();
  scrollTo({ top: maxScroll(), behavior: 'instant' });
  snapTo = SCREENS;
  // Open the choice straight away rather than waiting on the next frame.
  root.style.setProperty('--enter-o', '1');
  els.enter.classList.add('is-open');
  setTimeout(() => document.querySelector('.role')?.focus({ preventScroll: true }), 80);
});

// Progress rail: where you are in the story, and a way to jump.
const rail = document.createElement('nav');
rail.className = 'rail';
rail.setAttribute('aria-label', 'Story chapters');
const railButtons = CHAPTERS.map((c) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = `<span class="rail__label">${c.label}</span><span class="rail__dot" aria-hidden="true"></span>`;
  // The story's spring carries the view there; the scroll position just moves.
  b.addEventListener('click', () => {
    intro?.finish();
    scrollTo({ top: (c.s / SCREENS) * maxScroll(), behavior: 'instant' });
  });
  rail.appendChild(b);
  return b;
});
document.body.appendChild(rail);
let chapter = -1;

// Reduced motion: the story moves in still steps instead of continuous flights.
const STEPS = [0, 1.8, 5.6, 7.3, SCREENS];
const stepFor = (s) => STEPS.reduce((acc, v) => (s >= v - 0.3 ? v : acc), 0);

// ── per-frame ───────────────────────────────────────────────────────────────

const storySpring = { v: 0 };
const par = { x: 0, y: 0, vx: { v: 0 }, vy: { v: 0 } };
let last = performance.now();
let clock = 0;

// If animation fails, nothing may stand between the visitor and the app: an
// error is logged once and the loop carries on, and if errors keep coming the
// page falls back to its plain form, with the two role links in view.
let failures = 0;
function degrade(err) {
  console.error('[netrsetu] animation stopped, showing the plain page:', err);
  root.classList.replace('js', 'no-js');
}

function frame(now) {
  if (root.classList.contains('no-js')) return;
  try {
    tick(now);
    failures = 0;
  } catch (err) {
    if (failures === 0) console.error('[netrsetu] frame error:', err);
    if (++failures > 30) return degrade(err);
  }
  schedule();
}

function tick(now) {
  // A tab that opened hidden or at zero size has not been laid out yet.
  if (!size.w) {
    fit(true);
    if (!size.w) return;
  }
  const dt = Math.min(liveTest && document.hidden ? 1 : 0.05, (now - last) / 1000);
  last = now;
  clock += dt;

  const introT = intro.t;
  if (introT > 1.5) loadModule();
  const raw = debugS ?? scrollS();
  if (raw > 0.02) intro.hurry();
  const introDone = introT >= T.done;
  if (introDone || raw > 0.4) buildAnatomy();

  // The story waits for the intro, then follows the scroll on a critically
  // damped spring: it eases into motion, never overshoots, and a big jump
  // (the scrollbar, the rail) plays through at a legible speed.
  const target = introDone ? (reduced ? stepFor(raw) : raw) : 0;
  if (snapTo != null) {
    story = snapTo;
    storySpring.v = 0;
    snapTo = null;
  } else if (reduced || debugS != null) story = target;
  else story = smoothDamp(story, target, storySpring, 0.55, dt, 2.8);

  const live = !reduced && pointer.active;
  par.x = smoothDamp(par.x, live ? pointer.x : 0, par.vx, 0.7, dt);
  par.y = smoothDamp(par.y, live ? pointer.y : 0, par.vy, 0.7, dt);

  const s = story;
  const { w: W, h: H } = size;
  const fallback = anatomyState === 'fallback';
  const ready = anatomyState === 'ready';

  // Hand-off: the drawn eye becomes the 3D eye. Until the 3D is ready — or
  // if it never can be — the drawn eye stays on screen as the globe, so the
  // story never goes blank.
  const h = clamp(s / 1.2);
  const hold = !ready;
  if (s < 1.3 || hold) {
    const M = frontMetrics(W, H);
    const w = M.limbusPx / 0.205;
    intro.update(dt, {
      handoff: hold ? Math.min(h, 0.84) : h,
      threeReady: ready,
      fallback,
      target: { x: W / 2, y: H / 2 - 0.012 * w, w, globeR: M.globePx },
      gaze: live && s < 0.05 ? pointer : null,
    });
    put(els.world, 'visibility', '');
    put(els.ink, 'visibility', '');
    put(els.ink, 'opacity', fallback ? (1 - smoothstep(6.0, 6.8, s)).toFixed(3) : '1');
  } else {
    put(els.world, 'visibility', 'hidden');
    put(els.ink, 'visibility', 'hidden');
    put(els.brand, '--brand-o', '0');
  }

  let r = 0;
  let f = 0;
  if (ready && s > 0.55) {
    const res = anatomy.update(s, clock, {
      dt,
      pointer: par,
      hover: pointer.active ? { x: pointer.x, y: -pointer.y } : null,
      adapt: !debugView && !document.hidden,
    });
    r = res.r;
    f = res.f;
  } else if (fallback) {
    r = ease.smoother(clamp((s - 6.1) / 1.8));
    f = ease.smoother(clamp((s - 7.0) / 2.0));
    if (s > 1) ensureFlatRetina();
    if (flatRetina) put(flatRetina, 'opacity', r.toFixed(3));
  }
  put(els.gl, 'opacity', ready ? smoothstep(0.52, 0.92, h).toFixed(3) : fallback ? '1' : '0');

  // Paper → studio → the red of the retina.
  const dark = smoothstep(0.15, 0.75, h);
  const bg = r > 0 ? mixHex('#0d0c0b', '#1a0503', r) : mixHex('#f1ece2', '#0d0c0b', dark);
  put(root, '--stage-bg', bg);
  put(root, '--chrome', dark > 0.5 ? 'rgba(239,232,220,0.8)' : 'rgba(29,26,22,0.62)');
  put(root, '--chrome-bg', dark > 0.5 ? '#0d0c0b' : '#f1ece2');
  put(els.veil, 'opacity', smoothstep(0.3, 1, f).toFixed(3));

  // Say so when the 3D is still on its way, or not available at all.
  const status =
    anatomyState === 'building' && s > 1.0 ? 'Preparing the 3D eye…' : fallback && s > 1.0 && s < 6.0 ? 'The 3D view isn’t available on this device.' : '';
  if (els.status.textContent !== status) els.status.textContent = status;
  put(els.status, 'opacity', status ? '1' : '0');

  // The choice appears once the view has settled inside the retina.
  const roles = smoothstep(9.0, 9.7, s);
  put(root, '--enter-o', roles.toFixed(3));
  els.enter.classList.toggle('is-open', roles > 0.02);

  const idx = CHAPTERS.reduce((acc, c, i) => (s >= c.s - 0.35 ? i : acc), 0);
  if (idx !== chapter) {
    chapter = idx;
    railButtons.forEach((b, i) => (i === idx ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current')));
  }
  const railOn = introDone && s < 9.2;
  put(root, '--rail-o', railOn ? '1' : '0');
  rail.classList.toggle('is-on', railOn);

  put(root, '--cue-o', (phase(introT, T.cue, 0.8, ease.inOutSine) * (1 - smoothstep(0, 0.12, s))).toFixed(3));
  put(root, '--skip-o', (0.7 * phase(introT, 1.2, 1, ease.inOutSine) * (1 - roles)).toFixed(3));
}

// Debug and test views keep drawing in a hidden tab so they can be captured.
function schedule() {
  if ((debugView || liveTest) && document.hidden) setTimeout(() => frame(performance.now()), 50);
  else requestAnimationFrame(frame);
}
if (debugView || liveTest) {
  window.__netrsetu = { state: () => anatomyState, story: () => story, intro: () => intro?.t, anatomy: () => anatomy };
}
schedule();

if (reduced) loadModule();
