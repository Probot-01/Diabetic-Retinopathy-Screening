'use strict';

/**
 * routes/patients.js -- duplicate-patient lookup (backend plan §B.1, design
 * doc §10.3).
 *
 * Mounted at /api/v1/patients.
 *
 *   GET /api/v1/patients/search?name=&age=&phone=
 *     200 [ { patientId, patientReference, name, age, contactNumberMasked,
 *             registeredAt, matchedOn: ['name'|'phone'|'age'], score } ]
 *     400 { error: 'invalid_field' }   neither name nor phone given
 *
 * Called by the PHC apps at registration, before a new patient id is minted,
 * so the technician can confirm "is this the same person?" and reuse the
 * existing id instead of creating a duplicate. The desktop app's local backend
 * serves the SAME query and response shape at GET /patients/search against its
 * own SQLite, so the duplicate check still works offline.
 *
 * ── Matching (deliberately simple, per the plan) ─────────────────────────────
 * A row is a candidate when its NAME or PHONE matches; age alone never makes a
 * candidate (half a district shares any given age) but raises the score:
 *   name   case-insensitive: whole query contained in the name (+3), else any
 *          query word of 3+ letters contained in it (+2) -- catches
 *          "Sunita Devi" vs "Devi Sunita" and a missing surname.
 *   phone  digits only, last 10 compared, so "+91 98xxx" == "98xxx" (+3).
 *   age    within ±1 year (+1) -- registered ages drift by a birthday.
 * Top 20 by score. No trigram/phonetic matching yet; spelling variants like
 * "Sunita"/"Sunitha" only match through the phone or another name word.
 *
 * ── Privacy ──────────────────────────────────────────────────────────────────
 * This searches every patient in the district, so the phone number comes back
 * masked to its last 4 digits: enough for the technician to ask "does your
 * number end in 4821?", not enough to harvest numbers by searching names.
 *
 * Auth: a PHC device key (requirePhcApiKey) -- the callers are PHC apps, not
 * browser users. Device requests have no user, so they are not written to
 * access_log (its user_id is NOT NULL); requirePhcApiKey still stamps the PHC's
 * last_contact_at.
 */

const express = require('express');
const pool    = require('../db/pgClient');
const { requirePhcApiKey } = require('../middleware/requirePhcApiKey');

const router = express.Router();

const MAX_RESULTS = 20;

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 4 ? `******${d.slice(-4)}` : null;
}

router.get('/search', requirePhcApiKey, async (req, res, next) => {
  const name  = typeof req.query.name === 'string' ? req.query.name.trim() : '';
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

  // Words of 3+ letters, escaped for LIKE. Short fragments ("A.", "Ku") would
  // match most of the table and bury the real candidates.
  const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const words = name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3).map(likeEscape);
  const phone10 = phone.slice(-10);

  try {
    const { rows } = await pool.query(`
      WITH scored AS (
        SELECT p.patient_id, p.patient_reference, p.name, p.age, p.contact_number,
               p.registered_at,
               ($1 <> '' AND lower(p.name) LIKE '%' || $1 || '%')              AS name_full,
               (cardinality($2::text[]) > 0 AND EXISTS (
                  SELECT 1 FROM unnest($2::text[]) w
                  WHERE lower(p.name) LIKE '%' || w || '%'))                  AS name_word,
               ($3 <> '' AND right(regexp_replace(p.contact_number, '\\D', '', 'g'),
                                   length($3)) = $3)                           AS phone_hit,
               ($4::int IS NOT NULL AND abs(p.age - $4::int) <= 1)             AS age_hit
        FROM patients p
      )
      SELECT * FROM scored
      WHERE name_full OR name_word OR phone_hit
      ORDER BY (CASE WHEN name_full THEN 3 WHEN name_word THEN 2 ELSE 0 END
              + CASE WHEN phone_hit THEN 3 ELSE 0 END
              + CASE WHEN age_hit   THEN 1 ELSE 0 END) DESC,
               registered_at DESC
      LIMIT ${MAX_RESULTS}
    `, [likeEscape(name.toLowerCase()), words, phone10, age]);

    res.json(rows.map((r) => {
      const matchedOn = [];
      if (r.name_full || r.name_word) matchedOn.push('name');
      if (r.phone_hit) matchedOn.push('phone');
      if (r.age_hit) matchedOn.push('age');
      return {
        patientId:           r.patient_id,
        patientReference:    r.patient_reference ?? null,
        name:                r.name,
        age:                 r.age,
        contactNumberMasked: maskPhone(r.contact_number),
        registeredAt:        r.registered_at.toISOString(),
        matchedOn,
        score: (r.name_full ? 3 : r.name_word ? 2 : 0) + (r.phone_hit ? 3 : 0) + (r.age_hit ? 1 : 0),
      };
    }));
  } catch (err) { next(err); }
});

module.exports = router;
