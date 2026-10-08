// A separable anatomical model of the right human eye (OD), in millimetres.
//
// Every structure is its own object, so the eye can be taken apart the way it
// is in dissection: an equatorial cut separates the anterior segment (cornea,
// iris, lens, ciliary body and the front of the sclera with the rectus muscle
// insertions) from the posterior eyecup (retina, choroid, sclera, optic nerve).
//
// Parts are modelled around +Y (anterior) and the whole eye is then turned so
// that +Y faces the viewer (+Z). In the finished orientation +X is nasal and
// +Y is superior; in the modelling frame superior is -Z.
import * as THREE from 'three';
import { RETINA_R, DISC, DISC_UV, irisCanvas, scleraCanvas, choroidCanvas, fibreCanvas, nerveCapCanvas, microCanvas } from './textures.js';
import { clamp, ease, smoothstep } from '../lib/math.js';
import { GLOBE_MM, LIMBUS_MM } from '../lib/frame.js';

const DEG = Math.PI / 180;
const V2 = (x, y) => new THREE.Vector2(Math.max(x, 1e-4), y);

const SCLERA_IN = 11.3;
const CHOROID = [11.28, 11.06];
const RETINA = [11.04, RETINA_R];
const T_LIMBUS = Math.asin(LIMBUS_MM / GLOBE_MM);

// Cornea: anterior radius 7.8 mm, posterior 7.0 mm, 0.55 mm thick at the apex.
const CORNEA_FRONT = { R: 7.8, cy: 5.32 };
const CORNEA_BACK = { R: 7.0, cy: 5.57 };
export const CORNEA_APEX = CORNEA_FRONT.cy + CORNEA_FRONT.R;

/** Points on a circle of radius R centred at (0, cy), polar angle t from +Y. */
function arc(R, cy, t0, t1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * (i / n);
    out.push(V2(R * Math.sin(t), cy + R * Math.cos(t)));
  }
  return out;
}

// LatheGeometry faces outward when the profile runs bottom → top; the inner
// surfaces below are listed top → bottom so they face into the eye.
const lathe = (points, mat, segs) => new THREE.Mesh(new THREE.LatheGeometry(points, segs), mat);

function tex(c, repeat = false) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Map the inner retina so the fundus image sits centred on the posterior pole. */
function fundusUV(geom) {
  const p = geom.attributes.position;
  const uv = geom.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(x, y, z) || 1;
    const alpha = Math.acos(clamp(-y / r, -1, 1));
    const beta = Math.atan2(-z, x);
    const s = (alpha / (Math.PI / 2)) * 0.5;
    uv.setXY(i, 0.5 + s * Math.cos(beta), 0.5 + s * Math.sin(beta));
  }
  uv.needsUpdate = true;
}

