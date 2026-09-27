'use strict';

/**
 * referralNotificationService.js  (Task 3.6)
 *
 *   handleConfirmedReferral(caseId, opts) -> { referralId, sms: {...} }
 *
 * Called from the review route immediately after an ophthalmologist's decision
 * is recorded, and ONLY when the resulting grade is referable (>= 2).
 *
 * ── The safety rule this service exists to enforce ──────────────────────────
 * The AI never tells a patient they have a disease (design doc §1.5). Every
 * "probably has DR" outcome is confirmed by an ophthalmologist before it
 * becomes an SMS. So this function must never be reachable from the grading
 * pipeline — only from a recorded human decision. It takes a caseId and checks
 * for that decision itself rather than trusting the caller.
 *
 * ── What the message may and may not say ────────────────────────────────────
 * A referral notice, not a diagnosis (design doc §3.6). The patient is told
 * that their screening needs a follow-up and where to go. The message does NOT
 * name a condition, give a grade, or restate anything in clinical language:
 *
 *   - This is a screening pathway, not a diagnostic one (§16). A grade from
 *     this system is a referral recommendation, and wording it as a finding
 *     would overclaim what the system is allowed to say.
 *   - An SMS is unencrypted and lands on a phone others may read. Naming a
 *     medical condition in it is a privacy problem independent of accuracy.
 *   - The patient cannot ask an SMS a follow-up question. A diagnosis with no
 *     one to ask is frightening rather than useful; an instruction is actionable.
 *
 * ── Behaviour without Twilio credentials ────────────────────────────────────
 * The referral row is still created — that is the clinical record and the admin
 * follow-up worklist, and it must not depend on a third party being reachable.
 * The SMS is skipped and recorded with status 'not_configured'. It is NEVER
 * recorded as sent. A notification row that falsely claims a patient was told
 * to seek care is worse than no row at all: it makes a missed referral
 * invisible to the very tracker built to catch missed referrals.
 */

const pool = require('../db/pgClient');

const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_FROM;
// Public https URL of POST /api/v1/notifications/sms-status, when this backend
// is reachable from the internet. Optional; see the send call below.
const STATUS_CALLBACK_URL = process.env.TWILIO_STATUS_CALLBACK_URL || '';

// Set SMS_DRY_RUN=1 to exercise the whole path without sending anything, even
// with real credentials present. Useful for demos and for load-testing the
// review flow without messaging real people.
const DRY_RUN = process.env.SMS_DRY_RUN === '1';

let twilioClient = null;
let twilioInitError = null;

/**
 * getTwilioClient()
 *
 * Lazily constructed, never at module load. Requiring this file must not throw
 * or exit merely because credentials are absent — the central server has to
 * boot and serve every other endpoint on a machine that has no Twilio account,
 * which is the normal state during development.
 */
function getTwilioClient() {
  if (twilioClient || twilioInitError) return twilioClient;
  if (!isConfigured()) return null;
  try {
    twilioClient = require('twilio')(TWILIO_SID, TWILIO_TOKEN);
  } catch (err) {
    twilioInitError = err;
    console.error('[referral] Twilio client init failed:', err.message);
  }
  return twilioClient;
}

function isConfigured() {
  return !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);
}

/**
 * Message templates, by the language recorded on the questionnaire.
 *
 * Deliberately free of any condition name, grade or clinical term — see the
 * header. {phc} and {clinic} are substituted; everything else is fixed text.
 *
 * > TRANSLATION NOT YET REVIEWED. The Hindi below is a working draft and MUST
 * > be checked by a fluent speaker before any real send. A health instruction
 * > that reads awkwardly is ignored, and one that reads wrongly is dangerous —
 * > this is the one string in the system a non-speaker should not sign off on.
 */
const TEMPLATES = {
  en: 'Your recent eye screening at {phc} needs a follow-up check with an eye '
    + 'doctor. Please visit {clinic} as soon as you can. Bring this message with you.',

  hi: 'आपकी हाल की आँखों की जाँच ({phc}) के बाद आँख के डॉक्टर से दोबारा जाँच '
    + 'कराना ज़रूरी है। कृपया जल्द से जल्द {clinic} पर जाएँ। यह संदेश साथ लाएँ।',
};

const DEFAULT_CLINIC = process.env.REFERRAL_CLINIC_NAME
  || 'the district hospital eye department';

function buildMessage({ language, phcName }) {
  const template = TEMPLATES[language] || TEMPLATES.en;
  return template
    .replace('{phc}', phcName || 'your health centre')
    .replace('{clinic}', DEFAULT_CLINIC);
}

/**
 * handleConfirmedReferral(caseId, opts)
 *
 * @param {string} caseId
 * @param {object} [opts]
 * @param {number} [opts.correctedGrade] — the ophthalmologist's own grade, when
 *        the decision was an override. See the note below.
 * @returns {Promise<{referralId, alreadyReferred, sms}>}
 */
