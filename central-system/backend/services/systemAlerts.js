'use strict';

/**
 * systemAlerts.js -- raise / resolve / list operational alerts (backend plan
 * §E.3, §F). Backed by the system_alerts table.
 *
 *   await raiseAlert('matlab_session_down', '', 'Restart failed: ...')
 *   await resolveAlert('matlab_session_down')
 *   await openAlerts()
 *
 * Raising is idempotent per (kind, subject): an alert that is already open is
 * refreshed, not duplicated. Neither call throws -- an alerting failure must
 * never take down the component that was trying to report a problem; it is
 * logged instead.
 */

const pool = require('../db/pgClient');

async function raiseAlert(kind, subject, message) {
  try {
    await pool.query(`
      INSERT INTO system_alerts (kind, subject, message)
      VALUES ($1, $2, $3)
      ON CONFLICT (kind, subject) WHERE resolved_at IS NULL
      DO UPDATE SET message = EXCLUDED.message, last_seen_at = now(),
                    occurrences = system_alerts.occurrences + 1
    `, [kind, subject || '', message]);
  } catch (err) {
    console.error(`[systemAlerts] could not raise ${kind}/${subject}: ${err.message} ` +
      `(alert was: ${message})`);
  }
}

async function resolveAlert(kind, subject = '') {
  try {
    await pool.query(`
      UPDATE system_alerts SET resolved_at = now()
      WHERE kind = $1 AND subject = $2 AND resolved_at IS NULL
    `, [kind, subject]);
  } catch (err) {
    console.error(`[systemAlerts] could not resolve ${kind}/${subject}: ${err.message}`);
  }
}

async function openAlerts() {
  const { rows } = await pool.query(`
    SELECT kind, subject, message, first_seen_at, last_seen_at, occurrences
    FROM system_alerts WHERE resolved_at IS NULL ORDER BY first_seen_at
  `);
  return rows.map((r) => ({
    kind: r.kind,
    subject: r.subject || null,
    message: r.message,
    firstSeenAt: r.first_seen_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    occurrences: r.occurrences,
  }));
}

module.exports = { raiseAlert, resolveAlert, openAlerts };
