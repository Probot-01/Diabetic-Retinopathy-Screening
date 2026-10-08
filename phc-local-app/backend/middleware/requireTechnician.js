'use strict';

/**
 * requireTechnician -- guards every patient-data route on the PHC local backend.
 * See services/localAuth.js for the LOCAL_AUTH_ENABLED rollout behaviour.
 * requireTechnician.admin additionally requires the phc_admin role.
 */
const auth = require('../services/localAuth');

function requireTechnician(req, res, next) {
  const token = auth.bearer(req);
  if (!token) {
    if (!auth.LOCAL_AUTH_ENABLED) return next();
    return res.status(401).json({ error: 'unauthenticated', message: 'Log in first (Authorization: Bearer <token>).' });
  }
  const s = auth.readSession(token);
  if (!s) {
    return res.status(401).json({ error: 'session_invalid', message: 'Session expired or invalid. Log in again.' });
  }
  req.user = s.user;
  req.sessionDeviceId = s.deviceId;
  return next();
}

requireTechnician.admin = function requireAdmin(req, res, next) {
  requireTechnician(req, res, () => {
    if (!auth.LOCAL_AUTH_ENABLED && !req.user) return next();
    if (req.user?.role !== 'phc_admin') {
      return res.status(403).json({ error: 'forbidden', message: 'PHC admin role required.' });
    }
    return next();
  });
};

module.exports = requireTechnician;
