'use strict';

/**
 * peerBundle.js -- the no-network fallback (design doc §4.2 "export queue to
 * external drive", used here for desktop <-> phone hand-carry too).
 *
 * A bundle is one JSON file:
 *   { kind: 'netrasetu-bundle', v: 1, fromDevice, toDevice, createdAt, envelope }
 * where `envelope` is AES-256-GCM (peerCrypto) over
 *   { records: [...wire records], images: { captureId: { bytesB64, sha256, ext } } }
 * sealed with the phone's pairing key, AAD binding it to sender, recipient and
 * time. A lost USB stick exposes nothing; a modified file fails to open.
 */
const db = require('../db/localDb');
const peerCrypto = require('./peerCrypto');
const peerSync = require('./peerSync');

function deviceKey(deviceId) {
  const d = db.prepare('SELECT * FROM peer_devices WHERE device_id = ?').get(deviceId);
  if (!d || d.revoked_at) throw Object.assign(new Error(`device ${deviceId} is not paired with this PC`), { code: 'peer_unknown' });
  return peerCrypto.keyFromB64(d.key_b64);
}

/** Opens and applies a bundle addressed to this PC. */
function importBundle(bundle) {
  if (!bundle || bundle.kind !== 'netrasetu-bundle' || bundle.v !== 1) {
    throw Object.assign(new Error('not a NetraSetu bundle'), { code: 'bundle_invalid' });
  }
  if (bundle.toDevice !== db.deviceId()) {
    throw Object.assign(new Error(`bundle is addressed to ${bundle.toDevice}, this PC is ${db.deviceId()}`), { code: 'bundle_wrong_recipient' });
  }
  const key = deviceKey(bundle.fromDevice);
  const payload = peerCrypto.openJson(key, bundle.envelope, peerCrypto.bundleAad(bundle));
  for (const [captureId, img] of Object.entries(payload.images || {})) {
    if (!peerSync.existingImagePath(captureId)) {
      peerSync.writeImage(captureId, Buffer.from(img.bytesB64, 'base64'), img.sha256, img.ext);
    }
  }
  const out = peerSync.applyRecords(payload.records || [], bundle.fromDevice);
  return { ...out, fromDevice: bundle.fromDevice, records: (payload.records || []).length };
}

/** Everything this PC has for a phone that it has not seen yet (or everything), sealed for that phone. */
function exportBundle(toDevice, { cursor = 0 } = {}) {
  const key = deviceKey(toDevice);
  const records = [];
  let c = cursor;
  for (;;) {
    const page = peerSync.changesSince(c, toDevice);
    records.push(...page.records);
    c = page.cursor;
    if (!page.more) break;
  }
  const images = {};
  for (const r of records) {
    if (r.kind !== 'capture') continue;
    const img = peerSync.readImage(r.data.captureId);
    if (img) images[r.data.captureId] = { bytesB64: img.bytes.toString('base64'), sha256: img.sha256, ext: img.ext };
  }
  const header = { kind: 'netrasetu-bundle', v: 1, fromDevice: db.deviceId(), toDevice, createdAt: new Date().toISOString() };
  return { ...header, envelope: peerCrypto.seal(key, { records, images, cursor: c }, peerCrypto.bundleAad(header)) };
}

module.exports = { importBundle, exportBundle };
