// Shared geometry for the hand-off from the drawn eye to the 3D eye. The intro
// needs these numbers before three.js has loaded, so they live here.

export const FRONT_FOV = 30; // degrees, vertical
export const GLOBE_MM = 12; // globe radius
export const LIMBUS_MM = 5.85; // visible iris radius, where cornea meets sclera
export const LIMBUS_Z = 10.48; // distance of the limbus plane in front of the globe centre

/**
 * Camera distance for the straight-on view, chosen so the globe fills a set
 * share of the screen, plus where the globe and limbus land in pixels.
 */
export function frontMetrics(W, H) {
  const f = H / 2 / Math.tan((FRONT_FOV * Math.PI) / 360);
  const globePx = Math.min(W, H) * (W / H < 0.9 ? 0.3 : 0.2);
  const D = GLOBE_MM / Math.sin(Math.atan(globePx / f));
  const limbusPx = (LIMBUS_MM * f) / (D - LIMBUS_Z);
  return { f, globePx, limbusPx, D };
}
