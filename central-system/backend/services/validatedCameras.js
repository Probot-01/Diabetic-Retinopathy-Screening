/**
 * validatedCameras.js — is this camera, at this site, approved to auto-clear?
 *
 * Reads config/validatedCameras.json (see that file's _comment for the
 * evidence behind the control and what "validated" is required to mean).
 *
 * ── WHY THIS IS SEPARATE FROM CAMERA/SITE PROBATION ────────────────────────
 * gradingOrchestrator already has hasClearedCameraSiteProbation, and the two
 * look similar enough to be confused. They are not the same check:
 *
 *   probation  — "has this camera/site pair been used here before?"  Counts
 *                prior graded cases. Nobody confirms those grades were RIGHT,
 *                so a camera the model is quietly wrong about graduates on
 *                schedule, and it only touches the tier when there is ALSO a
 *                reported-vs-detected family mismatch.
 *   this file  — "did a human check this camera against known-correct grades
 *                at this site?"  Answerable only by a person, so it is a
 *                config file someone edits, never a number the system infers
 *                about itself.
 *
 * Both stay. Probation catches an unfamiliar-LOOKING image; this catches an
 * unfamiliar camera that looks perfectly normal — which is the Messidor-2
 * case, where nothing about the image announces that sensitivity has dropped
 * twenty points.
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────
 * A missing, unreadable or malformed config means NOT validated, for every
 * camera. The failure mode of guessing wrong here is a silently auto-cleared
 * referable patient, so a broken config must cost review time, never safety.
 * The one exception is an explicit "enforce": false, which is a decision
 * someone wrote down.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'validatedCameras.json');

let cache = null;

/**
 * load() -> { enforce, entries, error }
 *
 * Cached: this is read on every case, and the answer cannot change without a
 * restart (the file is edited by a person, not by the system). Call
 * reload() in a test that needs to swap the config.
 */
function load() {
  if (cache) return cache;

  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    cache = {
      enforce: true,
      entries: [],
      error: `validatedCameras.json could not be read (${err.code}) — `
        + 'treating every camera as UNVALIDATED',
    };
    console.warn(`[validatedCameras] ${cache.error}`);
    return cache;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    cache = {
      enforce: true,
      entries: [],
      error: `validatedCameras.json is not valid JSON (${err.message}) — `
        + 'treating every camera as UNVALIDATED',
    };
    console.error(`[validatedCameras] ${cache.error}`);
    return cache;
  }

  const enforce = parsed.enforce !== false;
  const entries = Array.isArray(parsed.validated) ? parsed.validated : [];

  if (!enforce) {
    console.warn('[validatedCameras] enforce=false — the unvalidated-camera '
      + 'Tier A floor is DISABLED. An unvalidated camera can auto-clear.');
  }

  cache = { enforce, entries, error: null };
  return cache;
}

function reload() {
  cache = null;
  return load();
}

/**
 * isValidatedCamera(phcId, cameraDeviceId) -> boolean
 *
 * True only when an entry explicitly names this camera, and either this site
 * or '*'. Matching is case-insensitive and trims whitespace, because these
 * ids arrive from a worker-facing form and 'Topcon_TRC_NW400 ' is the same
 * device as 'topcon_trc_nw400'.
 *
 * A blank/absent cameraDeviceId is FALSE — see the header.
 */
function isValidatedCamera(phcId, cameraDeviceId) {
  const { entries } = load();
  const cam = norm(cameraDeviceId);
  if (!cam) return false;

  const site = norm(phcId);
  return entries.some((e) => {
    if (norm(e.cameraDeviceId) !== cam) return false;
    const entrySite = norm(e.phcId);
    return entrySite === '*' || (entrySite !== '' && entrySite === site);
  });
}

/**
 * cameraNotValidated(phcId, cameraDeviceId) -> boolean
 *
 * The signal the tier floor consumes: true means "do not auto-clear this".
 * False whenever enforcement is off, so the floor disappears cleanly rather
 * than every case being flagged as unvalidated in a dev environment.
 */
function cameraNotValidated(phcId, cameraDeviceId) {
  if (!load().enforce) return false;
  return !isValidatedCamera(phcId, cameraDeviceId);
}

function norm(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

module.exports = {
  isValidatedCamera,
  cameraNotValidated,
  reload,
  CONFIG_PATH,
};
