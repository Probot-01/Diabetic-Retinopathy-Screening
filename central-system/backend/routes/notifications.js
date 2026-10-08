'use strict';

/**
 * routes/notifications.js -- SMS delivery reports (design doc §10.5).
 *
 * Mounted at /api/v1/notifications.
 *
 *   POST /api/v1/notifications/sms-status
 *     Twilio's status callback. Form-encoded: MessageSid, MessageStatus,
 *     ErrorCode/ErrorMessage. Always answers 204 -- Twilio retries on any
 *     non-2xx, and a retry storm helps nobody when the problem is at our end.
 *
 * WHY THIS EXISTS: `messages.create()` resolving means Twilio ACCEPTED the
 * message, not that a phone received it. Wrong number, unreachable handset and
 * carrier rejection all resolve fine and fail minutes later, reported only
 * here. Without this endpoint the referral sits in 'referred' looking exactly
 * like one where the patient was actually told (§10.5).
 *
 * NOT AUTHENTICATED BY COOKIE OR PHC KEY -- Twilio has neither. It is
 * authenticated by Twilio's own request signature (X-Twilio-Signature), which
 * is an HMAC over the full URL and the posted fields keyed with the account's
 * auth token. Without a configured auth token the route refuses every request
 * rather than accepting unverified ones: anything else would let anyone on the
 * internet mark a patient's referral as needing manual follow-up, or bury a
 * real failure by reporting 'delivered'.
 */

const express = require('express');
const { handleDeliveryReport } = require('../services/referralNotificationService');

const router = express.Router();

// Twilio posts application/x-www-form-urlencoded, which express.json() does not
// parse. Scoped to this router so nothing else gains a form parser.
router.use(express.urlencoded({ extended: false, limit: '16kb' }));

const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
// The exact public URL Twilio was told to call; the signature is computed over
// it, so a proxy or a different host/path means it must be set explicitly.
const CALLBACK_URL = process.env.TWILIO_STATUS_CALLBACK_URL || '';

function verifyTwilioSignature(req) {
  if (!AUTH_TOKEN || !CALLBACK_URL) return false;
  try {
    const twilio = require('twilio');
    return twilio.validateRequest(
      AUTH_TOKEN, req.get('X-Twilio-Signature') || '', CALLBACK_URL, req.body || {});
  } catch (err) {
    console.error(`[notifications] signature check failed: ${err.message}`);
    return false;
  }
}

router.post('/sms-status', async (req, res) => {
  if (!verifyTwilioSignature(req)) {
    console.warn('[notifications] rejected an unsigned or unverifiable delivery report');
    return res.status(403).json({
      error: 'invalid_signature',
      message: 'This endpoint accepts only signed Twilio status callbacks.',
    });
  }

  const sid = req.body?.MessageSid;
  const status = req.body?.MessageStatus;
  const detail = req.body?.ErrorCode
    ? `Twilio error ${req.body.ErrorCode}${req.body.ErrorMessage ? `: ${req.body.ErrorMessage}` : ''}`
    : null;

  try {
    const out = await handleDeliveryReport(sid, status, detail);
    if (!out.matched) {
      // Not ours, or the notification row was deleted. Logged, not an error:
      // answering non-2xx would make Twilio retry a message we cannot match.
      console.warn(`[notifications] delivery report for unknown message ${sid} (${status})`);
    }
  } catch (err) {
    console.error(`[notifications] delivery report for ${sid} failed: ${err.message}`);
  }
  res.status(204).end();
});

module.exports = router;
