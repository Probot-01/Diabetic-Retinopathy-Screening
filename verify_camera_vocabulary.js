#!/usr/bin/env node
'use strict';

/**
 * verify_camera_vocabulary.js
 *
 * One camera id crosses four files, and until now nothing checked they agreed:
 *
 *   phc-local-app/frontend/src/api/captureOptions.js   what the technician picks
 *   phc-local-app/backend/services/syncManager.js      what is sent to central
 *   central .../calibrationProfiles.json               what the cross-check knows
 *   docs/api-contracts.md                              what the contract claims
 *
 * The drift this catches is silent by construction. classifyCameraFamily.m can
 * only cross-check a reported device it has an association for, and when it has
 * none it returns "no mismatch" -- indistinguishable, before migration 0021,
 * from a camera that was checked and agreed. So a front-end that starts
 * offering a new camera does not fail anything: the cross-check just quietly
 * stops running for it, and every case from that camera reads as fine.
 *
 * Checks:
 *   1. Every id the PHC front-end offers is NAMED in deviceAssociations, so a
 *      deliberate "not checkable" (null) never looks like an omission.
 *   2. Every family an association points at is a real family in the same file.
 *   3. At least one offered id is actually checkable -- otherwise the whole
 *      cross-check is dead and nothing else here would notice.
 *   4. The contract does not still send readers to cameraPresets.json for
 *      device ids; that file holds the PHC gate's optics presets and never
 *      held device ids.
 *
 * It reads files only -- no database, no MATLAB, no network.
 *
 *   node verify_camera_vocabulary.js
 */

const fs = require('fs');
const path = require('path');

const PROFILES = path.join(__dirname,
  'central-system/backend/ml-pipeline/cameraCalibration/calibrationProfiles.json');
const CAPTURE_OPTIONS = path.join(__dirname,
  'phc-local-app/frontend/src/api/captureOptions.js');
const PRESETS = path.join(__dirname,
  'phc-local-app/backend/quality-gate-matlab/cameraPresets.json');
const CONTRACT = path.join(__dirname, 'docs/api-contracts.md');

let failures = 0;
let checks = 0;

function check(name, ok, detail) {
  checks += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
  if (!ok) failures += 1;
}

/** The ids in CAMERA_DEVICES, read from the source rather than imported (it is
 *  an ES module in a Vite app; this script is CommonJS and runs anywhere). */
function readOfferedIds() {
  const src = fs.readFileSync(CAPTURE_OPTIONS, 'utf8');
  const block = src.match(/export const CAMERA_DEVICES\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error('CAMERA_DEVICES not found in captureOptions.js');
  return [...block[1].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
}

function main() {
  console.log('verify_camera_vocabulary.js -- one camera id across four files\n');

  const profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const assoc = profiles.deviceAssociations || {};
  const families = Object.keys(profiles.families || {});
  const offered = readOfferedIds();

  console.log(`  PHC offers:  ${offered.join(', ')}`);
  console.log(`  associated:  ${Object.keys(assoc).join(', ')}\n`);

  // ── 1. Nothing offered is merely absent ──────────────────────────────────
  for (const id of offered) {
    check(`"${id}" is named in deviceAssociations`,
      Object.prototype.hasOwnProperty.call(assoc, id),
      `the PHC offers "${id}" but calibrationProfiles.json does not name it, so the `
      + 'camera cross-check silently never runs for it. Add it with the family it '
      + 'implies, or with null if it deliberately names no single family.');
  }

  // ── 2. Associations point at families that exist ─────────────────────────
  for (const [id, family] of Object.entries(assoc)) {
    if (family === null) continue; // deliberately not checkable
    check(`"${id}" -> "${family}" is a real family`,
      families.includes(family),
      `families in this file: ${families.join(', ')}`);
  }

  // ── 3. The cross-check is not dead ───────────────────────────────────────
  const checkable = offered.filter((id) => assoc[id]);
  check('at least one camera the PHC offers can actually be cross-checked',
    checkable.length > 0,
    'every offered id maps to null, so classifyCameraFamily.m can never compare '
    + 'anything and cases.camera_mismatch is NULL for every case');
  console.log(`          (checkable: ${checkable.join(', ') || 'none'})`);

  // ── 4. The contract points at the right file ─────────────────────────────
  const contract = fs.readFileSync(CONTRACT, 'utf8');
  const presetKeys = Object.keys(JSON.parse(fs.readFileSync(PRESETS, 'utf8')));
  // Any line that ties the two together, EXCEPT the changelog line recording
  // that this was wrong -- that line names both on purpose, and a check that
  // trips over its own correction is worse than no check.
  const offending = contract.split('\n').filter((line) =>
    line.includes('cameraDeviceId') && line.includes('cameraPresets.json')
    && !/\bis not\b|\bcorrected\b/.test(line));
  check('the contract does not source device ids from cameraPresets.json',
    offending.length === 0,
    `cameraPresets.json holds ${presetKeys.join(', ')} -- optics presets, not device ids.`
    + `\n          offending line: ${offending[0] || ''}`);
  check('cameraPresets.json indeed holds no device id',
    !presetKeys.some((k) => offered.includes(k)),
    'it now shares a key with CAMERA_DEVICES; if that is intended, this check and '
    + 'the contract wording both need revisiting');

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  return failures === 0 ? 0 : 1;
}

process.exit(main());
