'use strict';

/**
 * generateDevCert.js -- a self-signed TLS certificate for the demo (backend
 * plan §A.14).
 *
 *   node scripts/generateDevCert.js
 *
 * Writes certs/dev-key.pem and certs/dev-cert.pem at the repo root (git-
 * ignored), valid for localhost and 127.0.0.1 for 365 days, then prints the
 * .env lines that switch the central backend to HTTPS:
 *
 *   TLS_KEY_PATH=certs/dev-key.pem      (resolved from the repo root)
 *   TLS_CERT_PATH=certs/dev-cert.pem
 *
 * Needs `openssl` on PATH (Git for Windows ships one).
 *
 * SELF-SIGNED MEANS UNTRUSTED. Browsers show a warning until the certificate
 * is trusted, and Node clients (the PHC sync manager) reject it unless told
 * to trust it: start the PHC backend with NODE_EXTRA_CA_CERTS pointing at
 * certs/dev-cert.pem. Never disable certificate checking to get around this.
 * A real deployment uses a certificate from a real CA (or a reverse proxy
 * that has one); this is a demo-environment floor, as the plan states.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'certs');
const key = path.join(dir, 'dev-key.pem');
const cert = path.join(dir, 'dev-cert.pem');

fs.mkdirSync(dir, { recursive: true });
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365',
    '-keyout', key, '-out', cert,
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (err) {
  console.error('[generateDevCert] openssl failed:', (err.stderr || err.message).toString());
  process.exit(1);
}

console.log(`[generateDevCert] wrote ${path.relative(root, key)} and ${path.relative(root, cert)}`);
console.log('Add to .env (central backend):');
console.log(`  TLS_KEY_PATH=${key.replace(/\\/g, '/')}`);
console.log(`  TLS_CERT_PATH=${cert.replace(/\\/g, '/')}`);
console.log('And for the PHC backend, so its sync manager trusts it:');
console.log(`  NODE_EXTRA_CA_CERTS=${cert.replace(/\\/g, '/')}   and   CENTRAL_API_URL=https://localhost:5000`);
