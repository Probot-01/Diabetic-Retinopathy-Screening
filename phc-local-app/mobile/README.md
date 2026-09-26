# NetraSetu PHC: Mobile App (Expo)

The mobile version of the desktop PHC app (`phc-local-app/frontend`): the same screens and flow (login → register patient → capture → quality gate → capture metadata → local queue → report), built for a phone and wired to the **central backend**.

Design doc: `docs/system-design-v4.md` §4.4. API: `docs/api-contracts.md`.

## Run

```bash
npm install
cp .env.example .env        # set EXPO_PUBLIC_CENTRAL_API_URL to the central backend (port 5000)
npx expo start              # Expo Go, or `npx expo run:android` for a dev build
```

The central backend must be running (`central-system/backend`, `npm start`), with its database migrated (`npm run migrate`). The server address and PHC key can also be changed on the device: **☰ → Device Settings**.

Demo login (only when `EXPO_PUBLIC_TECHNICIANS` is unset): `technician / tech123`.

## How it works

| Step | What happens | Where |
|---|---|---|
| Register | Desktop's 4-section form; contact number required; duplicate check against this phone's patients (§10.3); collision-safe IDs (`docs/id-format-spec.md`) | `screens/RegistrationScreen.tsx`, `db/patients.ts` |
| Capture | **Import from gallery** (image from the fundus camera) or **Capture with fundus lens** (in-app camera: light, zoom, pupil guide, tagged `mobile_lens`) | `screens/CaptureScreen.tsx`, `screens/LensCameraScreen.tsx` |
| Quality gate | On-device port of the MATLAB gate (`quality-gate-matlab/qualityGateMain.m`), full resolution, same presets. Real scores only; if it cannot run it says so. "Best effort, ungradable" after 3 failed attempts (§10.2) | `lib/quality/` |
| Metadata & sync | Capture-metadata questionnaire (§9.6), then the case is saved in SQLite and queued | `components/CaptureMetadataForm.tsx`, `db/captures.ts` |
| Sync | Background: urgency tier then age; summary packet first, then image (chunked above 2 MB); capture ID = idempotency key; "synced" only when central accepts the image; backoff on transient errors, visible failure on rejections | `sync/syncManager.ts`, `api/central.ts` |
| Queue | Desktop's 5-stage pipeline per case, from real local and central state | `screens/QueueScreen.tsx` |
| Report | Local quality report always; full report from `GET /api/v1/phc/cases/:captureRef/report` only while online; the grade is marked unconfirmed until an ophthalmologist reviews it; shareable PDF slip | `screens/CaseReportScreen.tsx` |

There is no mock mode. A failure is shown or queued for retry, never replaced with a made-up result (§1.22).

## Layout

```
App.tsx            -> netrasetu/Root.tsx
netrasetu/
  config/          runtime config (env defaults + device overrides)
  theme/           desktop design tokens (cream / crimson / mono), light + high contrast
  i18n/            desktop's 7 locale files + mobile strings
  db/              expo-sqlite schema (design doc §4.3) and repositories
  lib/quality/     quality gate (pure TS; testable in Node)
  api/ sync/       central client and sync manager
  components/ screens/ navigation/
```

## Tests

| Command | What it checks | Needs |
|---|---|---|
| `npm test` | Unit tests of the real source: questionnaire/metadata contract mapping, sync priority, IDs, duplicate matching, pipeline stages, quality-gate edge cases | nothing |
| `npm run test:sync` | The real `syncManager` + SQLite layer + API client against central: happy path, chunked upload, phone offline, central down, lost response (idempotency), rejection, priority order, missing image | central running (`CENTRAL=http://localhost:5000`) |
| `npm run test:parity` | Mobile quality gate vs MATLAB `qualityGateMain.m` on 17 images × 2 presets, all decision branches | MATLAB + Image Processing Toolbox on PATH |
| `npm run type-check` | TypeScript | nothing |

Node tests run the app's TypeScript unchanged. `test/loader.mjs` transpiles it, and only the device APIs are swapped for Node stand-ins (`test/shims`: SQLite → `node:sqlite`, files → `fs`).

## Known limits

- The quality gate matches MATLAB on identical pixels (`npm run test:parity`). On the phone the image is decoded by the OS rather than MATLAB's `imread`, so a JPEG can differ by a few pixel values. This hasn't been measured on a device.
- `docs/id-format-spec.md`'s 4-character suffix can collide when hundreds of IDs are minted in the same millisecond (bulk import). This doesn't happen at capture pace. It's a spec-level issue shared with the desktop.
- Full-resolution analysis in JS takes several seconds for a 12 MP photo on a mid-range phone.
- Technician accounts are local to the device: central has no technician auth, and PHC devices authenticate with the site key.
- Not built yet: export-queue-to-drive (§4.2), camp relay mode (§9.5).
