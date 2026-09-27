'use strict';

/**
 * analyticsAggregator.js  (Task 3.7)
 *
 * Aggregate metrics for the district admin interface.
 *
 * Aggregate-first by design (design doc §1.6): an admin managing a whole
 * district needs to see where the system is backed up and where resources
 * should move — not a feed of individual patients. Nothing here returns
 * per-case detail, and no per-case push exists. Keep it that way.
 *
 * ── Why there is a report timezone ──────────────────────────────────────────
 * "Cases today" has to mean today *where the district is*. received_at is a
 * TIMESTAMPTZ, and casting it with `::date` resolves in the server's session
 * timezone — so a server running UTC would roll the day over at 05:30 local
 * time in India. Every morning's first few hours of screening would be counted
 * against the previous day, and the number an admin checks at 9am would be
 * quietly wrong. The conversion is explicit here for that reason.
 */

const pool = require('../db/pgClient');

// Override per deployment. Default matches the target deployment region rather
// than UTC, because UTC is the answer that is wrong in a way nobody notices.
const REPORT_TZ = process.env.REPORT_TIMEZONE || 'Asia/Kolkata';

/**
 * getDashboard()
 *
 * -> { casesToday, casesPerPhc, averageReviewTurnaroundSeconds,
 *        casesThisWeek, totalCasesProcessed, overrideRate, avgConfidenceScore,
 *        drGradeDistribution, weeklyTrend }
 *
 * The last six are additive (api-contracts.md, 2026-09-26) and every one is
 * computed from stored rows. What central cannot know is NOT here at all:
 * images rejected by the PHC quality gate never reach central, and a model
 * accuracy needs ground truth this system does not hold -- the screen shows
 * those as unavailable rather than inventing them.
 */
async function getDashboard() {
  const [today, perPhc, turnaround, totals, reviews, grades, weekly] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS n
      FROM cases
      WHERE (received_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
    `, [REPORT_TZ]),

    // LEFT JOIN, and cases with no phc_id are kept as a null-PHC bucket rather
    // than dropped. If they were dropped, the casesPerPhc counts would not sum
    // to casesToday, and an admin comparing the two numbers would be looking at
    // a discrepancy with no explanation. Better to show an unattributed bucket.
    pool.query(`
      SELECT c.phc_id, s.name AS phc_name, COUNT(*)::int AS n
      FROM cases c
      LEFT JOIN phc_sites s ON s.phc_id = c.phc_id
      WHERE (c.received_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
      GROUP BY c.phc_id, s.name
      ORDER BY n DESC, s.name NULLS LAST
    `, [REPORT_TZ]),

    pool.query(`
      SELECT AVG(review_duration_seconds)::float AS avg_seconds
      FROM ophthalmologist_reviews
      WHERE review_duration_seconds IS NOT NULL
    `),

    // Cases received in the last 7 days / graded cases / their mean confidence.
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE c.received_at >= now() - interval '7 days')::int AS week_n,
        COUNT(*) FILTER (WHERE c.status = 'graded')::int                          AS graded_n,
        AVG(g.confidence_score)::float                                            AS avg_conf
      FROM cases c
      LEFT JOIN grading_results g ON g.case_id = c.case_id
    `),

    // Override rate over recorded reviews.
    pool.query(`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE decision = 'override')::int AS overrides
      FROM ophthalmologist_reviews
    `),

    // The classifier's grade, per grade, over graded cases.
    pool.query(`
      SELECT dr_grade_cnn AS grade, COUNT(*)::int AS n
      FROM grading_results WHERE dr_grade_cnn IS NOT NULL GROUP BY dr_grade_cnn
    `),

    // Last six local weeks, oldest first, zeros included (a real zero is data).
    pool.query(`
      WITH weeks AS (
        SELECT date_trunc('week', (now() AT TIME ZONE $1)) - (n * interval '1 week') AS wk
        FROM generate_series(5, 0, -1) AS n
      )
      SELECT to_char(w.wk, 'IYYY-"W"IW') AS week,
             (SELECT COUNT(*)::int FROM cases c
               WHERE date_trunc('week', c.received_at AT TIME ZONE $1) = w.wk) AS cases,
             (SELECT COUNT(*)::int FROM referrals r
               JOIN cases c ON c.case_id = r.case_id
               WHERE date_trunc('week', c.received_at AT TIME ZONE $1) = w.wk) AS referrals
      FROM weeks w ORDER BY w.wk
    `, [REPORT_TZ]),
  ]);

  const avg = turnaround.rows[0].avg_seconds;

  return {
    casesToday: today.rows[0].n,
    casesPerPhc: perPhc.rows.map((r) => ({
      phcId:   r.phc_id ?? null,
      phcName: r.phc_name ?? null,   // null = cases that arrived without a PHC id
      count:   r.n,
    })),
    // null, not 0, when nothing has been reviewed. A 0 here would claim reviews
    // are completing instantly — the opposite of "no data" — and this figure is
    // read as a service-level number.
    averageReviewTurnaroundSeconds: avg === null ? null : Math.round(avg),

    casesThisWeek: totals.rows[0].week_n,
    totalCasesProcessed: totals.rows[0].graded_n,
    // null, never 0, when there is nothing to divide -- same rule as the average above.
    overrideRate: reviews.rows[0].n === 0 ? null : reviews.rows[0].overrides / reviews.rows[0].n,
    avgConfidenceScore: totals.rows[0].avg_conf === null ? null : totals.rows[0].avg_conf,
    drGradeDistribution: gradeDistribution(grades.rows),
    weeklyTrend: weekly.rows,
  };
}

