export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a));
export const smoothstep = (a, b, v) => {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
};

export const ease = {
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outCubic: (t) => 1 - (1 - t) ** 3,
  inCubic: (t) => t * t * t,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outQuint: (t) => 1 - (1 - t) ** 5,
  inOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2),
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  /** Quintic smootherstep: zero velocity and acceleration at both ends. */
  smoother: (t) => t * t * t * (t * (t * 6 - 15) + 10),
};

/** Eased 0→1 progress of `t` through the window [start, start + dur]. */
export const phase = (t, start, dur, fn = ease.inOutCubic) => fn(clamp((t - start) / dur));

/**
 * Critically damped spring toward `target` (the SmoothDamp formulation):
 * starts gently, never overshoots, and is independent of frame rate.
 * `state.v` carries the velocity between calls.
 */
export function smoothDamp(current, target, state, smoothTime, dt, maxSpeed = Infinity) {
  if (dt <= 0) return current;
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const maxChange = maxSpeed * smoothTime;
  const change = clamp(current - target, -maxChange, maxChange);
  const to = current - change;
  const temp = (state.v + omega * change) * dt;
  state.v = (state.v - omega * temp) * decay;
  let out = to + (change + temp) * decay;
  if (target - current > 0 === out > target) {
    out = target;
    state.v = 0;
  }
  return out;
}

/** Deterministic PRNG so every redraw of the illustration is identical. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.gauss = () => {
    let s = 0;
    for (let i = 0; i < 4; i++) s += next();
    return (s - 2) / 0.577;
  };
  return next;
}

/** Smooth 1-D value noise in [-1, 1]. */
export function noise1(x, seed = 0) {
  const h = (n) => {
    const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u);
}

export const mixHex = (a, b, t) => {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(lerp(pa >> 16, pb >> 16, t));
  const g = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, t));
  const bl = Math.round(lerp(pa & 255, pb & 255, t));
  return `rgb(${r},${g},${bl})`;
};
