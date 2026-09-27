# Security — what is covered, and what is not

Prototype-stage floor for design doc §11.1, implemented from backend plan §A
(`docs/implementation-plan-backend-saad.md`). This is **not** a production
compliance claim. Last reviewed 2026-09-26.

## Covered

### Login and sessions (central backend)
| What | Where |
|---|---|
| `POST /api/v1/auth/login`: email + password checked with bcrypt against `users.password_hash`. The same 401 body is returned for an unknown email, a wrong password and a deactivated account, with equal bcrypt cost. Rate-limited to 10 failures per (IP, email) and 50 per IP per 15 minutes. | `routes/auth.js:92`, `:119` |
| The session is a JWT `{ userId, role, csrf }` (HS256, `JWT_SECRET` of at least 32 characters) in cookie `ns_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, **no `Domain`**. Lifetime `JWT_TTL_HOURS` (default 12, max 24). | `services/authTokens.js:23`, `services/authConfig.js:91` |
| The `Secure` flag comes from env: `COOKIE_SECURE=false` only for local plain-HTTP dev; the default is `true`. | `services/authConfig.js` |
| `GET /api/v1/auth/me`, `POST /api/v1/auth/logout` | `routes/auth.js:134`, `:157` |
| CSRF: every POST/PATCH/DELETE must send `X-CSRF-Token` equal to the token bound inside the signed session. | `middleware/requireAuth.js:89` |
| A deactivated account or a role change takes effect within 60 s, without waiting for the token to expire. | `middleware/requireAuth.js:38` |
| Passwords are hashed with bcrypt (cost 12) when seeded. | `scripts/seed-demo.js` |

### Role-based access, on every central route
`requireAuth` + `requireRole` are applied per route (`middleware/requireAuth.js:67`,
`middleware/requireRole.js:15`), and enforced when `AUTH_ENABLED=true`:

| Routes | Allowed |
|---|---|
| `/api/v1/ophthalmologist/*`, `POST /cases/:id/claim`, `POST /cases/:id/review` | ophthalmologist |
| `/api/v1/admin/*`, `PATCH /referrals/:id`, `GET /phc/:phcId/sync-status` | district_admin |
| `GET /cases/:id`, `/cases/:id/reviews`, `/cases/:id/report`, **`/media/*`** | either role |
| `GET /cases/:id/status` | either role, or a PHC key |
| `POST /cases`, `/cases/summary`, `/cases/:ref/chunks*` (ingestion); `GET /patients/search`, `/phc/cases/:ref/report`, `/phc/cases/:ref/gradcam` | PHC API key only (api-contracts.md "Who may call what") |
| `POST /auth/*`, `GET /health` | anyone |
| `POST /notifications/sms-status` | Twilio request signature |

`/media` is served by `routes/media.js`, not `express.static`. It applies auth and role checks, blocks path traversal and in-flight chunk fragments, and writes an access-log row. It serves **encrypted files only**: a plaintext file under `media/` gets `500 media_not_encrypted`, not its bytes. The 259 pre-encryption files were moved to `central-system/backend/media-archive/` (git-ignored, never served).

### PHC device keys
- Each site has its own key, sent as `X-PHC-Api-Key` and checked by `middleware/requirePhcApiKey.js:48`. Enforced when `PHC_AUTH_ENABLED=true`. An invalid key is always rejected.
- **Only the key's SHA-256 is stored** (`phc_sites.api_key_hash`, migration 0002). This deviates from the plan's plain `api_key` column on purpose: a database dump does not leak usable keys.
- Provisioning prints the key once: `npm run provision-phc-key` (`scripts/provisionPhcKey.js`), or `scripts/seed-demo.js` for the two demo sites.
- The PHC local backend sends the key on every call it makes to central (`phc-local-app/backend/services/syncManager.js`). The mobile app sends the same header from `EXPO_PUBLIC_PHC_API_KEY` or the value set in its Settings screen.

### Audit log
`access_log(user_id, action, resource_type, resource_id, timestamp)` (migration 0002) is written by `services/accessLog.js:23` with an explicit call in each handler:

| Action | Handler |
|---|---|
| `view_queue` | `routes/ophthalmologistQueue.js` |
| `view_case`, `claim_case`, `submit_review`, `view_report`, `view_reviews` | `routes/cases.js` |
| `view_media` (resource_id = the `/media/...` path) | `routes/media.js` |
| `view_dashboard`, `view_referrals`, `view_system_health`, `refresh_resource_model`, `refresh_simulink_validation` | `routes/adminDashboard.js` |
| `update_referral` | `routes/referrals.js` |
| `view_phc_sync_status` | `routes/phc.js` |

Limits:
- Rows need a user (`user_id NOT NULL`). Reads made by a PHC device with a key are attributed via `phc_sites.last_contact_at`, not written to `access_log`.
- While `AUTH_ENABLED=false`, nobody is logged in, so nothing is logged.
- A failed log write is reported in the server log but does not fail the request.

### Encryption at rest: stored case media (AES-256-GCM)
- `services/mediaCrypto.js` encrypts the original fundus image as it is ingested, upload chunks while they are in flight, and every file the grading pipeline writes into `media/cases/<id>/` (Grad-CAM, masks, report PDF) as soon as the pipeline finishes.
- The key is `MEDIA_ENCRYPTION_KEY` (32 bytes). `scripts/dev-up` generates it on first run.
- File format: magic `NSMEDIA1` | 12-byte IV | 16-byte tag | ciphertext.
- Files are decrypted in memory when served by `/media` and `/phc/cases/:ref/gradcam`.
- Existing plaintext media: `node scripts/encryptMedia.js` (skips files that are already encrypted and never touches model files).
- **Model weights are not encrypted.** They are not patient data, and nothing under `models/` goes through this code.

### Transport and deployment shape
- The browser only ever talks to **one origin**. Locally, the Vite dev server proxies `/api` and `/media` to the backend (`central-system/frontend/vite.config.js`); in deployment a reverse proxy does the same. So the session cookie is first-party on `fetch` and `<img>` alike.
- API responses carry relative `/media/...` URLs, never absolute backend URLs.
- Express `trust proxy` defaults to loopback (`TRUST_PROXY`), so `req.ip` and `req.secure` are correct behind the proxy and can't be spoofed by a direct client.
- CORS: explicit allow-list only. A bare `*` is refused at boot, because credentials are on.

## Not covered (be honest about these)
- **TLS comes from the reverse proxy in deployment** (nginx, Caddy, or the platform's load balancer terminating HTTPS). Local dev is plain HTTP on localhost, hence `COOKIE_SECURE=false` there. The backend *can* serve TLS itself (`TLS_KEY_PATH`/`TLS_CERT_PATH`, self-signed via `scripts/generateDevCert.js`), but that is a demo convenience, not the deployment plan.
- **Database encryption relies on the host disk**: BitLocker, LUKS, or the provider's "encryption at rest" setting. Postgres here has no transparent data encryption and no column-level encryption (e.g. `pgcrypto`). Patient rows (names, ages, phone numbers, questionnaires) are plaintext to anyone who can read the database or its disk. Disk encryption protects a stolen disk, not a compromised running server.
- **If `MEDIA_ENCRYPTION_KEY` is lost:** generate a new one and reset the demo. All demo data is public-dataset images and can be fully regenerated. There is no `demo-reset` command yet, so the reset is: `npm run db:down -- -v` (drops the database volume), empty `central-system/backend/media/`, set the new key, then `npm run dev:all` and re-capture. Keep the key in `.env` only (git-ignored) and in a password manager.
- **The media key sits in the same `.env` as everything else.** There is no KMS or HSM and no key rotation. Anyone who can read the server's `.env` can decrypt the media. Losing the key makes every encrypted file unreadable.
- **During grading, the image exists in plaintext** in the OS temp directory: Python and MATLAB read by path and cannot decrypt. It is deleted when grading or report generation ends, but a crash mid-grading can leave it behind.
- **Other files under the backend are not encrypted:** `explainability-outputs/`, `ml-pipeline` temp and session request files, and the log files.
- **No refresh tokens.** A session lasts `JWT_TTL_HOURS` and then the user logs in again. Logout clears the cookie, but a copied token stays valid until it expires (there is no server-side session store to revoke it). Deactivating the account does revoke it, within 60 s.
- **No MFA, and no password policy or reset flow.** Accounts are created by script.
- **The PHC local SQLite database is not encrypted this round** (`phc-local-app/backend/db/local.sqlite`, plain better-sqlite3), and neither are the captures stored next to it (`phc-local-app/backend/storage/`). The same goes for the mobile app's expo-sqlite database and stored photos. The phone does keep its secrets (pairing key, PC session token) in the OS keystore via expo-secure-store (`mobile/netrasetu/lib/secrets.ts`). On the PHC side, the protection is the device's own disk encryption and physical control.
- **The PHC local backend's technician auth is off by default** (`LOCAL_AUTH_ENABLED=false`) and its tokens travel as a Bearer header over plain HTTP on the LAN unless `LOCAL_TLS_*` is set.
- **The brute-force limiter is in memory**, per process. A restart resets it, and it isn't shared across instances.
