// The 3D half of the story: the whole eye, its exploded view, and the flight
// into the retina. Everything is a pure function of `s`, the story position
// in screens, so scrolling backwards simply plays it in reverse.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildEye } from './model.js';
import { RETINA_R, DISC } from './textures.js';
import { clamp, lerp, ease, smoothstep, smoothDamp } from '../lib/math.js';
import { FRONT_FOV, GLOBE_MM, frontMetrics } from '../lib/frame.js';

// Stages overlap so the camera never comes to a halt between them; the one
// deliberate pause is while the labels are up.
export const STAGES = {
  // Starts once the drawn outline has dissolved, so nothing turns under it.
  orbit: [1.2, 2.7],
  explode: [2.3, 5.1],
  labels: [4.9, 6.4],
  // The approach to the retina and the entry into it are long and overlap,
  // so the flight in is one continuous, unhurried move.
  focus: [6.1, 7.9],
  inside: [7.0, 9.0],
};

const LABELS = [
  { part: 'cornea', text: 'Cornea', side: -1, desc: 'The clear front window. It does most of the focusing.' },
  { part: 'iris', text: 'Iris', side: 1, desc: 'A ring of muscle that sets the size of the pupil.' },
  { part: 'lens', text: 'Lens', side: -1, desc: 'Changes shape to fine-tune focus, near and far.' },
  { part: 'ciliary', text: 'Ciliary body', side: 1, desc: 'Makes the eye’s fluid and adjusts the lens through fine fibres.' },
  { part: 'scleraA', text: 'Sclera', side: -1, desc: 'The tough white wall that gives the eye its shape.' },
  // The retina is marked out by its own look (a glowing outline and a
  // pulsing marker) rather than a line of text.
  { part: 'retina', text: 'Retina', side: 1, accent: true, desc: '' },
  { part: 'choroid', text: 'Choroid', side: -1, desc: 'A dense layer of blood vessels that nourishes the retina.' },
  { part: 'nerve', text: 'Optic nerve', side: 1, desc: 'Carries the retina’s signals to the brain.' },
];

// Yield between build steps. A hidden tab never fires animation frames, so
// fall back to a timer there rather than stalling the build until it's shown.
const nextFrame = () => new Promise((r) => (document.hidden ? setTimeout(r, 16) : requestAnimationFrame(() => r())));

