'use strict';

/**
 * routes/media.js -- case media (fundus images, Grad-CAM overlays, lesion
 * masks, report PDFs), mounted at /media.
 *
 * Replaces express.static for three reasons:
 *   - auth AND role on every file (backend plan §A.3, §A.7): any logged-in
 *     ophthalmologist or district_admin, nobody else. The session cookie rides
 *     on <img> requests, so no signed-URL scheme is needed;
 *   - files may be encrypted at rest (services/mediaCrypto.js) and are
 *     decrypted here, on the way out, never on disk;
 *   - every file served is a read of patient data and goes to access_log
 *     (§A.13) as action view_media, resource_type media, resource_id the path.
 *
 * URLs stay exactly what the API returns (mediaPaths.toPublicUrl): relative
 * /media/... paths, never an absolute backend URL.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const requireAuth  = require('../middleware/requireAuth');
const requireRole  = require('../middleware/requireRole');
const mediaPaths   = require('../services/mediaPaths');
const mediaCrypto  = require('../services/mediaCrypto');
const { logAccess } = require('../services/accessLog');

const router = express.Router();

const notFound = (res) => res.status(404).json({ error: 'not_found', message: 'No such media file.' });

router.get('/*', requireAuth, requireRole('ophthalmologist', 'district_admin'), async (req, res, next) => {
  // Resolve inside MEDIA_ROOT only. decodeURIComponent first so %2e%2e cannot
  // slip past, then refuse anything that resolves outside the root.
  let rel;
  try {
    rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  } catch {
    return notFound(res);
  }
  const abs = path.resolve(mediaPaths.MEDIA_ROOT, rel);
  const inside = path.relative(mediaPaths.MEDIA_ROOT, abs);
  if (!rel || inside.startsWith('..') || path.isAbsolute(inside)) return notFound(res);
  // In-flight chunked uploads live under media/chunks/ but are not media: a
  // fragment of an image is never something a browser should fetch.
  if (inside.split(path.sep)[0] === 'chunks') return notFound(res);

  let stat;
  try { stat = fs.statSync(abs); } catch { return notFound(res); }
  if (!stat.isFile()) return notFound(res);

  let body;
  try {
    body = mediaCrypto.readFile(abs);
  } catch (err) {
    // A missing key or a failed GCM tag: never send the ciphertext as if it
    // were the image.
    console.error(`[media] cannot decrypt ${rel}: ${err.message}`);
    return res.status(500).json({
      error: err.code === 'media_key_missing' ? 'media_key_missing' : 'media_decrypt_failed',
      message: 'The file could not be decrypted on the server.',
    });
  }

  try {
    await logAccess(req.user?.userId, 'view_media', 'media', `/media/${inside.split(path.sep).join('/')}`);
    res.type(path.extname(abs) || 'application/octet-stream');
    res.setHeader('Content-Length', body.length);
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  } catch (err) { return next(err); }
});

module.exports = router;
