'use strict';

/**
 * mediaPaths.js
 *
 * The one definition of where a case's files live on disk and what URL they are
 * served at.
 *
 * api-contracts.md's case-detail response returns
 *
 *     "imageUrl":          "/media/cases/a1b2c3d4/original.jpg"
 *     "gradCamOverlayUrl": "/media/cases/a1b2c3d4/gradcam.png"
 *
 * and server.js serves `/media` statically from `backend/media`. So the URL and
 * the filesystem path are two views of the same fact, and they have to be
 * derived together — a file written anywhere else is simply not reachable by
 * the frontend, silently, with a 404 on an image the API said existed.
 *
 * That is not hypothetical: gradingOrchestrator.js originally wrote Grad-CAM
 * PNGs to `backend/explainability-outputs/`, which is outside the static root.
 * The path stored in the database was correct and the file was really there,
 * and the contract's URL could still never have resolved.
 *
 * Both this module's consumers — ingestionService.js (original image) and
 * gradingOrchestrator.js (Grad-CAM overlay) — must use these helpers rather
 * than building paths of their own.
 */

const fs   = require('fs');
const path = require('path');

// MEDIA_ROOT overrides the default so tests can write to a scratch directory.
const MEDIA_ROOT = process.env.MEDIA_ROOT
  ? path.resolve(process.env.MEDIA_ROOT)
  : path.resolve(__dirname, '..', 'media');
const CASES_ROOT = path.join(MEDIA_ROOT, 'cases');

/** Absolute directory holding one case's media. Created if absent. */
function caseDir(caseId) {
  const dir = path.join(CASES_ROOT, caseId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Original fundus image.
 *
 * The extension is preserved rather than forced to .jpg: the bytes are stored
 * exactly as uploaded and never transcoded, so naming a PNG `.jpg` would be a
 * file whose extension lies about its contents. The contract's example shows
 * `original.jpg` because that is the common case, not because the name is fixed.
 */
function originalPath(caseId, ext = '.jpg') {
  return path.join(caseDir(caseId), `original${ext}`);
}
function originalUrl(caseId, ext = '.jpg') {
  return `/media/cases/${caseId}/original${ext}`;
}

/** Grad-CAM overlay produced by the grading pipeline. */
function gradcamPath(caseId) {
  return path.join(caseDir(caseId), 'gradcam.png');
}
function gradcamUrl(caseId) {
  return `/media/cases/${caseId}/gradcam.png`;
}

/**
 * Map a stored absolute path back to its public URL.
 *
 * Returns null for a path outside the media root rather than guessing — an
 * unreachable file must surface as a null URL the frontend renders as "not
 * available", never as a URL that 404s.
 */
function toPublicUrl(absPath) {
  if (!absPath) return null;
  const rel = path.relative(MEDIA_ROOT, path.resolve(absPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `/media/${rel.split(path.sep).join('/')}`;
}

module.exports = {
  MEDIA_ROOT, CASES_ROOT,
  caseDir, originalPath, originalUrl, gradcamPath, gradcamUrl, toPublicUrl,
};