async function handleConfirmedReferral(caseId, opts = {}) {
  const { rows } = await pool.query(`
    SELECT c.case_id, c.patient_id, c.questionnaire_data,
           p.contact_number, p.patient_reference,
           site.name AS phc_name,
           g.dr_grade_cnn, g.referable,
           r.decision, r.reviewed_at
    FROM cases c
    JOIN      patients        p    ON p.patient_id = c.patient_id
    LEFT JOIN phc_sites       site ON site.phc_id  = c.phc_id
    LEFT JOIN grading_results g    ON g.case_id    = c.case_id
    LEFT JOIN LATERAL (
      SELECT decision, reviewed_at FROM ophthalmologist_reviews
      WHERE case_id = c.case_id ORDER BY reviewed_at DESC LIMIT 1
    ) r ON true
    WHERE c.case_id = $1
  `, [caseId]);

  if (!rows.length) throw new Error(`handleConfirmedReferral: case ${caseId} not found`);
  const row = rows[0];

  // Guard the safety rule at the point of action, not only at the call site.
  // No human decision on record means no SMS, whatever the caller believes.
  if (!row.decision) {
    return skip(caseId, row, 'no_review_on_record',
      'No ophthalmologist review recorded for this case.');
  }

  // Which grade actually stands after review?
  //
  // On 'confirm' the model's grade stands. On 'override' the ophthalmologist
  // disagreed — but api-contracts.md's review payload has NO field for their
  // corrected grade, so the system genuinely does not know what the grade
  // became. correctedGrade is accepted as an additive field for that; without
  // it an override cannot be acted on, and NOT sending is the safe failure.
  // Sending a referral the reviewer may have just ruled out is worse than
  // sending nothing, because the admin tracker still shows the case as needing
  // follow-up either way.
  let effectiveGrade;
  if (row.decision === 'confirm') {
    effectiveGrade = row.dr_grade_cnn;
  } else if (Number.isInteger(opts.correctedGrade)) {
    effectiveGrade = opts.correctedGrade;
  } else {
    return skip(caseId, row, 'override_without_grade',
      'Review was an override but no correctedGrade was supplied — cannot '
      + 'determine whether this case is referable. See api-contracts.md.');
  }

  if (!(effectiveGrade >= 2)) {
    // Non-referable: case closes, no SMS (design doc §8.1 step 8).
    return { referralId: null, alreadyReferred: false,
             sms: { status: 'not_referable', sent: false } };
  }

  // ── Referral row ──────────────────────────────────────────────────────────
  // ON CONFLICT against uq_referrals_case: a case reviewed twice must not
  // produce a second referral or a second SMS to the patient.
  const ref = await pool.query(`
    INSERT INTO referrals (case_id, status) VALUES ($1, 'referred')
    ON CONFLICT (case_id) DO NOTHING
    RETURNING referral_id
  `, [caseId]);

  const alreadyReferred = ref.rows.length === 0;
  const referralId = alreadyReferred
    ? (await pool.query('SELECT referral_id FROM referrals WHERE case_id = $1', [caseId]))
        .rows[0].referral_id
    : ref.rows[0].referral_id;

  if (alreadyReferred) {
    // Already handled by an earlier review. Do not re-send.
    return { referralId, alreadyReferred: true,
             sms: { status: 'already_sent', sent: false } };
  }

  // ── SMS ───────────────────────────────────────────────────────────────────
  const language = (row.questionnaire_data && row.questionnaire_data.language) || 'en';
  const body     = buildMessage({ language, phcName: row.phc_name });
  const to       = row.contact_number;

  if (!to) {
    // §10.5: nothing can be sent, so this needs a person, now -- not at
    // whatever point someone notices the tracker.
    await flipToManualFollowUp(referralId, 'no contact number on record');
    return { referralId, alreadyReferred: false,
             sms: await record(caseId, row, 'no_contact_number', null,
                               'Patient has no contact number on record.') };
  }

  if (DRY_RUN || !isConfigured()) {
    const why = DRY_RUN ? 'dry_run' : 'not_configured';
    console.log(`[referral] SMS ${why} — would send to ${maskNumber(to)}:\n  ${body}`);
    // §10.5: the patient was NOT told, so somebody has to phone them. With no
    // SMS provider configured that is true of EVERY referral, and leaving it
    // in 'referred' made it look like an ordinary one the patient had been
    // messaged about. dry_run is a developer's opt-in to "log, don't send" and
    // keeps its old behaviour.
    if (why === 'not_configured') {
      await flipToManualFollowUp(referralId, 'SMS provider not configured');
    }
    return { referralId, alreadyReferred: false,
             sms: await record(caseId, row, why, null, null, body) };
  }

  const client = getTwilioClient();
  if (!client) {
    await flipToManualFollowUp(referralId, 'SMS client unavailable');
    return { referralId, alreadyReferred: false,
             sms: await record(caseId, row, 'client_unavailable', null,
                               twilioInitError ? twilioInitError.message : 'unknown') };
  }

  try {
    // statusCallback: acceptance by the API is not delivery. Without this URL
    // an undeliverable message is never reported and §10.5 cannot fire for the
    // most common real failure (wrong or unreachable number). It needs a
    // publicly reachable backend, so it is optional and simply absent on a
    // laptop demo -- in which case only immediate failures flip the referral.
    const msg = await client.messages.create({
      body, from: TWILIO_FROM, to,
      ...(STATUS_CALLBACK_URL ? { statusCallback: STATUS_CALLBACK_URL } : {}),
    });
    console.log(`[referral] SMS sent to ${maskNumber(to)} (${msg.sid})`);
    return { referralId, alreadyReferred: false,
             sms: await record(caseId, row, 'sent', msg.sid, null, body) };
  } catch (err) {
    // The referral row stands. A failed SMS must not roll back the clinical
    // record — the patient still needs following up, and the admin tracker is
    // now the mechanism that catches it.
    console.error(`[referral] SMS FAILED for case ${caseId}: ${err.message}`);
    await flipToManualFollowUp(referralId, 'SMS send failed');
    return { referralId, alreadyReferred: false,
             sms: await record(caseId, row, 'failed', null, err.message, body) };
  }
}

