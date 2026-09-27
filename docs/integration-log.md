# Frontend ↔ backend integration log

One line per item. **Done** = in the tree and verified, with how it was verified.
**Planned** = agreed and not started. **Won't** = decided against, with the reason.

Scope: the seams between the two web front-ends and the two backends — central
system (`:5000`, Postgres) and PHC local app (`:4000`, SQLite). Source of truth
for shapes is `docs/api-contracts.md`; this file records work, not contracts.

---

## Done

### Backend data the UI was throwing away
- **Tier reason on Case Detail** — `tierReason` (migration 0015) was stored and served but never shown; five different situations produce a "B" and they ask different things of the reviewer. Now the tier badge's tooltip. *Verified: rendered against real cases.*
- **Fovea-unreliable badge on Case Detail** — when the fovea gate fires, the quadrant-based severe-NPDR criteria were skipped and the grade may be an under-call; that was only said inside the evidence prose. Now a header badge. *Verified: rendered against real cases.*
- **Duplicate-patient check wired in PHC registration** — `searchPatients({name, age, phone})` on the local API client, debounced, shown as an advisory card naming what matched. Advisory, never blocking: a real duplicate and a common name look identical from here. *Verified: against the local SQLite backend.*
- **Full engine provenance on Case Detail** (`ProvenancePanel.jsx`) — the backend has stored all seven entries since migration 0019 and served them since 2026-09-26; the screen rendered one (quality gate) and so stood in for the other six. A case graded on a non-primary engine looked exactly like one graded on the primary. *Verified: `verify_provenance_ui.js`, 25/25 against a real graded case.*
- **`modelVersion` on Case Detail** — in the contract and in the response since the start, rendered by nothing; a reviewer could not tell which classifier build graded the case in front of them. *Verified: same harness.*
- **Capture provenance on Case Detail** — `sourceFormat`, `dicomDeviceModel`, `cameraFamilyDetected` shown next to the technician's reported device, deliberately not reconciled, because a disagreement between them is the point. *Verified: same harness, real values `image` / `null` / `desktop_tabletop`.*

### Camera cross-check (migration 0021)
- **The reported-vs-detected camera check now reaches a reader.** It has run on every case since Task 6.3 and surfaced only through a tier floor, and a floor writes `tierReason` only when the tier would otherwise be A *and* the camera/site is still on probation. *Verified on a real case: `cameraMismatch: true` with a `tierReason` that never mentions the camera, because the conformal set had already put it in Tier B.*
- **Stored three-state, not two.** `true` disagreed / `false` agreed / **`null` the check could not run**. `classifyCameraFamily.m` returns `mismatch = false` both when the two agree and when the reported device has no known family, and storing that as `false` would record that a camera was verified against its own image when nobody could look.
- **`runCasePipeline.m` now returns `cameraExpectedFamily`** — the other half of the comparison, and the thing that makes "checked" distinguishable from "not checkable". *Verified: `checkcode` clean, real case round-tripped through a restarted MATLAB session.*
- **`cameraExpectedFamily` is served and shown**, so the mismatch is inspectable rather than asserted: *"The reported device implies a portable handheld; the image was read as a desktop tabletop."*
- **No tier behaviour changed.** The floor still keys off the raw boolean, so a case that was Tier A yesterday is Tier A today; this adds a record, not a new clinical rule.
- **`generic_fundus` is now an explicit `null` association.** The PHC offers it and the central table did not name it, so the cross-check silently never ran for it — indistinguishable from a camera that was checked and agreed. Listing it records the decision; the omission looked identical.
- **`verify_camera_vocabulary.js`** — one camera id crosses four files and nothing checked they agreed. Fails if the PHC starts offering an id the central table does not name, if an association points at a non-existent family, or if the cross-check goes dead entirely. **11/11.**

### The clinical-rationale PDF carries its own provenance
- **`tierReason` now actually prints.** `generateReport.m` has rendered a "Why: …" line since it was written and `caseReport.js` never sent the field — so every PDF said "Tier B - assisted review recommended" and never which of the five situations produced that B. Nothing failed; the line just never appeared. *Verified: real PDF now reads "Why: prediction set {3} is entirely referable — assisted review…".*
- **New "How this result was produced" section** — classifier model build plus a table of which engine produced each output, with a red caveat line when any of them was a non-primary engine. The report leaves the system and goes into a patient record; whoever reads it later will not have the reviewer console open.
- **Both renderers got it.** `generateReport.m` (Report Generator) and `generateReportFigures.m` (core MATLAB, used when that toolbox is absent) are supposed to produce the same report; a machine without the toolbox would otherwise have silently emitted a PDF missing a section. *Verified: both rendered against the same real case — 2-page and 3-page PDFs, same content.*
- **Provenance is flattened in Node, not MATLAB.** Uniform `{label, engine, fallback, detail}` rows so `jsondecode` yields a struct array to loop over, and the contract's shape stays in `services/engineProvenance.js` instead of being re-derived in a `.m` file. An unrecorded output is omitted; a case with nothing recorded prints one honest line saying so.
- **`verify_report_provenance.js`** — **11/11.** Checks that no renderer reads a field nobody sends, and that the two renderers read the *same* fields. *Confirmed it catches the real bug: deleting the `tierReason` line makes it fail with exactly that field named.*

