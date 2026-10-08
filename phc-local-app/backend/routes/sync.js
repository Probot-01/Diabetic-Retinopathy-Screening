'use strict';

/**
 * routes/sync.js  (Task 3.2)
 *
 * Mounted at /sync. Implements the "Local API" sync endpoint from
 * docs/api-contracts.md:
 *
 *   GET /sync/status -> 200 { online, pendingCount, awaitingFormsCount, lastSyncAttempt, lastError }
 *
 * The Sync Status indicator is always visible in the local UI (design doc
 * §4.1), so the frontend polls this continuously. Both queries below are
 * therefore deliberately cheap -- a COUNT and a MAX over an indexed column, no
 * joins. Anything heavier here is paid for on every poll, on modest PHC
 * hardware, forever.
 */

const express = require('express');

const db         = require('../db/localDb');
const syncState  = require('../services/syncState');
const { countPending, countAwaitingForms } = require('../services/syncReadiness');

const router = express.Router();

router.get('/status', (req, res) => {
  // pendingCount = captures READY to upload (forms complete, not yet accepted by
  // central). Passed-the-gate captures still waiting for a questionnaire are
  // counted apart, as awaitingFormsCount: they are queued but cannot go yet.
  const n = countPending();

  // The most recent reason a capture is still pending (central refused it, was
  // unreachable mid-upload...). null when nothing is failing.
  const err = db.prepare(
    "SELECT capture_id, error_kind, last_error, updated_at FROM sync_queue " +
    "WHERE status = 'pending' AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get();

  // MAX over the whole queue, not just pending rows: "when did we last try"
  // stays meaningful after a successful drain empties the pending set.
  const { last } = db.prepare(
    'SELECT MAX(last_attempt_at) AS last FROM sync_queue').get();

  const state = syncState.getState();

  res.json({
    online:       state.online,
    pendingCount: n,
    awaitingFormsCount: countAwaitingForms(),
    lastError: err
      ? { captureId: err.capture_id, kind: err.error_kind, message: err.last_error, at: err.updated_at }
      : null,
    // null when no attempt has ever been made, per the contract. Prefer the
    // in-memory value (this process's own last attempt) and fall back to the
    // durable one from the queue, so a restart does not erase the fact that
    // syncing has happened at some point.
    lastSyncAttempt: state.lastSyncAttempt || last || null,
  });
});

module.exports = router;