/**
 * flipToManualFollowUp(referralId, why)
 *
 * Design doc §10.5. The patient was NOT told, so somebody has to phone them.
 * Only ever applied to a referral still sitting in 'referred': once a worker
 * has moved it on (contacted / attended / lost), a late delivery report must
 * not drag it backwards.
 */
async function flipToManualFollowUp(referralId, why) {
  if (!referralId) return false;
  try {
    const { rowCount } = await pool.query(`
      UPDATE referrals SET status = 'manual_follow_up', updated_at = now()
      WHERE referral_id = $1 AND status = 'referred'
    `, [referralId]);
    if (rowCount) {
      console.warn(`[referral] ${referralId} -> manual_follow_up (${why})`);
    }
    return rowCount > 0;
  } catch (err) {
    console.error(`[referral] could not flip ${referralId} to manual follow-up: ${err.message}`);
    return false;
  }
}

/**
 * handleDeliveryReport(providerMessageId, deliveryStatus, errorDetail)
 *
 * Twilio's status callback (routes/notifications.js). A message can be accepted
 * by the API and still never arrive -- wrong number, unreachable handset,
 * carrier rejection -- and that outcome only shows up here, minutes later.
 * 'undelivered' and 'failed' are terminal failures; everything else is progress.
 */
async function handleDeliveryReport(providerMessageId, deliveryStatus, errorDetail) {
  const status = String(deliveryStatus || '').toLowerCase();
  const terminalFailure = status === 'undelivered' || status === 'failed';

  const { rows } = await pool.query(`
    UPDATE notifications
    SET status = $2, error_detail = COALESCE($3, error_detail)
    WHERE provider_message_id = $1
    RETURNING case_id
  `, [providerMessageId, terminalFailure ? `delivery_${status}` : status, errorDetail || null]);
  if (!rows.length) return { matched: false, flipped: false };

  if (!terminalFailure) return { matched: true, flipped: false };

  const ref = await pool.query(
    'SELECT referral_id FROM referrals WHERE case_id = $1', [rows[0].case_id]);
  const flipped = ref.rows.length
    ? await flipToManualFollowUp(ref.rows[0].referral_id, `SMS ${status}`)
    : false;
  return { matched: true, flipped, caseId: rows[0].case_id };
}

/** Record what actually happened. status is never 'sent' unless it was sent. */
async function record(caseId, row, status, providerId, errorDetail, body) {
  await pool.query(`
    INSERT INTO notifications
      (patient_id, case_id, channel, message_type, status, provider_message_id, error_detail)
    VALUES ($1, $2, 'sms', 'positive', $3, $4, $5)
  `, [row.patient_id, caseId, status, providerId || null, errorDetail || null]);
  return { status, sent: status === 'sent', providerMessageId: providerId || null,
           errorDetail: errorDetail || null, body: body || null };
}

async function skip(caseId, row, status, message) {
  console.warn(`[referral] case ${caseId}: ${message}`);
  return { referralId: null, alreadyReferred: false,
           sms: { status, sent: false, errorDetail: message } };
}

/** Never log a full phone number. */
function maskNumber(n) {
  const s = String(n);
  return s.length <= 4 ? '****' : `${s.slice(0, 3)}****${s.slice(-3)}`;
}

module.exports = {
  handleConfirmedReferral, isConfigured, buildMessage, TEMPLATES,
  handleDeliveryReport, flipToManualFollowUp,
};
