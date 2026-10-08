'use strict';

/**
 * cors.js — cross-origin access for a browser-hosted frontend.
 *
 *   app.use(require('./middleware/cors')());
 *
 * WHY THIS IS NEEDED AT ALL
 * The frontends are hosted on Vercel while this backend runs on a laptop. That
 * is a cross-origin request, so without these headers the browser refuses every
 * call before it reaches Express — and the failure surfaces in the console as a
 * network/CORS error, which reads exactly like "the backend is down". Nothing
 * in the server log shows anything wrong, because the request never arrived.
 *
 * THE DEMO PATH THIS ENABLES
 * A page served over HTTPS normally cannot call an http:// address, but
 * browsers class `http://localhost` as a *potentially trustworthy origin* and
 * exempt it. So an HTTPS Vercel frontend CAN talk to this server running on the
 * same machine as the browser — no tunnel, no hosting, no TLS certificate.
 * That is the cheapest way to demo the real pipeline, and it only needs CORS.
 *
 * ── HAND-ROLLED, AND WHY ────────────────────────────────────────────────────
 * The `cors` package would do this in one line. It is not used because it is
 * one more dependency to install on a machine that is about to be demoed from,
 * and because the allow-list logic below is the part worth reading — burying it
 * behind a config object makes it easy to end up with a permissive default
 * nobody reviewed.
 *
 * ── ORIGINS ARE ALLOW-LISTED, NEVER REFLECTED ───────────────────────────────
 * The lazy version of this file echoes back whatever Origin the request
 * carried, which allows *every* site on the internet. That is normally
 * mitigated by the browser's same-origin policy on credentials — but this API
 * serves patient screening data over a plain unauthenticated port, so any page
 * the demo laptop's browser visited could read it. The cost of an allow-list is
 * one env var; the cost of reflecting is a data-exposure bug that never shows
 * up in testing because every origin works.
 *
 * Configure with CORS_ALLOWED_ORIGINS, comma-separated, e.g.
 *   CORS_ALLOWED_ORIGINS=https://netrasetu.vercel.app,http://localhost:5173
 *
 * A `*.` prefix matches one level of subdomain on an otherwise exact host, so
 * `https://*.vercel.app` covers Vercel's per-deployment preview URLs without
 * opening up the whole scheme. It is deliberately NOT a general glob: matching
 * is anchored at both ends and the suffix must itself contain a dot, so a host
 * like `evil-vercel.app` or `vercel.app.attacker.com` does not match.
 *
 * ── NO CREDENTIALS ──────────────────────────────────────────────────────────
 * Access-Control-Allow-Credentials is deliberately NOT set. Nothing here uses
 * cookies or session auth, and turning it on would forbid the wildcard forms
 * above anyway. If auth is added later, this needs revisiting together with it,
 * not before.
 */

const DEV_DEFAULTS = [
  'http://localhost:5173',   // Vite dev
  'http://localhost:4173',   // Vite preview
  'http://localhost:3000',   // CRA / Next dev
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:3000',
];

// Vercel preview deployments get a fresh subdomain per push, so pinning one
// URL would break on the next deploy — mid-demo, most likely.
const DEMO_DEFAULTS = ['https://*.vercel.app'];

function parseOrigins(raw) {
  if (!raw) return [...DEV_DEFAULTS, ...DEMO_DEFAULTS];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * matches(origin, pattern)
 *
 * Exact match, or a single-label subdomain wildcard. Anchored at both ends:
 * `https://*.vercel.app` accepts `https://a.vercel.app` and rejects
 * `https://evil-vercel.app`, `https://vercel.app.attacker.com` and
 * `https://a.b.vercel.app`.
 */
function matches(origin, pattern) {
  if (pattern === origin) return true;
  const star = pattern.indexOf('://*.');
  if (star === -1) return false;

  const scheme = pattern.slice(0, star + 3);          // "https://"
  const suffix = pattern.slice(star + 4);             // ".vercel.app"
  if (!suffix.includes('.', 1)) return false;         // refuse "*.app"-style
  if (!origin.startsWith(scheme)) return false;

  const host = origin.slice(scheme.length);
  if (!host.endsWith(suffix)) return false;

  const label = host.slice(0, host.length - suffix.length);
  // Exactly one non-empty label, no dots, no port, no path.
  return label.length > 0 && !/[.:/]/.test(label);
}

module.exports = function cors(options = {}) {
  const allowed = options.origins || parseOrigins(process.env.CORS_ALLOWED_ORIGINS);

  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;

    // No Origin header means a same-origin request, curl, or a server-to-server
    // call (the PHC sync manager). Those are not browser cross-origin requests
    // and must pass through untouched — adding headers here would do nothing
    // useful and adding a REJECTION here would break the sync path entirely.
    if (!origin) return next();

    if (!allowed.some((p) => matches(origin, p))) {
      // Deliberately NOT a 403. An unlisted origin simply gets no CORS headers,
      // which is what makes the browser block it — the same outcome as having
      // no CORS at all. Returning an error status instead would let a page
      // distinguish "exists but not allowed" from "not there", and would also
      // break non-browser clients that happen to send an Origin header.
      return next();
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    // Vary: Origin, or a shared cache could serve one origin's allow header to
    // another origin — which either leaks access or breaks it, depending on
    // which way round the cache filled.
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods',
        'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers',
        req.headers['access-control-request-headers']
        || 'Content-Type,Authorization,X-Requested-With');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.sendStatus(204);
    }

    return next();
  };
};

module.exports.matches = matches;         // exported for the unit test
module.exports.DEV_DEFAULTS = DEV_DEFAULTS;
module.exports.DEMO_DEFAULTS = DEMO_DEFAULTS;
