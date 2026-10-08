'use strict';

/**
 * syncState.js
 *
 * In-memory connectivity flag, shared between the sync manager (Task 3.4,
 * which performs the heartbeat) and GET /sync/status (Task 3.2, which reports
 * it).
 *
 * Kept in memory rather than in the database on purpose: "is the network up
 * right now" is true of this process at this moment, not a fact about the
 * screening record. Persisting it would mean a restarted server confidently
 * reporting a connectivity state it has not actually observed.
 *
 * Before Task 3.4 exists, no heartbeat has run, so `online` is false and
 * `lastSyncAttempt` is null. That is the honest answer -- not a placeholder --
 * because nothing has tried to reach the central server yet. The Sync Status
 * indicator is always on screen (design doc §4.1), and showing an optimistic
 * "online" that nothing verified is worse than showing offline: the technician
 * uses it to decide whether the patient can wait for a result.
 */

let online          = false;
let lastSyncAttempt = null;   // ISO 8601 UTC string, or null if never attempted

/** Record the outcome of a heartbeat / sync attempt. Called by Task 3.4. */
function recordAttempt(isOnline, whenIso = new Date().toISOString()) {
  online          = !!isOnline;
  lastSyncAttempt = whenIso;
}

/** Current connectivity view, for GET /sync/status. */
function getState() {
  return { online, lastSyncAttempt };
}

module.exports = { recordAttempt, getState };