### Contract and schema hygiene
- **Corrected a two-place contract error:** `cameraDeviceId` was documented as "one of the keys in `cameraPresets.json`". That file holds the PHC gate's optics presets (`default`, `mobile_lens`) and has never held device ids. Now points at `captureOptions.js` `CAMERA_DEVICES`, with the cross-check's own vocabulary called out separately.
- **Documented `sourceFormat`, `dicomDeviceModel`, `cameraFamilyDetected`** — served since migration 0016 / Task 6.3 and never written down in `api-contracts.md`, so no front-end could rely on them. Now specified, with their enums and their null rules.
- **Recorded that a camera *family* is not a device id** — these must not be string-compared with `cameraDeviceReported`; the backend already states a disagreement that matters in `tierReason`.
- **Migrations 0019 and 0020 applied to the local Postgres** — they arrived with the integration pull and were never run, so `grading_results.engine_provenance` did not exist and every read of it would have failed. Both are additive `ADD COLUMN IF NOT EXISTS`. *Verified: `npm run migrate`, 18 tables, then a real case graded end to end.*
- **Removed the stale "no UI shows it yet" note** from the 2026-09-26 changelog entry.

### Quality gate
- **Diagnosed the PHC quality-gate divergence** — `qualityGateFallback.js` used sharp's `.greyscale()` (libvips, through linear light) where MATLAB's `rgb2gray` applies BT.601 weights directly to gamma-encoded bytes; every score starts from that array, so one difference moved all of them. Fixed the grayscale conversion.
- **Did not re-enable the JS fallback** — the team had already switched it off to throw rather than return a fabricated `{status:'retake', reason:'MATLAB_UNAVAILABLE'}`, which is the better answer. A few grey levels do not explain a 29× gap in `occlusionScore`, so the fix was never confirmed to be the only cause. The measured divergences are recorded at the disable site.
- **`verify_quality_gate_parity.js` reports SKIP, not FAIL, on a deliberate switch-off** — a red line there should mean the two implementations disagree. The check stays, so reviving the fallback cannot quietly bypass it.

### Test machinery
- **`verify_provenance_ui.js`** — 30/30. Renders `ProvenancePanel` with `react-dom/server` against a real case read from Postgres, no fixture and no new front-end dependency. Asserts every `detail` prints verbatim, a null entry claims nothing, a pre-0019 case names no engine at all, `fallback: true` is visible twice, and — the load-bearing one — that a compiled-executable entry needs no code change here.

---

## Planned

- **`explainabilityValidation.py` hardcodes `CAM_SIZE = 384`** — should read the model's own input size.
- **`verifyPhase4.m`: 2 red checks** — the harness feeds classifier preprocessing to the vessel model; needs `benGrahamCrop` to return its crop box.
- **Device Encryption (§A.15)** — a deployment action, needs admin on the target machine.

## Blocked / out of scope

- **`verify_mobile_quality_gate_parity.mjs` does not run** — `ERR_MODULE_NOT_FOUND` for `fast-png` in `phc-local-app/mobile/node_modules`; looks like a missing `npm install` there. The mobile app is owned elsewhere; flagged, not touched.

---

## Standing decisions that shaped the above

- **Never fabricate a result in place of a failure** (design §1.22). A failed request errors or genuinely queues; `null` renders as "not recorded", with the reason, and never as a zero or a guess from the current configuration.
- **`detail` is printed verbatim and never parsed.** This is what lets `engine: "matlab"` keep covering both `matlab -batch` and the compiled executable.
- **When the pipeline moves to the MATLAB Compiler, do not add a `"matlab-compiled"` engine value.** The enum is fixed in `api-contracts.md`; the compiled path already reports itself through `detail`, and `verify_provenance_ui.js` check 5 fails if that stops being true.
- **Two implementations of one clinical decision drift.** It has happened three times here. Prefer deleting the second implementation over making them agree.