const GRADE_LABELS = { 0: 'No DR', 1: 'Mild NPDR', 2: 'Moderate NPDR', 3: 'Severe NPDR', 4: 'PDR' };

/** All five grades, zeros included; null when nothing has been graded. */
function gradeDistribution(rows) {
  const byGrade = new Map(rows.map((r) => [r.grade, r.n]));
  const total = [...byGrade.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  return [0, 1, 2, 3, 4].map((g) => {
    const count = byGrade.get(g) || 0;
    return { grade: g, label: GRADE_LABELS[g], count, percentage: Math.round((count / total) * 1000) / 10 };
  });
}

/**
 * getReferrals()
 *
 * -> [ { referralId, patientReference, status, assignedWorker, updatedAt } ]
 *
 * patientReference, never patientId: this list is the follow-up worklist and
 * gets handed to ASHA workers, so it must not carry the internal identifier.
 */
async function getReferrals() {
  return selectReferrals(null);
}

/**
 * One query for the list and for a single referral (the PATCH response has the
 * same shape as a list item). phcName and drGrade are additive
 * (api-contracts.md, 2026-09-26): drGrade is the FINAL grade -- the reviewer's
 * corrected grade when there is one, else the classifier's -- because that is
 * the grade the referral was raised on.
 */
async function selectReferrals(referralId) {
  const { rows } = await pool.query(`
    SELECT r.referral_id, r.status, r.assigned_worker, r.updated_at,
           p.patient_reference, s.name AS phc_name,
           COALESCE(
             (SELECT rv.corrected_grade FROM ophthalmologist_reviews rv
               WHERE rv.case_id = c.case_id AND rv.corrected_grade IS NOT NULL
               ORDER BY rv.reviewed_at DESC LIMIT 1),
             g.dr_grade_cnn) AS dr_grade
    FROM referrals r
    JOIN cases    c ON c.case_id    = r.case_id
    JOIN patients p ON p.patient_id = c.patient_id
    LEFT JOIN phc_sites       s ON s.phc_id  = c.phc_id
    LEFT JOIN grading_results g ON g.case_id = c.case_id
    WHERE ($1::uuid IS NULL OR r.referral_id = $1::uuid)
    ORDER BY r.updated_at DESC
  `, [referralId]);
  return rows.map(toReferral);
}

/** Update a referral's tracking state. Returns null if it does not exist. */
async function updateReferral(referralId, { status, assignedWorker }) {
  const { rowCount } = await pool.query(`
    UPDATE referrals r
    SET status          = COALESCE($2, r.status),
        -- Distinguish "not supplied" from "cleared". undefined leaves the
        -- worker unchanged; an explicit null unassigns them, which is a real
        -- action when a worker leaves or a case is reassigned.
        assigned_worker = CASE WHEN $4 THEN $3 ELSE r.assigned_worker END,
        updated_at      = now()
    FROM cases c, patients p
    WHERE r.referral_id = $1
      AND c.case_id    = r.case_id
      AND p.patient_id = c.patient_id
  `, [referralId, status ?? null, assignedWorker ?? null,
      assignedWorker !== undefined]);

  if (!rowCount) return null;
  return (await selectReferrals(referralId))[0] ?? null;
}

/**
 * getPhcSyncStatus(phcId)
 *
 * -> { phcId, phcName, lastSyncAt, pendingCount } | null
 *
 * pendingCount is REPORTED BY the PHC, not computed here: the sync queue lives
 * in the PHC's local SQLite and the central server has no visibility into it.
 * The value is therefore only accurate as of lastSyncAt — and a PHC that is
 * offline right now is exactly the one whose real backlog is growing while this
 * number stays frozen. Read the pair together, never pendingCount alone.
 */
async function getPhcSyncStatus(phcId) {
  const { rows } = await pool.query(
    'SELECT phc_id, name, last_sync_at, last_contact_at, pending_count FROM phc_sites WHERE phc_id = $1',
    [phcId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    phcId:        r.phc_id,
    phcName:      r.name,
    lastSyncAt:   r.last_sync_at ? r.last_sync_at.toISOString() : null,
    // Any contact at all, summary packets included (backend plan §F). A health
    // badge should key off this, not lastSyncAt: a site on a thin link that is
    // only getting summaries through is alive.
    lastContactAt: r.last_contact_at ? r.last_contact_at.toISOString() : null,
    pendingCount: r.pending_count ?? 0,
  };
}

const PHC_SILENT_HOURS = (() => {
  const v = Number(process.env.PHC_SILENT_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 24;
})();

/**
 * getPhcs()
 *
 * -> [ { phcId, phcCode, name, district, lastSyncAt, casesLast24h,
 *        pendingOrFailedCount, status } ], every row in phc_sites.
 *
 * lastSyncAt is the latest case CENTRAL RECEIVED from the site (not
 * phc_sites.last_sync_at, which has its own narrower meaning). null = it has
 * never sent a case, which is "silent", not "recent".
 *
 * pendingOrFailedCount = what the PHC last said it still has queued
 * (phc_sites.pending_count, accurate only as of its last contact) + cases from
 * that site whose grading failed here (status 'error'). Both are work that has
 * not reached a result.
 *
 * status: 'silent' when nothing arrived within PHC_SILENT_HOURS (default 24),
 * else 'active'.
 *
 * The API key and its hash are never selected.
 */
async function getPhcs() {
  const { rows } = await pool.query(`
    SELECT s.phc_id, s.phc_code, s.name, s.district, s.pending_count,
           (SELECT MAX(c.received_at) FROM cases c WHERE c.phc_id = s.phc_id) AS last_received,
           (SELECT COUNT(*)::int FROM cases c
             WHERE c.phc_id = s.phc_id AND c.received_at > now() - interval '24 hours') AS cases_24h,
           (SELECT COUNT(*)::int FROM cases c
             WHERE c.phc_id = s.phc_id AND c.status = 'error') AS failed
    FROM phc_sites s
    ORDER BY s.name, s.phc_id
  `);
  const cutoff = Date.now() - PHC_SILENT_HOURS * 3_600_000;
  return rows.map((r) => ({
    phcId:                r.phc_id,
    phcCode:              r.phc_code ?? null,
    name:                 r.name,
    district:             r.district ?? null,
    lastSyncAt:           r.last_received ? r.last_received.toISOString() : null,
    casesLast24h:         r.cases_24h,
    pendingOrFailedCount: (r.pending_count ?? 0) + r.failed,
    status:               r.last_received && r.last_received.getTime() >= cutoff ? 'active' : 'silent',
  }));
}

function toReferral(r) {
  return {
    referralId:       r.referral_id,
    patientReference: r.patient_reference ?? null,
    status:           r.status,
    assignedWorker:   r.assigned_worker ?? null,
    phcName:          r.phc_name ?? null,
    drGrade:          r.dr_grade ?? null,
    updatedAt:        r.updated_at.toISOString(),
  };
}

module.exports = {
  getDashboard, getReferrals, updateReferral, getPhcSyncStatus, getPhcs, REPORT_TZ,
};
