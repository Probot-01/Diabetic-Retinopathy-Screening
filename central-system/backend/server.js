'use strict';

/**
 * server.js -- Central system backend (Task 0.1)
 *
 * The cloud side, on port 5000. Receives cases from every PHC's sync manager,
 * runs the grading pipeline, and serves the ophthalmologist and district-admin
 * interfaces.
 *
 * Endpoint shapes are defined in docs/api-contracts.md, "Central API". The
 * route bodies are filled in by Tasks 3.3, 3.5 and 3.7 -- this file only wires
 * them up.
 */

const path = require('path');

// This service's .env, then the shared root .env -- by explicit path, see loadEnv.js.
require('./loadEnv');

const express      = require('express');
const cookieParser = require('cookie-parser');

// Loaded first so a bad auth configuration (AUTH_ENABLED without JWT_SECRET,
// an invalid COOKIE_SAMESITE) stops the server at boot, not on first login.
const authConfig               = require('./services/authConfig');
const requireAuth              = require('./middleware/requireAuth');

const gradingQueue             = require('./services/gradingQueue');

const authRouter               = require('./routes/auth');

const casesRouter              = require('./routes/cases');
const ophthalmologistQueueRouter = require('./routes/ophthalmologistQueue');
const adminDashboardRouter     = require('./routes/adminDashboard');
const referralsRouter          = require('./routes/referrals');
const phcRouter                = require('./routes/phc');
const patientsRouter           = require('./routes/patients');
const notificationsRouter      = require('./routes/notifications');

const PORT = parseInt(process.env.PORT || '5000', 10);

const app = express();

// CORS first, before json parsing and before every route, so it also covers
// /media (mask and Grad-CAM images the frontend fetches) and so a preflight
// OPTIONS is answered without being dragged through the body parser.
app.use(require('./middleware/cors')());

app.use(express.json());
app.use(cookieParser());

// Baseline response headers. Small, hand-rolled for the same reason cors.js is
// (one fewer dependency on a machine about to be demoed from), and they matter
// once this serves patient data and images:
//   nosniff        a stored image must never be sniffed into something else
//   DENY           nothing here should ever be framed (clickjacking on the
//                  review controls)
//   no-referrer    a case URL carries a case id; do not leak it to other sites
//   no-store       browser and proxy caches must not keep patient JSON/images
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// GET /health is what the PHC sync manager polls as its network heartbeat
// before every transmission attempt (design doc §4.2), so it must stay
// dependency-free: no DB query, no MATLAB call. A health check that touches
// Postgres would report "offline" during a transient DB blip and stall every
// PHC's queue for reasons unrelated to reachability.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Auth is applied PER ROUTE inside each router, not here (backend plan §A.11):
// /auth/login and the PHC ingestion routes must stay reachable without a
// browser session.
app.use('/api/v1/auth',            authRouter);
app.use('/api/v1/cases',           casesRouter);
app.use('/api/v1/ophthalmologist', ophthalmologistQueueRouter);
app.use('/api/v1/admin',           adminDashboardRouter);
app.use('/api/v1/referrals',       referralsRouter);
app.use('/api/v1/phc',             phcRouter);
app.use('/api/v1/patients',        patientsRouter);
// Twilio delivery reports (§10.5). Authenticated by Twilio's request
// signature, not by a session -- see the route file.
app.use('/api/v1/notifications',   notificationsRouter);

// Case media (fundus images, Grad-CAM overlays). api-contracts.md's case-detail
// response returns imageUrl / gradCamOverlayUrl as paths under /media, so those
// paths have to actually resolve to files.
//
// Guarded like any other patient-data route (§A.3). The session is a cookie, so
// the browser sends it on <img> requests too and no signed-URL scheme is needed.
app.use('/media', requireAuth, express.static(path.join(__dirname, 'media')));

// ── Error handling ───────────────────────────────────────────────────────────
// api-contracts.md: every non-2xx body is { error, message }.

