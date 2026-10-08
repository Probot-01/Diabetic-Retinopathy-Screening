'use strict';

/**
 * verify_backend_auth.js -- backend plan §A (auth), §B.1-B.3 (search, claim,
 * review history), §M (consent) and design doc §10.8 / §10.9.
 *
 * Run:  node verify_backend_auth.js
 *
 * Needs the central Postgres (DATABASE_URL in .env), migrations applied
 * (`npm run migrate`) and the demo users seeded (`npm run seed-users`). Does
 * NOT need MATLAB: no case is ingested, so nothing is ever graded.
 *
 * Runs with AUTH_ENABLED and PHC_AUTH_ENABLED forced ON, whatever .env says --
 * the point is to prove enforcement works before anyone flips the real flags.
 *
 * Leaves no test data behind: the temporary PHC site, the second reviewer and
 * its access-log rows are deleted, and any case it claims is restored to its
 * previous claim state. Access-log rows written for the two DEMO users are kept
 * -- they are genuine records of this run's reads.
 */

const path   = require('path');
const crypto = require('crypto');

const CENTRAL = path.resolve(__dirname, 'central-system', 'backend');
require(require.resolve('dotenv', { paths: [CENTRAL] }))
  .config({ path: path.resolve(__dirname, '.env') });

// Before requiring anything that reads authConfig.
process.env.AUTH_ENABLED     = 'true';
process.env.PHC_AUTH_ENABLED = 'true';
process.env.JWT_SECRET       = crypto.randomBytes(48).toString('base64url');
process.env.COOKIE_SAMESITE  = 'lax';

const bcrypt = require(require.resolve('bcryptjs', { paths: [CENTRAL] }));
const app    = require(path.join(CENTRAL, 'server.js'));
const pool   = require(path.join(CENTRAL, 'db', 'pgClient'));
const gradingQueue = require(path.join(CENTRAL, 'services', 'gradingQueue'));
const { hashApiKey } = require(path.join(CENTRAL, 'services', 'authTokens'));

const OPHTH = { email: 'ophthalmologist@demo.netrasetu.local',
                password: process.env.DEMO_OPHTHALMOLOGIST_PASSWORD || 'DemoOphth-2026' };
