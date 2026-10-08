'use strict';

/**
 * routes/patients.js  (Task 3.2)
 *
 * Mounted at /patients. Implements the "Local API" patient endpoints from
 * docs/api-contracts.md:
 *
 *   POST /patients            -> 201 { patientId, name, age, contactNumber, registeredAt,
 *                                        consentGivenAt }
 *   GET  /patients/search     -> 200 [ duplicate candidates ]   (design doc §10.3)
 *   GET  /patients/:patientId -> 200 same shape | 404 patient_not_found
 *
 * The DB stores snake_case; every response here is camelCase. That translation
 * happens in this file and nowhere else -- not in db/localDb.js, not in a
 * frontend component (api-contracts.md, "Global naming rule").
 */

const express = require('express');

const db                  = require('../db/localDb');
const { generateLocalId } = require('../services/ids');

const router = express.Router();

/**
 * toPatientResponse(row)
 *
 * The single snake_case -> camelCase mapping for a patient. Every route that
 * returns a patient goes through this, so POST and GET cannot drift into
 * returning subtly different shapes for the same record.
 */
function toPatientResponse(row) {
  return {
    patientId:     row.patient_id,
    name:          row.name,
    age:           row.age,
    contactNumber: row.contact_number,
    registeredAt:  row.registered_at,
    consentGivenAt: row.consent_given_at ?? null,
  };
}

// ── POST /patients ───────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { name, age, contactNumber, consentGivenAt } = req.body || {};

  // contactNumber is the contract's only explicitly required field, and it is
  // required for a real reason: it is the sole channel for delivering a result
  // to a patient who has already gone home (design doc §4.1). A patient
  // registered without one cannot be told their outcome in the offline flow.
  if (!contactNumber) {
    return res.status(400).json({
      error: 'contact_number_required',
      message: 'contactNumber is required — it is the only channel for delayed results.',
    });
  }
  if (!name) {
    return res.status(400).json({
      error: 'name_required',
      message: 'name is required.',
    });
  }

  const parsedAge = Number(age);
  if (!Number.isInteger(parsedAge) || parsedAge < 0 || parsedAge > 130) {
    return res.status(400).json({
      error: 'invalid_age',
      message: 'age must be an integer between 0 and 130.',
    });
  }

  // §9.7: the frontend timestamps the moment the technician ticks "verbal
  // consent obtained" and sends it here. Optional at the API so older clients
  // keep working; the registration screen is what makes it mandatory.
  let consent = null;
  if (consentGivenAt !== undefined && consentGivenAt !== null && consentGivenAt !== '') {
    const t = new Date(consentGivenAt);
    if (Number.isNaN(t.getTime())) {
      return res.status(400).json({
        error: 'invalid_field', message: 'consentGivenAt must be an ISO-8601 timestamp.',
      });
    }
    consent = t.toISOString();
  }

  const row = {
    patient_id:       generateLocalId(),
    name:             String(name),
    age:              parsedAge,
    contact_number:   String(contactNumber),
    registered_at:    new Date().toISOString(),
    consent_given_at: consent,
  };

  db.prepare(`
    INSERT INTO patients (patient_id, name, age, contact_number, registered_at, consent_given_at)
    VALUES (@patient_id, @name, @age, @contact_number, @registered_at, @consent_given_at)
  `).run(row);

  res.status(201).json(toPatientResponse(row));
});

// ── GET /patients/search?name=&age=&phone= ──────────────────────────────────
// Design doc §10.3: before minting a new patient id, check this PHC's own
// records for the same person. Same query parameters, matching rules and
// response shape as central's GET /api/v1/patients/search (see that file for
// the reasoning), so a frontend can call either -- this one works offline.
// Differences: it searches only this PHC's patients, and returns the full
// contact number, since it is this site's own data.
//
// Declared BEFORE /:patientId, which would otherwise swallow 'search' as an id.
router.get('/search', (req, res) => {
  const name  = typeof req.query.name === 'string' ? req.query.name.trim().toLowerCase() : '';
  const phone = typeof req.query.phone === 'string' ? req.query.phone.replace(/\D/g, '') : '';
  const ageRaw = req.query.age;
  const age = ageRaw === undefined || ageRaw === '' ? null : Number(ageRaw);

  if (!name && !phone) {
    return res.status(400).json({
      error: 'invalid_field', message: 'Give at least a name or a phone number to search on.',
    });
  }
  if (age !== null && !(Number.isInteger(age) && age >= 0 && age <= 130)) {
    return res.status(400).json({ error: 'invalid_field', message: 'age must be an integer 0-130.' });
  }
  if (phone && phone.length < 4) {
    return res.status(400).json({
      error: 'invalid_field', message: 'phone needs at least 4 digits to search on.',
    });
  }

  const words = name.split(/\s+/).filter((w) => w.length >= 3);
  const phone10 = phone.slice(-10);
  const digits = (s) => String(s || '').replace(/\D/g, '');

  // One PHC's register is small enough to score in JS, which keeps the
  // matching rules readable and identical to central's without SQLite regex.
  const results = db.prepare('SELECT * FROM patients').all()
    .map((r) => {
      const n = r.name.toLowerCase();
      const nameFull = !!name && n.includes(name);
      const nameWord = !nameFull && words.some((w) => n.includes(w));
      const phoneHit = !!phone10 && digits(r.contact_number).endsWith(phone10);
      const ageHit   = age !== null && Math.abs(r.age - age) <= 1;
      const matchedOn = [];
      if (nameFull || nameWord) matchedOn.push('name');
      if (phoneHit) matchedOn.push('phone');
      if (ageHit) matchedOn.push('age');
      return {
        row: r, matchedOn,
        score: (nameFull ? 3 : nameWord ? 2 : 0) + (phoneHit ? 3 : 0) + (ageHit ? 1 : 0),
        candidate: nameFull || nameWord || phoneHit,
      };
    })
    .filter((x) => x.candidate)
    .sort((a, b) => b.score - a.score
      || String(b.row.registered_at).localeCompare(String(a.row.registered_at)))
    .slice(0, 20);

  res.json(results.map(({ row, matchedOn, score }) => ({
    ...toPatientResponse(row), matchedOn, score,
  })));
});

// ── GET /patients/:patientId ─────────────────────────────────────────────────
router.get('/:patientId', (req, res) => {
  const row = db
    .prepare('SELECT * FROM patients WHERE patient_id = ?')
    .get(req.params.patientId);

  if (!row) {
    return res.status(404).json({
      error: 'patient_not_found',
      message: `No patient with id ${req.params.patientId}`,
    });
  }

  res.json(toPatientResponse(row));
});

// ── GET /patients ────────────────────────────────────────────────────────────
// Not in api-contracts.md. Kept because Task 0.1's Definition of Done curls it,
// and the Patient Lookup screen needs a list to search. Deliberately capped:
// this is a local single-PHC database, but an unbounded SELECT that grows all
// season is a slow surprise waiting to happen on modest PHC hardware.
router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM patients ORDER BY registered_at DESC LIMIT 200')
    .all();
  res.json(rows.map(toPatientResponse));
});

module.exports = router;
