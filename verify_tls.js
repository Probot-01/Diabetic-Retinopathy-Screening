#!/usr/bin/env node
'use strict';

/**
 * verify_tls.js -- design doc §11.1 "TLS 1.2+ on every backend", checked on
 * both backends:
 *   central  (central-system/backend/server.js, TLS_KEY_PATH / TLS_CERT_PATH)
 *   PHC local (phc-local-app/backend/server.js, LOCAL_TLS_KEY_PATH / LOCAL_TLS_CERT_PATH)
 *
 * For each: HTTPS answers /health at TLS 1.2 or 1.3; a TLS 1.0/1.1 handshake is
 * refused; plain HTTP to the TLS port is refused. Uses a throwaway self-signed
 * certificate (openssl from PATH or Git for Windows) and random ports; nothing
 * is written into the repo.
 *
 *   node verify_tls.js
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const https = require('https');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const OPENSSL = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', '/usr/bin/openssl'].find((c) => {
  try { execFileSync(c, ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
});

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function handshake(port, opts) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ...opts }, () => {
      const v = sock.getProtocol(); sock.end(); resolve(v);
    });
    sock.on('error', () => resolve(null));
  });
}

function httpsHealth(port) {
  return new Promise((resolve) => {
    https.get({ host: '127.0.0.1', port, path: '/health', rejectUnauthorized: false }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', (e) => resolve({ status: 0, body: e.message }));
  });
}

async function checkServer(name, script, env) {
  console.log(`\n--- ${name} ---`);
  const port = await freePort();
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      up = (await handshake(port, {})) !== null;
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    check(`${name} is listening with TLS`, up, log.slice(-400));
    if (!up) return;
    const v = await handshake(port, {});
    check(`${name}: default handshake negotiates TLS 1.2+ (${v})`, /TLSv1\.[23]/.test(v));
    check(`${name}: TLS 1.2 accepted`, (await handshake(port, { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' })) === 'TLSv1.2');
    check(`${name}: TLS 1.0/1.1 refused`, (await handshake(port, { minVersion: 'TLSv1', maxVersion: 'TLSv1.1' })) === null);
    const h = await httpsHealth(port);
    check(`${name}: GET /health over HTTPS -> 200`, h.status === 200, JSON.stringify(h));
    const plain = await fetch(`http://127.0.0.1:${port}/health`).then(() => 'answered', () => 'refused');
    check(`${name}: plain HTTP on the TLS port refused`, plain === 'refused');
  } finally {
    child.kill();
  }
}

(async () => {
  console.log('--- TLS on every backend (design doc §11.1) ---');
  if (!OPENSSL) {
    console.log('  SKIP  no openssl found (PATH or Git for Windows)');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-verify-'));
  const key = path.join(dir, 'key.pem'); const cert = path.join(dir, 'cert.pem');
  execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-keyout', key, '-out', cert,
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });

  await checkServer('central backend', path.join(ROOT, 'central-system/backend/server.js'), {
    TLS_KEY_PATH: key, TLS_CERT_PATH: cert,
    // Only the TLS listener is under test: keep the ML supervisors from launching MATLAB.
    MATLAB_SUPERVISOR_ENABLED: 'false', SEG_WORKER_SUPERVISOR_ENABLED: 'false',
  });
  await checkServer('PHC local backend', path.join(ROOT, 'phc-local-app/backend/server.js'), {
    LOCAL_TLS_KEY_PATH: key, LOCAL_TLS_CERT_PATH: cert, SYNC_DISABLED: '1',
    LOCAL_DB_PATH: path.join(dir, 'local.sqlite'), LOCAL_STORAGE_DIR: path.join(dir, 'storage'),
  });

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  process.exitCode = failures ? 1 : 0;
})();