const ADMIN = { email: 'admin@demo.netrasetu.local',
                password: process.env.DEMO_ADMIN_PASSWORD || 'DemoAdmin-2026' };

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`); }
}

let BASE;
async function call(method, url, { cookie, csrf, phcKey, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (phcKey) headers['x-phc-api-key'] = phcKey;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

async function login(who) {
  const r = await call('POST', '/api/v1/auth/login', { body: who });
  const cookie = r.setCookie ? r.setCookie.split(';')[0] : null;
  return { ...r, cookie, csrf: r.json && r.json.csrfToken };
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const cleanup = { phcId: null, userId: null, claimRestore: null,
                    agreementRestore: null, reviewId: null };

  try {
    // ── Login ───────────────────────────────────────────────────────────────
    console.log('\n===== Login (§A.1) =====');
    const wrongPw  = await call('POST', '/api/v1/auth/login', { body: { email: OPHTH.email, password: 'nope' } });
    const unknown  = await call('POST', '/api/v1/auth/login', { body: { email: 'nobody@x.local', password: 'nope' } });
    check('wrong password -> 401', wrongPw.status === 401, wrongPw);
    check('unknown email -> 401 with the IDENTICAL body (no account enumeration)',
      unknown.status === 401 && JSON.stringify(unknown.json) === JSON.stringify(wrongPw.json));
    const missing = await call('POST', '/api/v1/auth/login', { body: { email: OPHTH.email } });
    check('missing password -> 400', missing.status === 400);

    const o = await login(OPHTH);
    check('ophthalmologist login -> 200', o.status === 200, o.json);
    check('session is an httpOnly cookie', /HttpOnly/i.test(o.setCookie || ''), o.setCookie);
    check('cookie carries SameSite', /SameSite=Lax/i.test(o.setCookie || ''), o.setCookie);
    check('JWT is NOT in the response body', !JSON.stringify(o.json).includes(o.cookie.split('=')[1]));
    check('response has user + csrfToken + expiresAt',
      o.json && o.json.user && o.json.user.role === 'ophthalmologist' && o.csrf && o.json.expiresAt);

    const me = await call('GET', '/api/v1/auth/me', { cookie: o.cookie });
    check('/auth/me recovers the same csrfToken after a "reload"',
      me.status === 200 && me.json.csrfToken === o.csrf, me.json);
    const meAnon = await call('GET', '/api/v1/auth/me');
    check('/auth/me without cookie -> 401', meAnon.status === 401);

    const a = await login(ADMIN);
    check('district_admin login -> 200', a.status === 200 && a.json.user.role === 'district_admin');

    // ── Route guards ────────────────────────────────────────────────────────
    console.log('\n===== Route guards (§A.6/§A.7) =====');
    const anon = await call('GET', '/api/v1/ophthalmologist/queue');
    check('queue without session -> 401', anon.status === 401, anon.json);
    const forged = await call('GET', '/api/v1/ophthalmologist/queue', { cookie: 'ns_session=forged.jwt.value' });
    check('queue with forged cookie -> 401', forged.status === 401);
    const q = await call('GET', '/api/v1/ophthalmologist/queue', { cookie: o.cookie });
    check('queue as ophthalmologist -> 200', q.status === 200, q.json);
    const qAdmin = await call('GET', '/api/v1/ophthalmologist/queue', { cookie: a.cookie });
    check('queue as district_admin -> 403', qAdmin.status === 403, qAdmin.json);
    const dOph = await call('GET', '/api/v1/admin/dashboard', { cookie: o.cookie });
    check('admin dashboard as ophthalmologist -> 403', dOph.status === 403);
    const dAdm = await call('GET', '/api/v1/admin/dashboard', { cookie: a.cookie });
    check('admin dashboard as district_admin -> 200', dAdm.status === 200, dAdm.json);
    const refAnon = await call('PATCH', `/api/v1/referrals/${crypto.randomUUID()}`, { body: { status: 'contacted' } });
    check('referral PATCH without session -> 401', refAnon.status === 401);
    const media = await call('GET', '/media/anything.png');
    check('/media without session -> 401 (images are patient data too)', media.status === 401);
    const mediaAuthed = await call('GET', '/media/does-not-exist.png', { cookie: o.cookie });
    check('/media with session passes the guard (404 for a missing file)', mediaAuthed.status === 404);
    const health = await call('GET', '/health');
    check('/health stays open', health.status === 200);

    // ── CSRF ────────────────────────────────────────────────────────────────
    console.log('\n===== CSRF (§A.2) =====');
    const someCase = (await pool.query('SELECT case_id FROM cases LIMIT 1')).rows[0];
    const cid = someCase ? someCase.case_id : crypto.randomUUID();
    const noCsrf = await call('POST', `/api/v1/cases/${cid}/review`, {
      cookie: o.cookie, body: { decision: 'confirm' } });
    check('POST review with cookie but no X-CSRF-Token -> 403', noCsrf.status === 403 &&
      noCsrf.json.error === 'csrf_invalid', noCsrf.json);
    const badCsrf = await call('POST', `/api/v1/cases/${cid}/review`, {
      cookie: o.cookie, csrf: a.csrf, body: { decision: 'confirm' } });
    check("another session's CSRF token is rejected", badCsrf.status === 403);

    // ── PHC device keys ─────────────────────────────────────────────────────
    console.log('\n===== PHC API keys (§A.12) =====');
    const key = `phc_${crypto.randomBytes(32).toString('base64url')}`;
    const site = (await pool.query(
      "INSERT INTO phc_sites (name, api_key_hash) VALUES ('ZZ verify_backend_auth temp', $1) RETURNING phc_id",
      [hashApiKey(key)])).rows[0];
    cleanup.phcId = site.phc_id;

    const sNoKey = await call('GET', '/api/v1/patients/search?name=test');
    check('patient search without PHC key -> 401', sNoKey.status === 401, sNoKey.json);
    const sBadKey = await call('GET', '/api/v1/patients/search?name=test', { phcKey: 'phc_wrong' });
    check('patient search with a wrong key -> 401', sBadKey.status === 401);
    const sUser = await call('GET', '/api/v1/patients/search?name=test', { cookie: o.cookie });
    check('a browser session is NOT a PHC key -> 401', sUser.status === 401);

    const sample = (await pool.query('SELECT name, age, contact_number FROM patients LIMIT 1')).rows[0];
    if (sample) {
      const firstWord = sample.name.split(/\s+/)[0];
      const s = await call('GET',
        `/api/v1/patients/search?name=${encodeURIComponent(firstWord)}&age=${sample.age}`, { phcKey: key });
      check('patient search with valid key -> 200 and finds a known patient',
        s.status === 200 && s.json.some((p) => p.name === sample.name), s.json);
      const hit = s.json.find((p) => p.name === sample.name) || {};
      check('result shape: matchedOn, score, masked phone, no raw number',
        Array.isArray(hit.matchedOn) && typeof hit.score === 'number' &&
        !('contactNumber' in hit) && /^\*+\d{4}$/.test(hit.contactNumberMasked || ''), hit);
      const digits = sample.contact_number.replace(/\D/g, '');
      const byPhone = await call('GET', `/api/v1/patients/search?phone=${digits.slice(-6)}`, { phcKey: key });
      check('phone-only search matches on trailing digits',
        byPhone.status === 200 && byPhone.json.some((p) => p.matchedOn.includes('phone')), byPhone.json);
    } else {
      console.log('  SKIP  no patients in the database to search for');
    }
    const empty = await call('GET', '/api/v1/patients/search?age=40', { phcKey: key });
    check('age alone is not a search -> 400', empty.status === 400);

    const touched = (await pool.query('SELECT last_contact_at FROM phc_sites WHERE phc_id = $1',
      [site.phc_id])).rows[0];
    check('a keyed request stamps phc_sites.last_contact_at (§F)', !!touched.last_contact_at);

    const mism = await call('POST', '/api/v1/cases/TEST-verify-auth-0000/chunks/init', {
      phcKey: key, body: { phcId: crypto.randomUUID(), totalChunks: 1, totalBytes: 10, sha256: 'a'.repeat(64) } });
    check("a PHC naming another site's phcId -> 403 phc_mismatch", mism.status === 403 &&
      mism.json.error === 'phc_mismatch', mism.json);
    const statusNoCreds = await call('GET', `/api/v1/cases/${cid}/status`);
    check('case status needs a user OR a PHC key -> 401 with neither', statusNoCreds.status === 401);
    const statusKey = await call('GET', `/api/v1/cases/${cid}/status`, { phcKey: key });
    check('case status with a PHC key -> not 401', statusKey.status !== 401, statusKey);

    // ── Claim (§B.2 / §10.8) ────────────────────────────────────────────────
    console.log('\n===== Review claiming (§10.8) =====');
    const graded = (await pool.query(`
      SELECT case_id, claimed_by, claimed_at FROM grading_results
      WHERE conformal_tier IS NOT NULL LIMIT 1`)).rows[0];
    if (!graded) {
      console.log('  SKIP  no graded case to claim');
    } else {
      cleanup.claimRestore = graded;
      await pool.query('UPDATE grading_results SET claimed_by = NULL, claimed_at = NULL WHERE case_id = $1',
        [graded.case_id]);

      const pw = crypto.randomBytes(12).toString('base64url');
      const second = (await pool.query(`
        INSERT INTO users (email, name, role, password_hash)
        VALUES ('verify-second@demo.netrasetu.local', 'Dr. Verify Second', 'ophthalmologist', $1)
        RETURNING user_id`, [await bcrypt.hash(pw, 4)])).rows[0];
      cleanup.userId = second.user_id;
      const o2 = await login({ email: 'verify-second@demo.netrasetu.local', password: pw });

      const c1 = await call('POST', `/api/v1/cases/${graded.case_id}/claim`, { cookie: o.cookie, csrf: o.csrf });
      check('first reviewer claims -> 200', c1.status === 200 &&
        c1.json.claimedBy.userId === o.json.user.userId, c1.json);
      const c1again = await call('POST', `/api/v1/cases/${graded.case_id}/claim`, { cookie: o.cookie, csrf: o.csrf });
      check('same reviewer re-claiming (page reload) -> 200', c1again.status === 200);
      const c2 = await call('POST', `/api/v1/cases/${graded.case_id}/claim`, { cookie: o2.cookie, csrf: o2.csrf });
      check('second reviewer -> 409 naming who holds it', c2.status === 409 &&
        c2.json.error === 'case_claimed' && c2.json.claimedBy.name === 'Dr. Demo Ophthalmologist', c2.json);
      const r2 = await call('POST', `/api/v1/cases/${graded.case_id}/review`, {
        cookie: o2.cookie, csrf: o2.csrf, body: { decision: 'override',
          overrideReasonCategory: 'wrong_severity', correctedGrade: 2 } });
      check('second reviewer cannot submit a decision on the claimed case -> 409',
        r2.status === 409 && r2.json.error === 'case_claimed', r2.json);

      await pool.query(`UPDATE grading_results SET claimed_at = now() - interval '2 hours'
                        WHERE case_id = $1`, [graded.case_id]);
      const c3 = await call('POST', `/api/v1/cases/${graded.case_id}/claim`, { cookie: o2.cookie, csrf: o2.csrf });
      check('a stale claim (past CLAIM_TTL_MINUTES) can be taken over -> 200', c3.status === 200, c3.json);

      const nf = await call('POST', `/api/v1/cases/${crypto.randomUUID()}/claim`, { cookie: o.cookie, csrf: o.csrf });
      check('claiming an unknown case -> 404', nf.status === 404);
    }

    // ── Mandatory resolution on disagreement (§10.9) ────────────────────────
    console.log('\n===== Branch disagreement (§10.9) =====');
    // Uses a real disagreement case if one exists; otherwise flips one graded,
    // unclaimed case to branch_agreement=false for the duration and restores it.
    let dis = (await pool.query(`
      SELECT case_id FROM grading_results
      WHERE branch_agreement = false AND (claimed_by IS NULL OR claimed_by = $1) LIMIT 1`,
      [o.json.user.userId])).rows[0];
    if (!dis) {
      const pick = (await pool.query(`
        SELECT case_id, branch_agreement FROM grading_results
        WHERE conformal_tier IS NOT NULL AND claimed_by IS NULL LIMIT 1`)).rows[0];
      if (pick) {
        cleanup.agreementRestore = pick;
        await pool.query('UPDATE grading_results SET branch_agreement = false WHERE case_id = $1',
          [pick.case_id]);
        dis = pick;
        console.log('  (no real disagreement case; temporarily marking one graded case as disagreeing)');
      }
    }
    if (!dis) {
      console.log('  SKIP  no graded case available');
    } else {
      const before = (await pool.query('SELECT count(*)::int n FROM ophthalmologist_reviews WHERE case_id = $1',
        [dis.case_id])).rows[0].n;
      const conf = await call('POST', `/api/v1/cases/${dis.case_id}/review`, {
        cookie: o.cookie, csrf: o.csrf, body: { decision: 'confirm' } });
      check('plain confirm on a disagreement case -> 400 explicit_grade_required',
        conf.status === 400 && conf.json.error === 'explicit_grade_required', conf.json);
      const noGrade = await call('POST', `/api/v1/cases/${dis.case_id}/review`, {
        cookie: o.cookie, csrf: o.csrf, body: { decision: 'override', overrideReasonCategory: 'wrong_severity' } });
      check('override without correctedGrade on a disagreement case -> 400', noGrade.status === 400, noGrade.json);
      const after = (await pool.query('SELECT count(*)::int n FROM ophthalmologist_reviews WHERE case_id = $1',
        [dis.case_id])).rows[0].n;
      check('neither rejected review was written', after === before);
    }
    const badGrade = await call('POST', `/api/v1/cases/${cid}/review`, {
      cookie: o.cookie, csrf: o.csrf, body: { decision: 'override', overrideReasonCategory: 'wrong_severity', correctedGrade: 7 } });
    check('correctedGrade out of range -> 400', badGrade.status === 400, badGrade.json);

    // ── Queue hygiene (design doc §5.2) ─────────────────────────────────────
    console.log('\n===== Review queue contents =====');
    const queued = (await call('GET', '/api/v1/ophthalmologist/queue', { cookie: o.cookie })).json;
    check('queue rows carry eyeLaterality and claim state',
      queued.length === 0 || (['eyeLaterality', 'claimedBy', 'claimedAt']
        .every((k) => k in queued[0])), queued[0]);
    if (graded) {
      const reviewedIds = (await pool.query(
        'SELECT DISTINCT case_id FROM ophthalmologist_reviews')).rows.map((r) => r.case_id);
      check('an already-reviewed case is NOT in the queue',
        !queued.some((q) => reviewedIds.includes(q.caseId)),
        queued.filter((q) => reviewedIds.includes(q.caseId)).map((q) => q.caseId));
      const claimedRow = queued.find((q) => q.caseId === graded.case_id);
      check('a claimed case shows who holds it',
        !claimedRow || (claimedRow.claimedBy && claimedRow.claimedBy.name), claimedRow);
    }

    // ── A review needs a graded case ────────────────────────────────────────
    console.log('\n===== Reviewing an ungraded case =====');
    const ungraded = (await pool.query(`
      SELECT c.case_id FROM cases c
      LEFT JOIN grading_results g ON g.case_id = c.case_id
      WHERE g.case_id IS NULL LIMIT 1`)).rows[0];
    if (ungraded) {
      const before = (await pool.query('SELECT count(*)::int n FROM ophthalmologist_reviews')).rows[0].n;
      const r = await call('POST', `/api/v1/cases/${ungraded.case_id}/review`, {
        cookie: o.cookie, csrf: o.csrf, body: { decision: 'confirm' } });
      check('review on a case with no grading result -> 409 case_not_graded',
        r.status === 409 && r.json.error === 'case_not_graded', r.json);
      const after = (await pool.query('SELECT count(*)::int n FROM ophthalmologist_reviews')).rows[0].n;
      check('...and nothing was written', after === before);
    } else {
      console.log('  SKIP  no ungraded case in the database');
    }

    // ── Revoked account ─────────────────────────────────────────────────────
    console.log('\n===== Revocation takes effect before the JWT expires =====');
    if (cleanup.userId) {
      const pw2 = crypto.randomBytes(12).toString('base64url');
      await pool.query('UPDATE users SET password_hash = $2 WHERE user_id = $1',
        [cleanup.userId, await bcrypt.hash(pw2, 4)]);
      const victim = await login({ email: 'verify-second@demo.netrasetu.local', password: pw2 });
      check('the second reviewer can read the queue while the account exists',
        (await call('GET', '/api/v1/ophthalmologist/queue', { cookie: victim.cookie })).status === 200);
      await pool.query('UPDATE users SET role = $2 WHERE user_id = $1',
        [cleanup.userId, 'district_admin']);
      require(path.join(CENTRAL, 'middleware', 'requireAuth'))._clearUserCache();
      const afterRole = await call('GET', '/api/v1/ophthalmologist/queue', { cookie: victim.cookie });
      check('a role change takes effect on the NEXT request, not the next login',
        afterRole.status === 403, afterRole.json);
      // Deactivation, NOT deletion: the account keeps its reviews and its
      // access-log rows (migration 0012), which is what an audit trail means.
      await pool.query('UPDATE users SET is_active = false, deactivated_at = now() WHERE user_id = $1',
        [cleanup.userId]);
      require(path.join(CENTRAL, 'middleware', 'requireAuth'))._clearUserCache();
      const afterDeactivate = await call('GET', '/api/v1/ophthalmologist/queue', { cookie: victim.cookie });
      check('a deactivated account cannot use its unexpired session',
        afterDeactivate.status === 401, afterDeactivate.json);
      const meAfter = await call('GET', '/api/v1/auth/me', { cookie: victim.cookie });
      check('...and /auth/me refuses it too', meAfter.status === 401);
      const reLogin = await login({ email: 'verify-second@demo.netrasetu.local', password: pw2 });
      check('...and it cannot log in again, with the same body as a wrong password',
        reLogin.status === 401 && reLogin.json.error === 'invalid_credentials', reLogin.json);
      // A user who has claimed a case can now actually be removed (the claim
      // is released rather than blocking the delete).
      await pool.query('UPDATE grading_results SET claimed_by = NULL WHERE claimed_by = $1',
        [cleanup.userId]);
    }

    // ── Response hygiene ────────────────────────────────────────────────────
    console.log('\n===== Response headers =====');
    const hdr = await fetch(`${BASE}/health`);
    check('nosniff, frame-deny, no-referrer and no-store are set',
      hdr.headers.get('x-content-type-options') === 'nosniff'
      && hdr.headers.get('x-frame-options') === 'DENY'
      && hdr.headers.get('referrer-policy') === 'no-referrer'
      && /no-store/.test(hdr.headers.get('cache-control') || ''),
      Object.fromEntries(hdr.headers));

    // ── Review history (§B.3) ───────────────────────────────────────────────
    console.log('\n===== Review history (§B.3) =====');
    // Inserted directly rather than through POST /review, which would also raise
    // a referral and attempt an SMS -- side effects a verification run must not
    // have. Deleted again in cleanup.
    let reviewed = (await pool.query('SELECT case_id FROM ophthalmologist_reviews LIMIT 1')).rows[0];
    if (!reviewed && someCase) {
      const ins = (await pool.query(`
        INSERT INTO ophthalmologist_reviews
          (case_id, ophthalmologist_id, decision, override_reason_category, corrected_grade, reviewed_at)
        VALUES ($1, $2, 'override', 'wrong_severity', 3, now()),
               ($1, 'legacy-free-text-id', 'confirm', NULL, NULL, now() - interval '1 day')
        RETURNING review_id`, [someCase.case_id, o.json.user.userId])).rows;
      cleanup.reviewId = ins.map((r) => r.review_id);
      reviewed = someCase;
      console.log('  (no reviews recorded yet; inserting two temporary ones)');
    }
    if (reviewed) {
      const h = await call('GET', `/api/v1/cases/${reviewed.case_id}/reviews`, { cookie: o.cookie });
      check('GET reviews -> 200 array, newest first', h.status === 200 && Array.isArray(h.json) &&
        h.json.length > 0 && h.json.every((x, i, arr) => i === 0 || arr[i - 1].reviewedAt >= x.reviewedAt), h.json);
      check('review item shape', h.json[0] && 'decision' in h.json[0] && 'correctedGrade' in h.json[0] &&
        'reviewer' in h.json[0] && 'overrideReasonCategory' in h.json[0], h.json[0]);
      if (cleanup.reviewId) {
        check('logged-in reviewer is resolved to { userId, name }; correctedGrade returned',
          h.json[0].reviewer && h.json[0].reviewer.name === 'Dr. Demo Ophthalmologist' &&
          h.json[0].correctedGrade === 3, h.json[0]);
        check('a legacy free-text reviewer id gives reviewer null, raw id kept',
          h.json[1].reviewer === null && h.json[1].ophthalmologistId === 'legacy-free-text-id', h.json[1]);
      }
      const hAdmin = await call('GET', `/api/v1/cases/${reviewed.case_id}/reviews`, { cookie: a.cookie });
      check('admin may read review history too', hAdmin.status === 200);
    } else {
      console.log('  SKIP  no reviews recorded yet');
    }
    const hNone = await call('GET', `/api/v1/cases/${crypto.randomUUID()}/reviews`, { cookie: o.cookie });
    check('reviews of an unknown case -> 404', hNone.status === 404);

    // ── Access log (§A.13) ──────────────────────────────────────────────────
    console.log('\n===== Access log (§A.13) =====');
    const logged = (await pool.query(`
      SELECT action FROM access_log WHERE user_id = $1 AND "timestamp" > now() - interval '5 minutes'`,
      [o.json.user.userId])).rows.map((r) => r.action);
    check('viewing the queue was logged', logged.includes('view_queue'), logged);
    if (graded) check('claiming a case was logged', logged.includes('claim_case'), logged);
    const adminLogged = (await pool.query(`
      SELECT action FROM access_log WHERE user_id = $1 AND "timestamp" > now() - interval '5 minutes'`,
      [a.json.user.userId])).rows.map((r) => r.action);
    check('viewing the admin dashboard was logged', adminLogged.includes('view_dashboard'), adminLogged);
    check('a REJECTED request (403) wrote no log row',
      !adminLogged.includes('view_queue'), adminLogged);

    // ── Logout ──────────────────────────────────────────────────────────────
    const out = await call('POST', '/api/v1/auth/logout', { cookie: o.cookie });
    check('logout -> 204 and clears the cookie', out.status === 204 && /ns_session=;/.test(out.setCookie || ''),
      out.setCookie);
  } finally {
    if (cleanup.reviewId) {
      await pool.query('DELETE FROM ophthalmologist_reviews WHERE review_id = ANY($1::uuid[])',
        [cleanup.reviewId]);
    }
    if (cleanup.agreementRestore) {
      await pool.query('UPDATE grading_results SET branch_agreement = $2 WHERE case_id = $1',
        [cleanup.agreementRestore.case_id, cleanup.agreementRestore.branch_agreement]);
    }
    if (cleanup.claimRestore) {
      await pool.query('UPDATE grading_results SET claimed_by = $2, claimed_at = $3 WHERE case_id = $1',
        [cleanup.claimRestore.case_id, cleanup.claimRestore.claimed_by, cleanup.claimRestore.claimed_at]);
    }
    if (cleanup.userId) {
      await pool.query('DELETE FROM access_log WHERE user_id = $1', [cleanup.userId]);
      await pool.query('DELETE FROM users WHERE user_id = $1', [cleanup.userId]);
    }
    if (cleanup.phcId) await pool.query('DELETE FROM phc_sites WHERE phc_id = $1', [cleanup.phcId]);
    await gradingQueue.stop({ drain: false }).catch(() => {});
    server.close();
    await pool.end();
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