/** A rectus muscle stub: tendon at the insertion, muscle belly at the cut. */
function rectusGeometry(t0, psi, halfW) {
  const pos = [];
  const uv = [];
  const col = [];
  const idx = [];
  const tendon = new THREE.Color('#e8ddd2');
  const belly = new THREE.Color('#b0463a');
  const t1 = 90 * DEG;
  const r0 = GLOBE_MM + 0.01;
  const r1 = (u) => GLOBE_MM + 0.3 + 1.0 * u;
  const P = (t, w, r) => {
    const a = psi + w / (GLOBE_MM * Math.sin(t));
    return [r * Math.sin(t) * Math.cos(a), r * Math.cos(t), r * Math.sin(t) * Math.sin(a)];
  };
  const grid = (fn, nu, nv) => {
    const base = pos.length / 3;
    for (let i = 0; i <= nu; i++) {
      for (let j = 0; j <= nv; j++) {
        const [p, u] = fn(i / nu, j / nv);
        pos.push(...p);
        uv.push(j / nv, u);
        const c = tendon.clone().lerp(belly, smoothstep(0.1, 0.7, u));
        col.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const a = base + i * (nv + 1) + j;
        const b = a + nv + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  };
  const T = (u) => t0 + (t1 - t0) * u;
  const W = (v) => -halfW + 2 * halfW * v;
  grid((u, v) => [P(T(u), W(v), r1(u)), u], 20, 8);
  grid((u, v) => [P(T(u), W(v), r0), u], 20, 8);
  grid((u, v) => [P(T(u), -halfW, r0 + (r1(u) - r0) * v), u], 20, 2);
  grid((u, v) => [P(T(u), halfW, r0 + (r1(u) - r0) * v), u], 20, 2);
  grid((u, v) => [P(t1, W(u), r0 + (r1(1) - r0) * v), 1], 8, 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Fully separated offsets along the optical axis, mm. */
const OPEN = { cornea: 32, iris: 24, lens: 16, ciliary: 9, scleraA: 5, retina: -8, choroid: -17, scleraP: -26 };
/** Tilt toward the viewer so the discs read as faces, not edges. */
const PRESENT = { cornea: 24, iris: 22, lens: 18, ciliary: 14 };

export function buildEye({ quality, fundus }) {
  const high = quality === 'high';
  const segs = high ? 128 : 80;
  const pivot = new THREE.Group();
  const root = new THREE.Group();
  root.rotation.x = Math.PI / 2;
  pivot.add(root);

  const part = (name) => {
    const g = new THREE.Group();
    g.name = name;
    root.add(g);
    return g;
  };
  const P = {
    cornea: part('cornea'),
    iris: part('iris'),
    lens: part('lens'),
    ciliary: part('ciliary'),
    scleraA: part('scleraA'),
    retina: part('retina'),
    choroid: part('choroid'),
    scleraP: part('scleraP'),
  };

  const std = (o) => new THREE.MeshStandardMaterial(o);
  const cut = (color) => std({ color, roughness: 0.75, side: THREE.DoubleSide });
  // Fine surface relief so highlights break up like tissue, not plastic.
  const micro = new THREE.CanvasTexture(microCanvas());
  micro.wrapS = micro.wrapT = THREE.RepeatWrapping;
  micro.repeat.set(6, 3);
  const scleraMat = (c) =>
    new THREE.MeshPhysicalMaterial({
      map: tex(c, true),
      bumpMap: micro,
      bumpScale: 0.35,
      roughness: 0.42,
      clearcoat: 0.45,
      clearcoatRoughness: 0.35,
      sheen: 0.35,
      sheenRoughness: 0.7,
      sheenColor: new THREE.Color('#ffe4da'),
    });

  // ── anterior sclera, with the rectus insertions ──
  P.scleraA.add(lathe(arc(GLOBE_MM, 0, 90 * DEG, T_LIMBUS, 40), scleraMat(scleraCanvas('anterior')), segs));
  P.scleraA.add(lathe(arc(SCLERA_IN, 0, T_LIMBUS, 90 * DEG, 40), std({ color: '#3b2219', roughness: 0.8 }), segs));
  P.scleraA.add(lathe([V2(SCLERA_IN, 0), V2(GLOBE_MM, 0)], cut('#e6d8c6'), segs));
  P.scleraA.add(
    lathe([V2(SCLERA_IN * Math.sin(T_LIMBUS), SCLERA_IN * Math.cos(T_LIMBUS)), V2(LIMBUS_MM, GLOBE_MM * Math.cos(T_LIMBUS))], cut('#e6d8c6'), segs),
  );
  const fibres = tex(fibreCanvas());
  const muscleMat = std({ map: fibres, vertexColors: true, roughness: 0.55, side: THREE.DoubleSide });
  // Insertion distance from the limbus (mm) and direction: medial, inferior, lateral, superior.
  const muscles = [];
  for (const [mm, psi] of [[5.5, 0], [6.5, 90], [6.9, 180], [7.7, -90]]) {
    const m = new THREE.Mesh(rectusGeometry(T_LIMBUS + mm / GLOBE_MM, psi * DEG, 5), muscleMat);
    muscles.push(m);
    P.scleraA.add(m);
  }

  // ── posterior eyecup: sclera, choroid, retina ──
  P.scleraP.add(lathe(arc(GLOBE_MM, 0, 180 * DEG, 90 * DEG, 48), scleraMat(scleraCanvas('posterior')), segs));
  P.scleraP.add(lathe(arc(SCLERA_IN, 0, 90 * DEG, 180 * DEG, 48), std({ color: '#8a6a58', roughness: 0.85 }), segs));
  P.scleraP.add(lathe([V2(SCLERA_IN, 0), V2(GLOBE_MM, 0)], cut('#e6d8c6'), segs));

  const choroidTex = tex(choroidCanvas(), true);
  P.choroid.add(lathe(arc(CHOROID[0], 0, 180 * DEG, 90 * DEG, 48), std({ map: choroidTex, roughness: 0.6 }), segs));
  P.choroid.add(lathe(arc(CHOROID[1], 0, 90 * DEG, 180 * DEG, 48), std({ color: '#3a0e08', roughness: 0.7 }), segs));
  P.choroid.add(lathe([V2(CHOROID[1], 0), V2(CHOROID[0], 0)], cut('#6e1c10'), segs));

  const fundusTex = tex(fundus);
  const retinaMat = std({ map: fundusTex, emissiveMap: fundusTex, emissive: '#ffffff', emissiveIntensity: 0.1, roughness: 0.5 });
  // The living retina: a heartbeat travels out from the disc along the
  // arteries (the veins swell faintly just after), and faint signals run in
  // along the nerve fibre layer toward the disc. `life.live` fades it in.
  const life = { time: { value: 0 }, live: { value: 0 } };
  if (fundus.vesselMask) {
    const masks = { uVessels: { value: new THREE.CanvasTexture(fundus.vesselMask) }, uFibres: { value: new THREE.CanvasTexture(fundus.fibreMask) } };
    const disc = { value: new THREE.Vector2(DISC_UV.x, DISC_UV.y) };
    retinaMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, masks, { uTime: life.time, uLive: life.live, uDisc: disc });
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime;
          uniform float uLive;
          uniform sampler2D uVessels;
          uniform sampler2D uFibres;
          uniform vec2 uDisc;`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          if (uLive > 0.001) {
            vec3 vm = texture2D(uVessels, vMapUv).rgb;
            vec2 fm = texture2D(uFibres, vMapUv).rg;
            float d = distance(vMapUv, uDisc);
            // A slow, calm pulse, about 37 beats a minute.
            float beat = fract(uTime * 0.62 - d * 1.8);
            float pulse = exp(-beat * 5.0);
            float echo = exp(-fract(beat - 0.22 + 1.0) * 4.5);
            totalEmissiveRadiance += vec3(1.0, 0.32, 0.16) * vm.r * pulse * 0.38 * uLive;
            totalEmissiveRadiance += vec3(0.55, 0.12, 0.08) * vm.g * echo * 0.2 * uLive;
            float sig = fract(d * 9.0 + uTime * 0.2 + fm.g * 3.0);
            sig = smoothstep(0.0, 0.05, sig) * (1.0 - smoothstep(0.05, 0.22, sig));
            totalEmissiveRadiance += vec3(1.0, 0.86, 0.66) * fm.r * sig * 0.32 * uLive;
          }`,
        );
    };
  }
  const inner = new THREE.LatheGeometry(arc(RETINA[1], 0, 90 * DEG, 180 * DEG, high ? 72 : 48), segs);
  fundusUV(inner);
  P.retina.add(new THREE.Mesh(inner, retinaMat));
  P.retina.add(lathe(arc(RETINA[0], 0, 180 * DEG, 90 * DEG, 48), std({ color: '#2a130c', roughness: 0.8 }), segs));
  P.retina.add(lathe([V2(RETINA[1], 0), V2(RETINA[0], 0)], cut('#d98a70'), segs));

  // ── optic nerve, leaving the globe at the disc, 4.5 mm nasal to the fovea ──
  const a = DISC.x / RETINA_R;
  const e = DISC.y / RETINA_R;
  const d = new THREE.Vector3(Math.sin(a), -Math.cos(a) * Math.cos(e), -Math.sin(e)).normalize();
  const n0 = d.clone().multiplyScalar(11.6);
  const n1 = d.clone().multiplyScalar(15.5);
  const n2 = n1.clone().add(new THREE.Vector3(0.6, -4, 0.1));
  const n3 = n2.clone().add(new THREE.Vector3(1.4, -5, 0.3));
  const path = new THREE.CatmullRomCurve3([n0, n1, n2, n3]);
  const nerveMat = std({ color: '#e7d9c1', roughness: 0.62 });
  const nerve = new THREE.Mesh(new THREE.TubeGeometry(path, 40, 2.05, 28, false), nerveMat);
  P.scleraP.add(nerve);
  const cap = new THREE.Mesh(new THREE.CircleGeometry(2.05, 40), std({ map: tex(nerveCapCanvas()), roughness: 0.7 }));
  cap.position.copy(n3);
  cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), path.getTangent(1));
  P.scleraP.add(cap);

  // ── cornea ──
  const tcf = Math.asin(LIMBUS_MM / CORNEA_FRONT.R);
  const tcb = Math.asin(5.5 / CORNEA_BACK.R);
  // Clear glass: almost invisible looking straight through, brighter toward
  // the edges where the surface turns away (a Fresnel rim). Transmission reads
  // as milky once the cornea is lifted away with nothing opaque behind it.
  const corneaMat = new THREE.MeshPhysicalMaterial({
    transparent: true,
    opacity: 0.5,
    roughness: 0.03,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    color: '#eaf6fb',
    envMapIntensity: 1.4,
    depthWrite: false,
  });
  corneaMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
      float rim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.4);
      gl_FragColor.a *= mix(0.14, 1.0, rim);
      gl_FragColor.rgb += vec3(0.55, 0.66, 0.72) * rim * 0.35;`,
    );
  };
  P.cornea.add(lathe(arc(CORNEA_FRONT.R, CORNEA_FRONT.cy, tcf, 0, 36), corneaMat, segs));
  P.cornea.add(lathe(arc(CORNEA_BACK.R, CORNEA_BACK.cy, 0, tcb, 36), corneaMat, segs));
  P.cornea.add(
    lathe([V2(5.5, CORNEA_BACK.cy + CORNEA_BACK.R * Math.cos(tcb)), V2(LIMBUS_MM, CORNEA_FRONT.cy + CORNEA_FRONT.R * Math.cos(tcf))], corneaMat, segs),
  );

  // ── iris: pupil 3.2 mm, sitting on the front of the lens ──
  const irisFront = [];
  const irisBack = [];
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    irisFront.push(V2(5.55 + (1.6 - 5.55) * u, 9.42 + 0.3 * u + 0.07 * Math.sin(Math.PI * u)));
    irisBack.push(V2(1.6 + (5.55 - 1.6) * u, 9.56 - 0.36 * u));
  }
  const irisBackMat = std({ color: '#24120a', roughness: 0.8 });
  // The iris texture doubles as its relief: crypts sink, fibres stand proud.
  const irisTex = tex(irisCanvas(), true);
  P.iris.add(lathe(irisFront, std({ map: irisTex, bumpMap: irisTex, bumpScale: 1.4, roughness: 0.6 }), segs));
  P.iris.add(lathe(irisBack, irisBackMat, segs));
  P.iris.add(lathe([V2(1.6, 9.72), V2(1.6, 9.56)], irisBackMat, segs));
  P.iris.add(lathe([V2(5.55, 9.2), V2(5.55, 9.42)], irisBackMat, segs));

  // ── lens: biconvex, 9.5 mm across, 4 mm thick, steeper at the back ──
  const back = arc(6, 11.55, 180 * DEG, 180 * DEG - Math.asin(4.6 / 6), 20);
  const front = arc(10, -0.45, Math.asin(4.6 / 10), 0, 20);
  const lensProfile = [...back, V2(4.7, 7.88), V2(4.76, 8.07), V2(4.7, 8.26), ...front];
  const lensMat = high
    ? new THREE.MeshPhysicalMaterial({
        transmission: 0.95,
        thickness: 4,
        ior: 1.42,
        roughness: 0.06,
        color: '#fff6de',
        attenuationColor: new THREE.Color('#f1d496'),
        attenuationDistance: 10,
        clearcoat: 0.6,
      })
    : new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0.42, color: '#f1ddb0', roughness: 0.1, clearcoat: 0.8, depthWrite: false });
  P.lens.add(lathe(lensProfile, lensMat, segs));

  // ── ciliary body, with ~70 radial ciliary processes on its inner face ──
  const cil = [...arc(11.26, 0, 62 * DEG, 31 * DEG, 16), V2(5.4, 9.5), V2(5.25, 9.2), V2(5.55, 8.85), V2(6.2, 8.25), V2(7.3, 7.4), V2(8.5, 6.5), V2(9.6, 5.55)];
  cil.push(cil[0].clone());
  const cilSegs = high ? 360 : 216;
  const cilGeom = new THREE.LatheGeometry(cil, cilSegs);
  {
    const pos = cilGeom.attributes.position;
    const weight = { 18: 0.5, 19: 1, 20: 1, 21: 0.45 };
    for (let i = 0; i <= cilSegs; i++) {
      const ridge = Math.max(0, Math.cos((i / cilSegs) * Math.PI * 2 * 72)) ** 4;
      for (const [j, w] of Object.entries(weight)) {
        const vi = i * cil.length + Number(j);
        const x = pos.getX(vi), z = pos.getZ(vi);
        const r = Math.hypot(x, z) || 1;
        const s = (r - 0.55 * ridge * w) / r;
        pos.setXYZ(vi, x * s, pos.getY(vi), z * s);
      }
    }
    cilGeom.computeVertexNormals();
  }
  P.ciliary.add(new THREE.Mesh(cilGeom, std({ color: '#43241a', roughness: 0.5 })));

  // ── zonular fibres between the ciliary processes and the lens equator ──
  const Z = high ? 120 : 72;
  const zGeom = new THREE.BufferGeometry();
  const zPos = new Float32Array(Z * 6);
  zGeom.setAttribute('position', new THREE.BufferAttribute(zPos, 3));
  const zMat = new THREE.LineBasicMaterial({ color: '#f1e6d2', transparent: true, opacity: 0.45 });
  const zonules = new THREE.LineSegments(zGeom, zMat);
  zonules.frustumCulled = false;
  root.add(zonules);
  const zAnchors = Array.from({ length: Z }, (_, i) => {
    const ph = (i / Z) * Math.PI * 2;
    const yc = 8.6 + ((i % 3) - 1) * 0.35;
    const yl = 8.07 + ((i % 3) - 1) * 0.3;
    return { c: [5.72 * Math.sin(ph), yc, 5.72 * Math.cos(ph)], l: [4.66 * Math.sin(ph), yl, 4.66 * Math.cos(ph)] };
  });

  // Seen through the pupil, the inside of a closed eye is dark. This stands in
  // for that darkness while the eye is whole and is removed once it opens.
  const pupilStop = new THREE.Mesh(new THREE.CircleGeometry(3.2, 40), new THREE.MeshBasicMaterial({ color: '#050303' }));
  pupilStop.rotation.x = -Math.PI / 2;
  pupilStop.position.y = 5.2;
  root.add(pupilStop);

  // Tag each mesh with the structure it belongs to, for pointing and labels.
  // Both halves of the sclera are one structure; the muscles carry no tag.
  for (const [name, g] of Object.entries(P)) {
    g.traverse((m) => {
      if (m.isMesh) m.userData.part = name === 'scleraP' ? 'scleraA' : name;
    });
  }
  nerve.userData.part = 'nerve';
  cap.userData.part = 'nerve';
  for (const m of muscles) m.userData.part = null;

  // Per-part materials, so each part can fade on its own.
  for (const g of Object.values(P)) {
    g.traverse((m) => {
      if (!m.isMesh) return;
      const shared = m.material;
      m.material = shared.clone();
      // clone() does not carry shader hooks over.
      m.material.onBeforeCompile = shared.onBeforeCompile;
      m.material.userData.baseOpacity = m.material.opacity;
      m.material.userData.baseTransparent = m.material.transparent;
      m.material.userData.baseColor = m.material.color.clone();
      m.material.userData.baseEnv = m.material.envMapIntensity ?? 1;
    });
  }

  const offsets = {};
  let lastExplode = -1;

  function setExplode(e, drift = 0) {
    const open = ease.inOutCubic(clamp(e / 0.2));
    const st = (a, b) => ease.inOutCubic(clamp((e - a) / (b - a)));
    const ant = 6 * open;
    const post = -4 * open;
    offsets.cornea = ant + (OPEN.cornea - 6) * st(0.15, 0.45);
    offsets.iris = ant + (OPEN.iris - 6) * st(0.25, 0.55);
    offsets.lens = ant + (OPEN.lens - 6) * st(0.35, 0.65);
    offsets.ciliary = ant + (OPEN.ciliary - 6) * st(0.4, 0.7);
    offsets.scleraA = ant + (OPEN.scleraA - 6) * st(0.45, 0.72);
    offsets.retina = post + (OPEN.retina + 4) * st(0.55, 0.9);
    offsets.choroid = post + (OPEN.choroid + 4) * st(0.6, 0.92);
    offsets.scleraP = post + (OPEN.scleraP + 4) * st(0.65, 0.95);
    for (const k of ['cornea', 'iris', 'lens', 'ciliary', 'scleraA']) offsets[k] += drift * 14;
    for (const k of ['choroid', 'scleraP']) offsets[k] -= drift * 6;
    for (const [k, g] of Object.entries(P)) {
      g.position.y = offsets[k];
      g.rotation.z = -(PRESENT[k] || 0) * DEG * st(0.2, 0.8);
    }
    pupilStop.visible = e < 0.005;

    if (e !== lastExplode || drift) {
      lastExplode = e;
      const lensM = P.lens.matrix;
      const cilM = P.ciliary.matrix;
      P.lens.updateMatrix();
      P.ciliary.updateMatrix();
      const v = new THREE.Vector3();
      zAnchors.forEach((z, i) => {
        v.set(...z.c).applyMatrix4(cilM);
        zPos.set([v.x, v.y, v.z], i * 6);
        v.set(...z.l).applyMatrix4(lensM);
        zPos.set([v.x, v.y, v.z], i * 6 + 3);
      });
      zGeom.attributes.position.needsUpdate = true;
      // The fibres stretch as the lens pulls away, then let go.
      const gap = Math.abs(offsets.lens - offsets.ciliary);
      zMat.opacity = 0.45 * (1 - smoothstep(4, 7.5, gap));
      zonules.visible = zMat.opacity > 0.01;
    }
  }

  // Parts step back by dimming into the dark while staying solid, and only
  // turn transparent at the very end — half-transparent solids show their
  // insides through each other and read as clutter.
  const DARK = new THREE.Color('#0d0c0b');
  function fadePart(name, o) {
    P[name].visible = o > 0.01;
    const shade = 0.1 + 0.9 * smoothstep(0.2, 1, o);
    const alpha = smoothstep(0, 0.25, o);
    P[name].traverse((m) => {
      if (!m.isMesh) return;
      const mat = m.material;
      const u = mat.userData;
      mat.color.copy(u.baseColor).lerp(DARK, 1 - shade);
      mat.envMapIntensity = u.baseEnv * shade;
      const needT = alpha < 0.999 || u.baseTransparent;
      if (mat.transparent !== needT) {
        mat.transparent = needT;
        mat.needsUpdate = true;
      }
      mat.opacity = u.baseOpacity * alpha;
    });
  }

  const byTag = {};
  root.traverse((m) => {
    if (m.isMesh && m.userData.part) (byTag[m.userData.part] ||= []).push(m);
  });
  /** Warm the named structure's surfaces by k (0–1). */
  function highlight(tag, k) {
    for (const m of byTag[tag] || []) {
      if (m.material.emissiveMap) continue;
      m.material.emissive?.setRGB(0.4 * k, 0.22 * k, 0.12 * k);
    }
  }

  // Label anchors: a ring of candidate points per part (in part space). The
  // label picks whichever lands furthest toward its side of the screen.
  const ring = (r, y, n = 16) => Array.from({ length: n }, (_, i) => {
    const ph = (i / n) * Math.PI * 2;
    return new THREE.Vector3(r * Math.sin(ph), y, r * Math.cos(ph));
  });
  const anchors = {
    cornea: { group: P.cornea, pts: ring(LIMBUS_MM, 10.6) },
    iris: { group: P.iris, pts: ring(5.3, 9.5) },
    lens: { group: P.lens, pts: ring(4.7, 8.07) },
    ciliary: { group: P.ciliary, pts: ring(8, 7.6) },
    scleraA: { group: P.scleraA, pts: ring(11.9, 3) },
    retina: { group: P.retina, pts: ring(RETINA[1], 0.1) },
    choroid: { group: P.choroid, pts: ring(CHOROID[0], 0.1) },
    nerve: { group: P.scleraP, pts: ring(2.1, 0).map((p) => p.add(n2)) },
  };

  return {
    pivot,
    root,
    parts: P,
    offsets,
    anchors,
    retinaMaterial: P.retina.children[0].material,
    setExplode,
    fadePart,
    highlight,
    life,
    corneaApex: CORNEA_APEX,
  };
}
