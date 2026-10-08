# NetrSetu — landing experience (experimental)

A single scroll-driven page that tells NetrSetu's story before handing people
to the app: a farmer in a pencil-sketch field → a breeze that becomes an eye →
the blink that brings the world into colour → the eye in anatomical 3D →
taken apart layer by layer → into the retina → **Ophthalmologist / Nurse**.

```bash
npm install
npm run dev      # http://localhost:5180
npm run build    # static site in dist/
```

The role buttons lead to the existing frontends. Defaults are in `.env`
(central app on `:5173`, PHC app on `:5174`); override them with
`VITE_OPHTHALMOLOGIST_URL` / `VITE_NURSE_URL`.

## How it is built

| Part | Where | How |
| --- | --- | --- |
| Rural scene | `src/intro/world.js` | Procedural 2D canvas. Painted twice from one seed — graphite and watercolour — so the blink can reveal colour stroke for stroke. The farmer is a jointed figure (IK arms and legs) swinging a hoe. |
| Breeze → eye | `src/intro/eye.js` | Each strand slides along a track that ends exactly on an eyelid or iris curve, so the wind lays itself into the eye. |
| Timeline | `src/intro/intro.js` | Opening sequence in seconds. Scrolling or tapping fast-forwards it. |
| 3D eye | `src/anatomy/model.js` | three.js, loaded lazily while the intro plays. See below. |
| Textures | `src/anatomy/textures.js` | Fundus, iris, sclera and choroid painted on canvases. |
| Scroll story | `src/anatomy/anatomy.js`, `src/main.js` | Everything is a function of the scroll position, so scrolling back plays it in reverse. |

### Why the eye is modelled rather than downloaded

The story needs the eye to come apart into real, separate structures. Stock
eye models are usually one fused mesh, or invent their inner parts. This
model builds each structure as its own object, from typical adult dimensions
for a right eye:

- **Anterior segment:** cornea, iris (3.2 mm pupil), biconvex lens (9.5 × 4 mm),
  ciliary body with its processes, zonular fibres, and the front of the sclera
  with the four rectus muscle insertions.
- **Posterior eyecup:** retina, choroid, sclera, and the optic nerve leaving
  4.5 mm nasal to the fovea.

It separates at the equator, the way an eye is opened in dissection. The
retina carries a healthy fundus: disc, macula and fovea, and branching
arcades. No lesions are drawn and nothing clinical is implied.

## Motion and interaction

- **Scroll** is followed on a critically damped spring: it eases into motion,
  never overshoots, and big jumps play through at a legible speed. The camera
  stages overlap, so the flight never stops between them. The one deliberate
  pause is on the opened eye.
- **The drawn eye follows the pointer** after the intro, in quick
  saccade-like jumps. The 3D eye gets gentle pointer parallax.
- **The opened eye is explorable:** pointing at a structure, or its label,
  lights it up and shows a one-line description of what it does.
- **A chapter rail** on the right shows where you are and jumps between
  chapters.
- **Performance:** the illustration is repainted only while the colour
  spreads. Style writes are skipped when nothing changed. The 3D resolution
  is capped, and lowers itself if frames start dropping.
- **Resilience:** if a frame throws, the error is logged once and the story
  carries on. If errors persist, the page falls back to its plain form with
  the two role links.

## Debug views

| URL | Shows |
| --- | --- |
| `?t=6.2` | The intro frozen at 6.2 s |
| `?s=5.7` | The scroll story frozen at 5.7 screens (0 intro → 10 roles) |
| `?live` | The real timeline, kept running even in a hidden tab (for automated checks) |
| `?reduced` | The reduced-motion version |
| `?nogl` | The fallback used when WebGL is unavailable |

## Accessibility and fallbacks

- A **Skip to sign in** link is always available. It jumps to the role choice
  and focuses it.
- `prefers-reduced-motion` gets the finished scene, and the story moves in
  still steps.
- Without WebGL, the retina is shown as a flat image with the same choices.
- Without JavaScript, the page is the name and the two role links.
