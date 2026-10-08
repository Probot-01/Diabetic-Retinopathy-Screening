'use strict';

/**
 * routes/referrals.js
 *
 * Mounted at /api/v1/referrals.
 *
 *   PATCH /api/v1/referrals/:referralId
 *     Request  { status, assignedWorker }
 *     Response 200 — the updated referral, same shape as a
 *                    GET /api/v1/admin/referrals list item.
 *
 * Referral CREATION and the patient SMS belong to Task 3.6
 * (referralNotificationService.js) and are deliberately not here. This endpoint
 * only advances the tracking state of a referral that already exists.
 *
 * The whole point of this table is making loss-to-follow-up VISIBLE (design doc
 * §9.3): referred -> contacted -> attended, with 'lost' as a terminal state.
 * 'lost' is a real outcome to record, not an error to suppress — a screening
 * program that cannot count the patients it failed to reach cannot improve.
 */

const express = require('express');
const analytics = require('../services/analyticsAggregator');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { logAccess } = require('../services/accessLog');

const router = express.Router();

// manual_follow_up (design doc §10.5) is set automatically when an SMS cannot
// be delivered; it is listed here so a worker can also set it by hand.
const STATUSES = ['referred', 'manual_follow_up', 'contacted', 'attended', 'lost'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// District admin: the Referral Tracker is an admin screen (design doc §5.3).
router.patch('/:referralId', requireAuth, requireRole('district_admin'), async (req, res, next) => {
  const { referralId } = req.params;
  const { status, assignedWorker } = req.body || {};

  // Postgres raises 22P02 on a malformed UUID rather than returning no rows,
  // which would surface as a 500 for what is really a bad request.
  if (!UUID_RE.test(referralId)) {
    return res.status(404).json({
      error: 'referral_not_found', message: `No referral with id ${referralId}`,
    });
  }

  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({
      error: 'invalid_field',
      message: `status must be one of: ${STATUSES.join(', ')} — got '${status}'.`,
    });
  }

  if (status === undefined && assignedWorker === undefined) {
    return res.status(400).json({
      error: 'no_fields_to_update',
      message: 'Supply status, assignedWorker, or both.',
    });
  }

  try {
    // assignedWorker is forwarded only when the key was actually present, so
    // that omitting it leaves the current worker alone while sending an
    // explicit null unassigns them. Collapsing those two into one behaviour
    // would silently wipe the assignment on every status-only update.
    const patch = { status };
    if ('assignedWorker' in (req.body || {})) patch.assignedWorker = assignedWorker;

    const updated = await analytics.updateReferral(referralId, patch);
    if (!updated) {
      return res.status(404).json({
        error: 'referral_not_found', message: `No referral with id ${referralId}`,
      });
    }
    await logAccess(req.user?.userId, 'update_referral', 'referral', referralId);
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