app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: `No route matches ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  console.error('[central] Unhandled error:', err);
  // The full error goes to the server log. The RESPONSE carries a generic
  // message in production: an unhandled error here is usually a database
  // error, and node-postgres messages quote table names, column names and
  // sometimes the offending value -- which is patient data.
  const expose = process.env.NODE_ENV !== 'production';
  res.status(500).json({
    error: 'internal_error',
    message: expose
      ? (err.message || 'Unexpected server error')
      : 'Unexpected server error. The details are in the server log.',
  });
});

// Task 8.3. Workers start on IMPORT, not just when this file is run directly.
// Several verification scripts require this module and call app.listen()
// themselves; if starting the queue lived only in the block below, those would
// enqueue cases that no worker ever picks up and sit on 'processing' forever —
// a hang with no error, which is the least debuggable failure available.
// Starting here costs nothing until something is actually enqueued.
gradingQueue.start();

if (require.main === module) {
  // Re-enqueue anything a previous run left mid-flight. The queue is in memory,
  // so without this a restart would strand every unfinished case on
  // 'processing' permanently: no retry, no error, no log line — a scan that
  // looks like it is about to be graded and never is. The database is the queue
  // of record; recovery is what makes that true.
  //
  // Deliberately NOT at import: recovery sweeps every stranded case in the
  // database, which is right when the server boots and wrong when a test
  // imports the app — that test would start grading unrelated real backlog.
  gradingQueue.recoverStranded().catch((err) =>
    console.error('[central] stranded-case recovery failed:', err.message));

  // §D: the same recovery, periodically, for cases that lose their job while
  // the server stays up. §E: keep the persistent MATLAB session alive (and
  // start it now if it is not running). Both main-block only, like recovery:
  // a test that imports the app must neither sweep real backlog nor launch
  // MATLAB.
  require('./services/gradingWatchdog').start();
  require('./services/matlabSessionSupervisor').start();
  // Same, for the Python segmentation worker. Its failure is the quiet one:
  // grading keeps working and every case just takes 17 s longer.
  require('./services/segWorkerSupervisor').start();
  // §G: daily district resource-model run (RESOURCE_MODEL_CRON).
  require('./services/resourceRecommendations').start();
  // §G.2's other half: the weekly SimEvents run that keeps the reference
  // model's recommendations validated rather than merely once-validated.
  require('./services/simulinkValidation').start();

  // §A.14: TLS when a key and certificate are configured (a self-signed pair
  // for the demo: `node scripts/generateDevCert.js`). Plain HTTP otherwise,
  // and it says so -- the Secure session cookie must not be relied on over
  // plain HTTP to anything but localhost.
  const TLS_KEY = process.env.TLS_KEY_PATH;
  const TLS_CERT = process.env.TLS_CERT_PATH;
  const useTls = !!(TLS_KEY && TLS_CERT);
  const onListen = () => {
    console.log(`central backend on ${useTls ? 'https' : 'http'}://localhost:${PORT}` +
      (useTls ? ' (TLS 1.2+)' : ' (NO TLS -- set TLS_KEY_PATH / TLS_CERT_PATH)'));
    console.log(`[central] auth: users ${authConfig.AUTH_ENABLED ? 'ENFORCED' : 'not enforced (AUTH_ENABLED=false)'}, ` +
      `PHC keys ${authConfig.PHC_AUTH_ENABLED ? 'ENFORCED' : 'not enforced (PHC_AUTH_ENABLED=false)'}`);
  };
  const server = useTls
    ? require('https').createServer({
      key: require('fs').readFileSync(TLS_KEY),
      cert: require('fs').readFileSync(TLS_CERT),
      minVersion: 'TLSv1.2',
    }, app).listen(PORT, onListen)
    : app.listen(PORT, onListen);

  // Let a case that is mid-MATLAB finish rather than killing it half-written.
  // Anything still queued stays 'processing' in the database and is picked up
  // by the next boot's recoverStranded().
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`[central] ${signal} — draining the grading queue`);
      await gradingQueue.stop({ drain: true });
      server.close(() => process.exit(0));
    });
  }
}

module.exports = app;
