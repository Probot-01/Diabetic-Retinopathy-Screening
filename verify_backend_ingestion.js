'use strict';

/**
 * verify_backend_ingestion.js -- backend plan §C (idempotent ingestion) and
 * the summary-first path (design doc §10.1 / §10.6).
 *
 * Run:  node verify_backend_ingestion.js
 *
 * Needs the central Postgres with migrations applied (`npm run migrate`). Does
 * NOT need MATLAB: gradingQueue.enqueue is replaced by a recorder, because what
 * is under test is WHETHER a case gets queued, not the grading itself.
 *
 * Everything created here -- a temporary PHC site, patient, cases and their
 * media folders -- is removed at the end.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const CENTRAL = path.resolve(__dirname, 'central-system', 'backend');
require(require.resolve('dotenv', { paths: [CENTRAL] }))
  .config({ path: path.resolve(__dirname, '.env') });

// Flags off: this is about ingestion semantics, and verify_backend_auth.js
// already covers the key checks on these same routes.
process.env.AUTH_ENABLED = 'false';
process.env.PHC_AUTH_ENABLED = 'false';

const gradingQueue = require(path.join(CENTRAL, 'services', 'gradingQueue'));
const enqueued = [];
gradingQueue.enqueue = (caseId) => { enqueued.push(caseId); };

const app        = require(path.join(CENTRAL, 'server.js'));
const pool       = require(path.join(CENTRAL, 'db', 'pgClient'));
const mediaPaths = require(path.join(CENTRAL, 'services', 'mediaPaths'));

const IMAGE = fs.readFileSync(path.resolve(__dirname, 'datasets', '2.jpg'));

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`); }
}

let BASE;
const ref = () => `ZZTEST-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;

async function postCase(fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  form.append('image', new Blob([IMAGE], { type: 'image/jpeg' }), 'fundus.jpg');
  const res = await fetch(`${BASE}/api/v1/cases`, { method: 'POST', body: form });
  return { status: res.status, json: await res.json() };
}

async function postSummary(body) {
  const res = await fetch(`${BASE}/api/v1/cases/summary`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const site = (await pool.query(
    "INSERT INTO phc_sites (name) VALUES ('ZZ verify_backend_ingestion temp') RETURNING phc_id")).rows[0];
  const patientId = `ZZTEST-${crypto.randomBytes(4).toString('hex')}`;
  const base = {
    patientId, phcId: site.phc_id, cameraDeviceId: 'forus_3nethra_v2',
    patientName: 'Zz Verify Ingestion', patientAge: 50, patientContactNumber: '+910000000000',
    capturedAt: '2026-09-20T08:00:00.000Z',
  };

  try {
    // ── Summary first, then the image ───────────────────────────────────────
    console.log('\n===== Summary first, image later (§10.1) =====');
    const r1 = ref();
    const s1 = await postSummary({ ...base, captureIdRef: r1,
      questionnaireData: { symptoms: { blurredVision: true } } });
    check('summary creates the case -> 201 awaiting_image',
      s1.status === 201 && s1.json.status === 'awaiting_image' && !s1.json.duplicate, s1);
    const st = await (await fetch(`${BASE}/api/v1/cases/${s1.json.caseId}/status`)).json();
    check('status endpoint reports awaiting_image', st.status === 'awaiting_image', st);
    check('a summary is NOT queued for grading (there is no image)', !enqueued.includes(s1.json.caseId));
    const contact = (await pool.query('SELECT last_contact_at, last_sync_at FROM phc_sites WHERE phc_id = $1',
      [site.phc_id])).rows[0];
    check('summary stamps last_contact_at but NOT last_sync_at (§F.1)',
      !!contact.last_contact_at && contact.last_sync_at === null, contact);

    const s1b = await postSummary({ ...base, captureIdRef: r1 });
    check('repeated summary -> 200 duplicate, same case',
      s1b.status === 200 && s1b.json.duplicate && s1b.json.caseId === s1.json.caseId, s1b);

    const c1 = await postCase({ ...base, captureIdRef: r1 });
    check('image for that capture -> 201 on the SAME case, fromSummary',
      c1.status === 201 && c1.json.caseId === s1.json.caseId && c1.json.fromSummary === true, c1);
    check('...and now it is queued for grading exactly once',
      enqueued.filter((id) => id === s1.json.caseId).length === 1, enqueued);
    const row = (await pool.query(
      'SELECT status, image_path, questionnaire_data FROM cases WHERE case_id = $1', [s1.json.caseId])).rows[0];
    check('row moved to processing with an image on disk',
      row.status === 'processing' && row.image_path && fs.existsSync(row.image_path), row);
    check("the summary's questionnaire survived the image upload",
      row.questionnaire_data && row.questionnaire_data.symptoms.blurredVision === true, row.questionnaire_data);

    const s1c = await postSummary({ ...base, captureIdRef: r1 });
    check('a late summary after the image -> 200 duplicate, nothing changes',
      s1c.status === 200 && s1c.json.duplicate && s1c.json.status === 'processing', s1c);

    // ── Retries of a full upload ────────────────────────────────────────────
    console.log('\n===== Retried uploads (§10.6) =====');
    const again = await postCase({ ...base, captureIdRef: r1 });
    check('re-uploading an ingested capture -> 200 duplicate, same caseId',
      again.status === 200 && again.json.duplicate && again.json.caseId === s1.json.caseId, again);
    check('...and it is NOT graded a second time',
      enqueued.filter((id) => id === s1.json.caseId).length === 1);
    const count = (await pool.query('SELECT count(*)::int n FROM cases WHERE capture_id_ref = $1', [r1])).rows[0].n;
    check('still exactly one case row for the capture', count === 1, count);

    const r2 = ref();
    const direct = await postCase({ ...base, captureIdRef: r2 });
    check('a new capture without a summary -> 201, queued',
      direct.status === 201 && !direct.json.duplicate && enqueued.includes(direct.json.caseId), direct);

    // ── Concurrency ─────────────────────────────────────────────────────────
    console.log('\n===== Concurrent retries =====');
    const r3 = ref();
    const burst = await Promise.all(Array.from({ length: 6 }, () => postCase({ ...base, captureIdRef: r3 })));
    const created = burst.filter((b) => b.status === 201);
    const ids = new Set(burst.map((b) => b.json.caseId));
    check('6 simultaneous uploads of one capture -> exactly one 201, the rest 200',
      created.length === 1 && burst.every((b) => b.status === 201 || b.status === 200),
      burst.map((b) => b.status));
    check('...all answering with the same caseId', ids.size === 1, [...ids]);
    check('...and one grading job', enqueued.filter((id) => ids.has(id)).length === 1);

    // ── Validation and the database's own guard ─────────────────────────────
    console.log('\n===== Validation =====');
    const noRef = await postSummary({ ...base });
    check('summary without captureIdRef -> 400 capture_id_required',
      noRef.status === 400 && noRef.json.error === 'capture_id_required', noRef);
    const unknown = await postSummary({ patientId: `ZZTEST-nobody-${Date.now()}`, captureIdRef: ref() });
    check('summary for an unknown patient without demographics -> 404 patient_not_found',
      unknown.status === 404, unknown);
    let dbRefused = false;
    try {
      await pool.query(`INSERT INTO cases (patient_id, capture_id_ref, image_path, status)
                        VALUES ($1, $2, NULL, 'processing')`, [patientId, ref()]);
    } catch (err) { dbRefused = err.code === '23514'; }
    check("the database itself refuses a 'processing' case with no image", dbRefused);
  } finally {
    const cases = (await pool.query('SELECT case_id FROM cases WHERE patient_id = $1', [patientId])).rows;
    await pool.query('DELETE FROM cases WHERE patient_id = $1', [patientId]);
    for (const { case_id: id } of cases) {
      const dir = path.dirname(mediaPaths.originalPath(id, '.jpg'));
      if (dir.includes(id)) fs.rmSync(dir, { recursive: true, force: true });
    }
    await pool.query('DELETE FROM patients WHERE patient_id = $1', [patientId]);
    await pool.query('DELETE FROM phc_sites WHERE phc_id = $1', [site.phc_id]);
    await gradingQueue.stop({ drain: false }).catch(() => {});
    server.close();
    await pool.end();
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
