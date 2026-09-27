# Desktop ↔ phone offline sync: protocol

**Added 2026-09-24.** The PHC desktop (its local backend, `phc-local-app/backend`) and the PHC's phones (the Expo app, `phc-local-app/mobile`) keep one shared copy of the PHC's work, so either can carry on when the other goes down. The case this is built for is a power cut: the PC and usually the Wi-Fi router go off, and the technician finishes on the phone.

## The idea in one paragraph

Nothing can be transferred *at* the moment the power fails, so the data must already be on the phone. While both are on, they replicate continuously over the PHC LAN (or the phone's hotspot) every sync pass, about every 15 s and right after each save. During the outage the phone works alone: registration, its own quality gate, local queue, and upload to central over mobile data when there's signal. When power returns they exchange everything since their last exchange and converge. With no network at all, an encrypted bundle file carries the same data by USB cable or SD card.

## Roles

| | PHC PC (hub) | Phone (client) |
|---|---|---|
| Serves | `/peer/*` on the local backend (port 4000) | nothing: phones are clients (Expo can't host a server) |
| Stores | SQLite (`local.sqlite`), `storage/` | expo-sqlite, `documents/captures/` |
| Identity | `kv.device_id` = `pc-…` | `ph-…`, assigned at pairing |

## Pairing (once per phone)

On the PC (in `phc-local-app/backend`):
```
npm run peer -- pair "Asha's phone"
```
This prints a QR code containing `{ kind: 'netrasetu-pair', v: 1, deviceId, key, pcDeviceId, urls, phcCode, phcName }`. `key` is a fresh 256-bit AES key known only to that PC and that phone. `urls` lists the PC's LAN addresses; the phone tries each one and remembers the one that answers. On the phone: **Menu → PHC PC link / pairing → Scan pairing code**. The phone confirms with a sealed `hello` before it keeps the pairing.

`POST /peer/pair` does the same over HTTP, but only from the PC itself (localhost) or for a logged-in PHC admin. It is never open to an anonymous LAN client, even while `LOCAL_AUTH_ENABLED=false`.

Lost phone: `npm run peer -- revoke <deviceId>` locks it out immediately, or **DEVICES** in the PHC desktop app (*added 2026-09-27*).

### Seeing and revoking devices from the PHC app

`GET /peer/devices` (technician) lists every device ever paired with this PC as
`[{ deviceId, name, createdAt, lastSeenAt, revokedAt }]`, and
`POST /peer/devices/:id/revoke` (**PHC admin only**) cuts one off, answering `204`, or `404 device_not_found` for an id that is unknown *or already revoked*.

Both endpoints existed from the start and no screen called either, so in practice a lost phone stayed paired until someone with a terminal ran the CLI — which is not a thing that happens in a clinic. The **DEVICES** screen in the PHC desktop app now calls them.

Two properties that screen relies on, and that are the backend's to keep:
- **A revoked device stays in the list** with `revokedAt` set. The record that a phone once held a key is what an incident review needs; deleting the row would be tidier and less honest.
- **The admin check is the backend's.** The screen hides the button for a technician as a convenience. Measured: anonymous `401`, technician `200` on the list and `403 forbidden` on revoke, admin `204`.

## The sealed channel

Every `/peer/*` call after pairing is a POST whose body is an **AES-256-GCM envelope** `{ v: 1, iv, ct, tag }` (base64):

| Protection | How |
|---|---|
| Confidentiality and integrity | AES-256-GCM, fresh random 96-bit IV per message. Any modified byte or a wrong key fails to open. |
| Binding to context | AAD = `req\|{deviceId}\|{METHOD}\|{path}\|{ts}\|{nonce}`, so a body sealed for one endpoint can't be replayed against another |
| Replay | `x-netra-nonce` is single-use (remembered for 30 min). `x-netra-ts` must be within ±15 min of the PC's clock; the phone learns the offset from `hello`, which is exempt from the clock check. |
| Response binding | Responses are sealed with AAD `res\|{deviceId}\|{path}\|{nonce}`, tied to the request's nonce |
| Who | Headers `x-netra-device`, `x-netra-ts`, `x-netra-nonce`. An unknown or revoked device gets `401 peer_unknown`. |

**Why not only TLS:** a phone doesn't trust a self-signed certificate, and there's no CA-signed certificate for a PC on a PHC LAN. The envelope also protects bundle files, which TLS never covers. The local backend supports TLS too (below).

Implementations: `phc-local-app/backend/services/peerCrypto.js` (node:crypto) and `phc-local-app/mobile/netrasetu/peer/peerCrypto.ts` (@noble/ciphers). The interop is tested in both directions.

## Endpoints (all sealed)

| Endpoint | Body → Response |
|---|---|
| `POST /peer/hello` | `{}` → `{ serverTime, pcDeviceId, phcCode, phcName, authRequired }` |
| `POST /peer/login` | `{ username, password }` → `{ token, expiresAt, user }`. The technician's password never crosses the LAN in the clear. |
| `POST /peer/pull` | `{ cursor, token }` → `{ records, cursor, more }` |
| `POST /peer/push` | `{ records, token }` → `{ applied, skipped }` |
| `POST /peer/image/get` | `{ captureId, token }` → `{ bytesB64, sha256, ext }` |
| `POST /peer/image/put` | `{ captureId, bytesB64, sha256, ext, token }` → `{ stored }` (checksum verified) |
| `POST /peer/bundle` | an export bundle, applied like a push (desktop upload of a hand-carried file) |

`token` is the technician session from `/peer/login`. It's required when `LOCAL_AUTH_ENABLED=true`.

## Change feed

Both databases have a `change_log` table filled by triggers on insert/update of `patients`, `captures`, `questionnaire_responses`, `capture_metadata_responses` and `sync_queue`. A pull returns current rows for everything after the requester's cursor, oldest first, in pages of 300.

**No echo:** while a peer's records are applied, `sync_ctx.origin` holds that peer's device ID, the triggers tag the log rows with it, and the feed excludes a requester's own origin.

**Wire records** are `{ kind, data }` with `kind` ∈ `patient | capture | questionnaire | metadata | syncState` and camelCase fields (see `toWire` in both `peerSync.js` and `replicate.ts`).

A capture travels only after it has a verdict and is queued (or failed the gate, as evidence behind the retake count). An in-progress capture isn't a case yet. The handover point is the last *completed* step.

## Merge rules (identical on both sides)

| Record | Rule |
|---|---|
| patient | Last writer wins on `updatedAt`; ties go to the larger origin ID. `consentGivenAt` is never overwritten once set. |
| capture, questionnaire, metadata | Immutable once written: insert if absent, never overwrite |
| syncState | Monotonic: `pending < summary_sent < synced`, `awaiting_image < processing < graded/error`; `centralCaseId` fills in once known. A stale `pending` never undoes `synced`. |

This is safe because every ID is minted with the collision-safe scheme (`docs/id-format-spec.md`): two devices never create the same ID for different things.

**Images:** the sender puts the image first (checksummed); a capture record whose image hasn't arrived is refused (`image_missing`) and the whole batch rolls back. The receiver fetches an image before applying the capture record.

## Who uploads a case to central

The device that took the capture (`sync_queue.owner_device`). The other device takes over only when the owner has been silent longer than `PEER_TAKEOVER_MS` (default 6 h): a PC that is still dark, or a phone that ran out of battery. A double upload would be harmless, since central deduplicates on the capture ID; the rule only avoids spending thin bandwidth twice. Whoever uploads, the other learns `synced` plus the central case ID at the next exchange.

## No network at all: bundles

A bundle is a JSON file `{ kind: 'netrasetu-bundle', v: 1, fromDevice, toDevice, createdAt, envelope }`. The envelope seals `{ records, images }` with the pair's key, and the AAD binds sender, recipient and time. A lost USB stick exposes nothing, and an edited file won't open.

| Direction | Make | Apply |
|---|---|---|
| phone → PC | Menu → Export bundle (Android share sheet) | `npm run peer -- import <file>` or `POST /peer/bundle` |
| PC → phone | `npm run peer -- export <deviceId> <file>` | Menu → Import bundle from PC |

## Authentication and transport around it

- **Technician accounts** live on the PC: `npm run technician -- add <username> "<Full Name>" [--admin]`. Passwords are stored as scrypt hashes and session tokens as SHA-256.
- **The phone** logs in through `/peer/login` and keeps a PBKDF2-SHA256 verifier, so the same technician can log in during the outage. The first login on a phone needs the PC.
- **Enforcement:** `LOCAL_AUTH_ENABLED=true` in `.env` makes every local-backend patient route require a session. It defaults to false (like central's `AUTH_ENABLED`) until the desktop web app sends tokens. `/peer/*` is always device-authenticated by the key.
- **TLS on the local backend:** set `LOCAL_TLS_KEY_PATH` and `LOCAL_TLS_CERT_PATH` to serve HTTPS at TLS 1.2+.

## Tests

| Where | What |
|---|---|
| `phc-local-app/backend`: `npm test` | auth, the sealed channel's rejections (wrong key, tampering, replay, clock skew, cross-endpoint replay, revoked device), merge rules, bundles, TLS |
| `phc-local-app/mobile`: `npm run test:peer` | the phone's real code against a real local-backend process, including a simulated power cut (the process is killed and restarted) |