export async function createAnatomy({ host, labelsEl, leadersEl, quality, fundus, reduced = false }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  // Warm key from the upper right (where the sun was), cool rim from behind.
  const key = new THREE.DirectionalLight('#fff2e2', 2.4);
  key.position.set(6, 7, 9);
  const rim = new THREE.DirectionalLight('#c4d8ff', 1.3);
  rim.position.set(-7, 3, -8);
  const fill = new THREE.HemisphereLight('#fbf4ec', '#3a2a22', 0.45);
  scene.add(key, rim, fill);

  await nextFrame();
  const eye = buildEye({ quality, fundus });
  scene.add(eye.pivot);
  await nextFrame();

  const camera = new THREE.PerspectiveCamera(FRONT_FOV, 1, 0.3, 900);
  let W = 1, H = 1;

  // Labels: one element and one leader line per structure.
  const svgNS = 'http://www.w3.org/2000/svg';
  let labelHover = null;
  const labels = LABELS.map((l) => {
    const el = document.createElement('span');
    el.className = `label${l.accent ? ' label--retina' : ''}${l.side < 0 ? ' label--up' : ''}`;
    const name = document.createElement('span');
    name.className = 'label__name';
    name.textContent = l.text;
    el.append(name);
    if (l.desc) {
      const desc = document.createElement('span');
      desc.className = 'label__desc';
      desc.textContent = l.desc;
      el.append(desc);
    }
    el.addEventListener('pointerenter', () => {
      labelHover = l.part;
    });
    el.addEventListener('pointerleave', () => {
      if (labelHover === l.part) labelHover = null;
    });
    labelsEl.appendChild(el);
    const line = document.createElementNS(svgNS, 'line');
    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('r', '2');
    leadersEl.append(line, dot);
    let halo = null;
    if (l.accent) {
      halo = document.createElementNS(svgNS, 'circle');
      halo.setAttribute('r', '3');
      halo.setAttribute('class', 'halo');
      leadersEl.append(halo);
    }
    return { ...l, el, line, dot, halo };
  });

  // Resolution: capped by device, quality and a pixel budget, and lowered
  // further (never raised) if frames start taking too long.
  let pixelRatio = 1;
  let dtAvg = 1 / 60;
  let slow = 0;
  function resize(w, h) {
    W = w;
    H = h;
    const cap = quality === 'high' ? 1.5 : 1.25;
    pixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, cap, Math.sqrt(3.2e6 / (W * H))));
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    leadersEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  }
  function adapt(dt) {
    dtAvg += (dt - dtAvg) * 0.05;
    slow = dtAvg > 1 / 40 ? slow + 1 : Math.max(0, slow - 1);
    if (slow > 45 && pixelRatio > 1) {
      pixelRatio = Math.max(1, pixelRatio - 0.25);
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(W, H, false);
      slow = 0;
      dtAvg = 1 / 60;
    }
  }

  const portrait = () => W / H < 0.9;

  /** Camera distance at which the whole exploded eye fits on screen. */
  function fitDistance(span, az) {
    const along = span * Math.sin(az * (Math.PI / 180)) + 26;
    const across = 34;
    const vis = 2 * Math.tan((FRONT_FOV * Math.PI) / 360);
    const a = W / H;
    if (portrait()) return Math.max(along / (0.8 * vis), across / (0.84 * vis * a));
    return Math.max(along / (0.84 * vis * a), across / (0.7 * vis));
  }

  const mix = (A, B, t) => ({
    target: A.target.clone().lerp(B.target, t),
    az: lerp(A.az, B.az, t),
    el: lerp(A.el, B.el, t),
    // Distance changes by a steady ratio, so a dolly-in feels even all the way
    // instead of rushing at the end.
    dist: A.dist * Math.pow(B.dist / A.dist, t),
    fov: lerp(A.fov, B.fov, t),
    roll: lerp(A.roll, B.roll, t),
  });

  const win = (s, [a, b]) => clamp((s - a) / (b - a));

  // The camera follows its scripted pose on a light spring of its own, which
  // irons out the joins between stages.
  const lookAt = new THREE.Vector3();
  const KEYS = ['x', 'y', 'z', 'az', 'el', 'dist', 'fov', 'roll'];
  const vel = Object.fromEntries(KEYS.map((k) => [k, { v: 0 }]));
  let cam = null;
  function smoothPose(p, dt) {
    const want = { x: p.target.x, y: p.target.y, z: p.target.z, az: p.az, el: p.el, dist: p.dist, fov: p.fov, roll: p.roll };
    if (!cam) cam = want;
    else for (const k of KEYS) cam[k] = smoothDamp(cam[k], want[k], vel[k], 0.3, dt);
    return cam;
  }

  // While the opened eye holds still, pointing at a structure (or its label)
  // lights it up and shows what it does.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pickables = [];
  eye.root.traverse((m) => {
    if (m.isMesh && m.userData.part) pickables.push(m);
  });
  const glow = Object.fromEntries(LABELS.map((l) => [l.part, 0]));
  let active = null;
  function pick(s, hover, dt) {
    const [a0, a1] = STAGES.labels;
    const live = s > a0 + 0.35 && s < a1 - 0.25;
    labelsEl.classList.toggle('is-live', live);
    let hit = null;
    if (live && hover && !labelHover) {
      ndc.set(hover.x, hover.y);
      raycaster.setFromCamera(ndc, camera);
      for (const r of raycaster.intersectObjects(pickables, false)) {
        if (r.object.material.opacity > 0.2) {
          hit = r.object.userData.part;
          break;
        }
      }
    }
    active = live ? labelHover || hit : null;
    document.documentElement.style.cursor = active && hit ? 'help' : '';
    for (const k of Object.keys(glow)) {
      glow[k] += ((k === active ? 1 : 0) - glow[k]) * Math.min(1, dt * 10);
      if (k !== 'retina') eye.highlight(k, glow[k]);
    }
  }

  function update(s, time, { dt = 1 / 60, pointer = null, hover = null, adapt: adaptive = false } = {}) {
    if (adaptive) adapt(dt);
    pick(s, hover, dt);
    const o = ease.smoother(win(s, STAGES.orbit));
    const e = win(s, STAGES.explode);
    const r = ease.smoother(win(s, STAGES.focus));
    const f = ease.smoother(win(s, STAGES.inside));
    eye.life.time.value = time;
    eye.life.live.value = reduced ? 0 : smoothstep(0.4, 1, f);

    eye.setExplode(e, r);
    // Everything but the retina steps back as attention moves to it.
    for (const k of ['cornea', 'iris', 'lens', 'ciliary', 'scleraA']) eye.fadePart(k, 1 - smoothstep(0, 0.55, r));
    for (const k of ['choroid', 'scleraP']) eye.fadePart(k, 1 - smoothstep(0.3, 0.85, r));
    eye.retinaMaterial.emissiveIntensity = lerp(0.1, 0.55, smoothstep(0.2, 1, r * 0.5 + f * 0.5)) + 0.22 * glow.retina;
    key.intensity = 2.4 * (1 - 0.55 * f);
    rim.intensity = 1.3 * (1 - f);

    // Gentle sway while the eye is on display, stilled for the retina.
    eye.pivot.rotation.y = 0.05 * Math.sin(time * 0.3) * smoothstep(1.2, 2, s) * (1 - r);

    // On a tall screen the eye opens vertically, cornea at the top, so it
    // reads front to back as you scroll down.
    const rollP = portrait() ? 90 : 0;
    const M = frontMetrics(W, H);
    const off = eye.offsets;
    const front = eye.corneaApex + off.cornea;
    const back = -GLOBE_MM + off.scleraP - 14;
    const span = front - back;
    const pole = new THREE.Vector3(0, 0, off.retina - RETINA_R);

    const P0 = { target: new THREE.Vector3(), az: 0, el: 0, dist: M.D, fov: FRONT_FOV, roll: 0 };
    const P1 = { target: new THREE.Vector3(), az: 58, el: 14, dist: Math.max(M.D * 1.1, fitDistance(34, 58)), fov: FRONT_FOV, roll: rollP };
    const P2 = { target: new THREE.Vector3(0, 0, (front + back) / 2), az: 60, el: 16, dist: fitDistance(span, 60), fov: FRONT_FOV, roll: rollP };
    // Aim between the macula and the disc so both sit in the final frame.
    const aim = pole.clone().add(new THREE.Vector3(DISC.x * 0.35, DISC.y, 0.4));
    const P3 = { target: aim, az: 0, el: 0, dist: 34, fov: 46, roll: 0 };
    // Close to the centre of the globe, so the view opens wide like a
    // wide-field fundus photograph. The field widens only gently on the way in.
    const P4 = { target: aim, az: 0, el: 0, dist: 10.2, fov: portrait() ? 80 : 66, roll: 0 };

    let p = mix(P0, P1, o);
    p = mix(p, P2, ease.inOutSine(smoothstep(0, 0.9, e)));
    p = mix(p, P3, r);
    p = mix(p, P4, f);
    // Inside the retina the view breathes: a slow drift, and a slight sway of
    // the field, like a live fundus examination.
    const alive = reduced ? 0 : f;
    p.target.x += Math.sin(time * 0.21) * 0.28 * alive;
    p.target.y += Math.cos(time * 0.17) * 0.28 * alive;
    p.fov += Math.sin(time * 0.33) * 0.8 * alive;
    p.roll += Math.sin(time * 0.13) * 0.6 * alive;
    // A little parallax with the pointer, as if the model were held in view.
    // Off during the hand-off, where the 3D eye must sit exactly on the drawing.
    if (pointer) {
      const k = smoothstep(1.3, 1.9, s) * (1 - 0.8 * f);
      p.az += pointer.x * 3.5 * k;
      p.el -= pointer.y * 2.5 * k;
    }

    const c = smoothPose(p, dt);
    const az = (c.az * Math.PI) / 180;
    const el = (c.el * Math.PI) / 180;
    lookAt.set(c.x, c.y, c.z);
    camera.position.set(
      c.x + c.dist * Math.sin(az) * Math.cos(el),
      c.y + c.dist * Math.sin(el),
      c.z + c.dist * Math.cos(az) * Math.cos(el),
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(lookAt);
    camera.rotateZ((c.roll * Math.PI) / 180);
    if (camera.fov !== c.fov) {
      camera.fov = c.fov;
      camera.updateProjectionMatrix();
    }

    renderer.render(scene, camera);
    placeLabels(s);
    return { o, e, r, f };
  }

  const v = new THREE.Vector3();
  const c = new THREE.Vector3();
  function project(vec) {
    v.copy(vec).project(camera);
    return [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H, v.z];
  }

  function placeLabels(s) {
    const [a0, a1] = STAGES.labels;
    const vertical = portrait();
    eye.root.updateMatrixWorld(true);
    labels.forEach((l, i) => {
      // The leader draws itself out from the part, then the name arrives.
      const lineIn = smoothstep(a0 + i * 0.06, a0 + 0.26 + i * 0.06, s);
      const textIn = smoothstep(a0 + 0.12 + i * 0.06, a0 + 0.4 + i * 0.06, s);
      const fadeOut = 1 - smoothstep(l.accent ? 7.0 : a1 - 0.2, l.accent ? 7.3 : a1, s);
      // With one structure in focus the other names step back.
      const focusDim = active && active !== l.part ? 0.45 : 1;
      const op = textIn * fadeOut * focusDim;
      l.el.style.opacity = op.toFixed(3);
      l.el.classList.toggle('is-active', active === l.part);
      l.line.style.opacity = (0.9 * fadeOut).toFixed(3);
      l.dot.style.opacity = (0.9 * lineIn * fadeOut).toFixed(3);
      if (lineIn * fadeOut <= 0.001) {
        l.line.style.opacity = '0';
        if (l.halo) l.halo.style.visibility = 'hidden';
        return;
      }
      const { group, pts } = eye.anchors[l.part];
      group.getWorldPosition(c);
      const [cx, cy] = project(c);
      let best = null;
      for (const pt of pts) {
        v.copy(pt);
        group.localToWorld(v);
        const [x, y] = project(v);
        const score = vertical ? l.side * (x - cx) : l.side * (y - cy);
        if (!best || score > best.score) best = { x, y, score };
      }
      const gap = vertical ? Math.max(28, W * 0.07) : Math.max(36, H * 0.075);
      let lx = vertical ? best.x + l.side * gap : best.x;
      const ly = vertical ? best.y : best.y + l.side * gap;
      // Keep every label fully on screen.
      if (!l.width && document.fonts?.status === 'loaded') l.width = l.el.offsetWidth;
      const lw = l.width || 90;
      if (vertical) lx = l.side > 0 ? Math.min(lx, W - 12 - lw - 6) : Math.max(lx, 12 + lw + 6);
      else lx = clamp(lx, 12 + lw / 2, W - 12 - lw / 2);
      l.line.setAttribute('x1', best.x.toFixed(1));
      l.line.setAttribute('y1', best.y.toFixed(1));
      l.line.setAttribute('x2', lx.toFixed(1));
      l.line.setAttribute('y2', ly.toFixed(1));
      const len = Math.hypot(lx - best.x, ly - best.y) || 1;
      l.line.style.strokeDasharray = len.toFixed(1);
      l.line.style.strokeDashoffset = (len * (1 - lineIn)).toFixed(1);
      l.dot.setAttribute('cx', best.x.toFixed(1));
      l.dot.setAttribute('cy', best.y.toFixed(1));
      if (l.halo) {
        l.halo.setAttribute('cx', best.x.toFixed(1));
        l.halo.setAttribute('cy', best.y.toFixed(1));
        l.halo.style.visibility = op > 0.3 ? 'visible' : 'hidden';
      }
      // The name settles into place along the line as it fades in.
      const slide = (1 - textIn) * 8;
      const tx = lx - ((lx - best.x) / len) * slide;
      const ty = ly - ((ly - best.y) / len) * slide;
      const shift = vertical ? (l.side > 0 ? 'translate(6px, -50%)' : 'translate(calc(-100% - 6px), -50%)') : l.side > 0 ? 'translate(-50%, 6px)' : 'translate(-50%, calc(-100% - 6px))';
      l.el.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) ${shift}`;
    });
  }

  // Compile shaders up front so the first scroll into 3D doesn't stutter.
  resize(innerWidth, innerHeight);
  eye.setExplode(0);
  renderer.compile(scene, camera);

  return { resize, update, renderer };
}
