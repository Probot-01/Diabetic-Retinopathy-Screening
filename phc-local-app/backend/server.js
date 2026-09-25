'use strict';

/**
 * server.js -- PHC local application backend (Task 0.1)
 *
 * Runs ON the Primary Health Centre machine, on localhost:4000. Must be fully
 * functional with zero connectivity (design doc §10): capture, quality gate,
 * both questionnaires and local queueing all work offline, and the sync manager
 * opportunistically drains the queue when the network returns.
 *
 * Endpoint shapes are defined in docs/api-contracts.md, "Local API". The route
 * bodies themselves are filled in by Task 3.2 -- this file only wires them up.
 */

// This service's .env, then the shared root .env -- by explicit path, see loadEnv.js.
require('./loadEnv');

const express = require('express');

const fs    = require('fs');
const https = require('https');

const patientsRouter = require('./routes/patients');
const capturesRouter = require('./routes/captures');
const syncRouter     = require('./routes/sync');
const authRouter     = require('./routes/auth');
const peerRouter     = require('./routes/peer');
const requireTechnician = require('./middleware/requireTechnician');
const localAuth      = require('./services/localAuth');

const PORT = parseInt(process.env.PORT || '4000', 10);

const app = express();

// CORS first, before json parsing and before every route, so it also covers
// /media (mask and Grad-CAM images the frontend fetches) and so a preflight
// OPTIONS is answered without being dragged through the body parser.
app.use(require('./middleware/cors')());

// Desktop <-> phone replication. Before the global JSON parser: its sealed
// image payloads exceed that parser's 100 KB limit (routes/peer.js).
app.use('/peer', peerRouter);

app.use(express.json());

// Requiring the DB module creates local.sqlite and applies schema.sql. Done at
// startup rather than lazily on first request so that a broken schema fails the
// server immediately, instead of surfacing mid-capture with a patient waiting.
require('./db/localDb');

/** Audit every read of patient data (design doc §11.1). Writes are logged where they happen. */
const auditReads = (entity) => (req, res, next) => {
  if (req.method === 'GET') localAuth.logAccess(req, 'read', entity, req.path === '/' ? null : req.path.slice(1));
  next();
};

app.use('/auth',     authRouter);
app.use('/patients', requireTechnician, auditReads('patients'), patientsRouter);
app.use('/captures', requireTechnician, auditReads('captures'), capturesRouter);
app.use('/sync',     requireTechnician, syncRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Offline-first: the sync manager drains the queue opportunistically in the
// background. Started only when this file is run as a server, never on a bare
// require -- otherwise importing the app in a test would silently start
// uploading real captures to whatever CENTRAL_API_URL happens to point at.
if (require.main === module && process.env.SYNC_DISABLED !== '1') {
  require('./services/syncManager').start();
}

// ── Error handling ───────────────────────────────────────────────────────────
// api-contracts.md: every non-2xx body is { error, message } -- never a bare
// string, never an HTML error page. The frontend switches on .error and only
// displays .message, so both fields have to be present on every failure path.

app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: `No route matches ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  console.error('[local] Unhandled error:', err);
  res.status(500).json({
    error: 'internal_error',
    message: err.message || 'Unexpected server error',
  });
});

/**
 * TLS (design doc §11.1: "TLS 1.2+ on every backend"), same scheme as central
 * (§A.14): set LOCAL_TLS_KEY_PATH and LOCAL_TLS_CERT_PATH (a self-signed pair
 * from scripts/generateDevCert.js is fine on a PHC LAN) and the server speaks
 * HTTPS only, refusing anything below TLS 1.2. The phone link does not depend
 * on it: /peer traffic is sealed end to end regardless (routes/peer.js).
 */
function createServer() {
  const keyPath = process.env.LOCAL_TLS_KEY_PATH;
  const certPath = process.env.LOCAL_TLS_CERT_PATH;
  if (keyPath && certPath) {
    return {
      tls: true,
      server: https.createServer({
        key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), minVersion: 'TLSv1.2',
      }, app),
    };
  }
  return { tls: false, server: require('http').createServer(app) };
}

if (require.main === module) {
  const { tls, server } = createServer();
  server.listen(PORT, () => {
    console.log(`local backend on ${tls ? 'https' : 'http'}://localhost:${PORT}`
      + ` (technician auth ${localAuth.LOCAL_AUTH_ENABLED ? 'ENFORCED' : 'not enforced -- set LOCAL_AUTH_ENABLED=true'})`);
    if (localAuth.LOCAL_AUTH_ENABLED && !tls) {
      console.warn('[local] auth is on over plain HTTP: tokens cross the LAN in clear (the /peer link is still sealed). Set LOCAL_TLS_KEY_PATH/LOCAL_TLS_CERT_PATH.');
    }
  });
}

app.createServer = createServer; // used by the TLS test

module.exports = app;
