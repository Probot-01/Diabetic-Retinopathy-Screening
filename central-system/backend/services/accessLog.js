'use strict';

/**
 * accessLog.js -- the access_log writer (backend plan §A.13, design doc §11.1).
 *
 *   await logAccess(userId, action, resourceType, resourceId)
 *
 * Called EXPLICITLY from each handler that reads or writes patient data, never
 * inferred from the URL by middleware -- a route rename would silently change
 * what an inferred log records.
 *
 * userId null means no one is logged in, which only happens while
 * AUTH_ENABLED=false. Nothing is written then: a row with no user says nothing
 * about who accessed what, and user_id is NOT NULL for exactly that reason.
 *
 * A failed write is logged loudly but does not fail the request. The clinical
 * action (a review, say) has usually already committed by the time this runs,
 * and reporting it as failed would make a reviewer enter it twice.
 */

const pool = require('../db/pgClient');

async function logAccess(userId, action, resourceType, resourceId = null) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO access_log (user_id, action, resource_type, resource_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, action, resourceType, resourceId == null ? null : String(resourceId)]);
  } catch (err) {
    console.error(`[accessLog] FAILED to record ${action} ${resourceType}/${resourceId} ` +
      `by ${userId}: ${err.message}`);
  }
}

module.exports = { logAccess };
