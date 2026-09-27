#!/usr/bin/env node
'use strict';

/**
 * verify_peer_device_admin.js
 *
 * A paired phone holds a key that reads every patient record on the PHC PC, so
 * who may list those pairings and who may revoke one is a security boundary,
 * not a UI preference. The PHC desktop app's DEVICES screen hides the revoke
 * button for a non-admin; that is a convenience, and this checks the thing
 * that actually enforces it.
 *
 * Runs against a LIVE PHC backend started with LOCAL_AUTH_ENABLED=true, with
 * two throwaway accounts it creates and deactivates itself:
 *
 *   anonymous   GET  /peer/devices            -> 401
 *   technician  GET  /peer/devices            -> 200
 *   technician  POST /peer/devices/:id/revoke -> 403   <- the boundary
 *   admin       POST /peer/devices/:id/revoke -> 204
 *   admin       POST (same id again)          -> 404   not silently "ok"
 *   after revoke, the device is STILL LISTED with revokedAt set
 *
 * That last one is not a detail. If a revoked device vanished from the list,
 * the screen could not show that a phone once had access, and an incident
 * review would have nothing to read.
 *
 *   node verify_peer_device_admin.js [--base http://localhost:4000]
 *
 * SKIPs (exit 0) when no backend answers, or when it answers with auth off --
 * the matrix is meaningless without enforcement, and a pass there would be a
 * false reassurance.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return (i > -1 && process.argv[i + 1]) || 'http://localhost:4000';
})();
const BACKEND = path.join(__dirname, 'phc-local-app', 'backend');
// FIXED usernames, reused every run. A timestamped name would leave a new
// pair of rows behind each time, and they cannot be deleted afterwards:
// sessions and the access log reference them, and dropping an audit trail to
// tidy up after a test is the wrong trade. Two dormant rows forever is the
// better one.
const SUFFIX = 'verify';
const ADMIN = { u: 'zz_verify_admin', p: 'Verify-Admin-Pw-1!' };
const TECH = { u: 'zz_verify_tech', p: 'Verify-Tech-Pw-1!' };

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
  if (!ok) failures += 1;
}

const tech = (...args) =>
  execFileSync('node', [path.join(BACKEND, 'scripts', 'technician.js'), ...args],
    { cwd: BACKEND, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function call(method, urlPath, token) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let body = null;
  try { body = await res.json(); } catch { /* 204 has none */ }
  return { status: res.status, body };
}

/** Create the throwaway account, or reset and reactivate an existing one. */
function ensureAccount(cred, fullName, isAdmin) {
  try {
    const args = ['add', cred.u, fullName];
    if (isAdmin) args.push('--admin');
    tech(...args, '--password', cred.p);
  } catch {
    // Already there from a previous run: reset restores the password and sets
    // is_active = 1, so a deactivated leftover comes back for this run only.
    tech('reset', cred.u, '--password', cred.p);
  }
}

async function login(cred) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cred.u, password: cred.p }),
  });
  if (!res.ok) throw new Error(`login ${cred.u} failed: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log('verify_peer_device_admin.js -- who may see and revoke a paired phone\n');

  // Is anything there, and is auth actually on?
  let probe;
  try {
    probe = await call('GET', '/peer/devices');
  } catch (e) {
    console.log(`SKIP: no PHC backend at ${BASE} (${e.message}).`);
    console.log('      Start one with LOCAL_AUTH_ENABLED=true, then re-run.');
    return 0;
  }
  if (probe.status !== 401) {
    console.log(`SKIP: ${BASE} answered an anonymous /peer/devices with HTTP ${probe.status}, `
      + 'not 401, so LOCAL_AUTH_ENABLED is off.');
    console.log('      The whole point of this check is enforcement; passing it with auth '
      + 'disabled would be a false reassurance. Restart with LOCAL_AUTH_ENABLED=true.');
    return 0;
  }
  check('anonymous cannot list paired devices', probe.status === 401);

  let created = false;
  try {
    // add on the first run, reset on every later one (which also reactivates
    // the account this script deactivated when it last finished). The role is
    // fixed at creation and reset does not touch it, so the admin stays an
    // admin -- which is exactly what the matrix below depends on.
    ensureAccount(ADMIN, 'Verify Admin', true);
    ensureAccount(TECH, 'Verify Technician', false);
    created = true;

    const adminSession = await login(ADMIN);
    const techSession = await login(TECH);
    check('the login response carries the role the server issued',
      adminSession.user?.role === 'phc_admin' && techSession.user?.role === 'technician',
      `admin: ${adminSession.user?.role}, technician: ${techSession.user?.role}. `
      + 'The PHC app reads this to decide whether to offer an admin-only action; '
      + 'it used to hardcode "technician" and throw the real value away.');

    // A device to act on, paired as the admin (pairing is admin-or-localhost).
    const pairRes = await fetch(`${BASE}/peer/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSession.token}` },
      body: JSON.stringify({ name: `verify-${SUFFIX}` }),
    });
    if (!pairRes.ok) throw new Error(`pair failed: HTTP ${pairRes.status}`);
    const deviceId = (await pairRes.json()).pairing.deviceId;

    const techList = await call('GET', '/peer/devices', techSession.token);
    check('a technician CAN list paired devices', techList.status === 200);

    const techRevoke = await call('POST', `/peer/devices/${deviceId}/revoke`, techSession.token);
    check('a technician CANNOT revoke one', techRevoke.status === 403,
      `got HTTP ${techRevoke.status}. The desktop app hides the button for a `
      + 'technician, but this is the control that matters.');

    const adminRevoke = await call('POST', `/peer/devices/${deviceId}/revoke`, adminSession.token);
    check('an admin CAN revoke one', adminRevoke.status === 204,
      `got HTTP ${adminRevoke.status}`);

    const again = await call('POST', `/peer/devices/${deviceId}/revoke`, adminSession.token);
    check('revoking an already-revoked device is 404, not a silent success',
      again.status === 404 && again.body?.error === 'device_not_found',
      `got HTTP ${again.status} ${JSON.stringify(again.body)}`);

    const after = await call('GET', '/peer/devices', adminSession.token);
    const row = (after.body || []).find((d) => d.deviceId === deviceId);
    check('a revoked device is STILL LISTED, with revokedAt set', !!row && !!row.revokedAt,
      row ? 'the row is there but revokedAt is empty'
        : 'the row disappeared -- the record that this phone once held a key is gone, '
          + 'and the screen can no longer show it');
  } catch (e) {
    check('the check ran to completion', false, e.message);
  } finally {
    if (created) {
      // Deactivated, not deleted: sessions and the access log reference these
      // rows, and dropping an audit trail to tidy up a test is the wrong trade.
      for (const c of [ADMIN, TECH]) {
        try { tech('deactivate', c.u); } catch { /* best effort */ }
      }
      console.log(`\n  (throwaway accounts ${ADMIN.u} / ${TECH.u} deactivated)`);
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => { console.error(`crashed: ${e.stack || e.message}`); process.exit(1); });
