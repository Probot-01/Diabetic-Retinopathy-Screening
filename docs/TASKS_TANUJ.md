# Tanuj's task list — integration finish line

From `docs/INTEGRATION_AUDIT.md` (2026-09-29), split so you and Saad can work in parallel. Full evidence for every
item is in that file; this is the action list. Saad's half is `docs/TASKS_SAAD.md` — don't duplicate his items.
**All frontend work, both web apps, is deliberately kept under you** — one person on frontend beats two.

Deployment (Vercel frontends, Render backends, where the models and DB live) is explicitly **out of scope until
after the video** — do not spend time on it now.

Rule thresholds: **no action needed, already correct.** `models/rule_thresholds_by_red_version.json` is already
wired into both grading engines (`gradingOrchestrator.js:1455` → `caseRuleOpts()` → `runCasePipeline.m`), keyed by
whichever red-lesion model version actually produced the counts, so v2's counts already get v2's thresholds
(9/8/11/7), not v1's. `CLAUDE.md`'s "don't change thresholds" rule is already being honoured — this is wiring, not a
threshold change. The file you might be thinking of, `rule_thresholds_red_v2.json`, is a **different, unused**
proposal (12/4/5, Saad's `recalibrateRuleGate2.py`) that nothing reads — leave it alone, no decision needed.

---

## P0 — do first

### 1. Get the model weights to Saad (and anyone else who needs to run this)
1.5 GB under `central-system/backend/ml-pipeline/models/` is git-ignored and only on your machine. A fresh clone —
Saad's, or a judge's — cannot grade a single case without it.
- Put the whole `models/` folder (all `.mat`, `.pt`, `.onnx` — the tree `docs/RELEASE.md` lists with checksums) somewhere shared: a Drive folder, or zip it as a GitHub Release asset.
- Send Saad the link today — everything below depends on him having a working stack.
- Optional but cheap: a one-line `scripts/fetch-models.js` that downloads and checks against `docs/RELEASE.md`'s SHA-256 list, so nobody has to be told twice. Skip it if you're short on time; the link is what matters.

### 2. Twilio — wire it in
You said you have credentials. Put them in `central-system/backend/.env` (git-ignored, never commit them):
```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+1XXXXXXXXXX        # the Twilio number, E.164 format
SMS_DRY_RUN=                     # blank or delete the line — 1 means "don't actually send"
```
Restart the central backend after saving. Verify: get a case referred (the demo already produces one — the
disagreement/override case), check `notifications.status` in Postgres is no longer `dry_run`, and check your phone.
**If this is a Twilio trial account**, it can only text numbers you've verified in the Twilio console first — verify
whatever number you'll use for the demo before you need it live.

### 3. Central Profile & Settings pages show invented data
`central-system/frontend/src/components/shared/CentralProfileDrawer.jsx` — a fabricated personal email
(`krrishgadekar@gmail.com`), phone number, "Level 4 · District Chief", a fake badge code, "7 PHCs / 64 villages / 18
reports", an assigned-PHC list with 5 sites the system doesn't have (only Kharadi and Wagholi exist), "Last login
today, 9:12 AM from Pune". `CentralSettingsPage.jsx`'s toggles (PIN/fingerprint, Wi-Fi-only sync, low-data mode,
"Last synced") are stored in `localStorage` and do nothing.
- Bind the profile card to `GET /api/v1/auth/me` (name, email, role — real fields, already served) and
  `GET /api/v1/admin/phcs` (the real PHC list) instead of the hardcoded strings.
- Either wire the settings toggles to something real (language and theme already work) or delete the ones that
  don't and are not coming back (PIN unlock, Wi-Fi-only, low-data mode aren't relevant to a web app anyway).
- Also delete `FieldOpsPage.jsx` (`central-system/frontend/src/components/screens/`) — it's dead code with its own
  fake PHC list, not routed anywhere, just clutter.

### 4. Decide + do: which P1 desktop features make the cut
You said "no single preference, but priority" — here's mine, in order. Pick where to stop:
1. ~~**Ungradable / "best effort" path**~~ — **DONE, commit `335fedd`, pushed.** Desktop now offers "PROCEED AS UNGRADABLE" after 3 failed retakes, queues with `bestEffort: true`, central shows a "⚠ BEST EFFORT — FAILED LOCAL QUALITY GATE" badge on the case.
2. ~~**Use-existing-patient / capture-other-eye**~~ — **DONE, commit `4d91ac1`, pushed.** "USE THIS PATIENT →" on a matched duplicate row and "CAPTURE OTHER EYE →" on every queue row both navigate straight to `/capture?patientId=...` for the existing patient — no new patient record. Verified live: consent guard, questionnaire-completeness guard, and the happy-path navigation all fire correctly.
3. **Hindi + Marathi i18n — PARTIALLY DONE, commit `<pending>`, corrected scope below.**
   - Done: the 23 keys genuinely missing from every non-English locale (`header.logout`, the whole `login.*` block, and a dead `capture.preview`→`capture.liveFeed` rename) are now filled for `hi` and `mr` and verified live (logged out, switched `i18nextLng` in each, screenshotted the login screen in both). Also fixed a real bug on the way: `LoginScreen.jsx:128` hardcoded the English literal `'PHC TECHNICIAN'` into the `{{role}}` interpolation, so that one string stayed English even once everything else on the page was Hindi/Marathi — now uses `t('login.roles.technician.title')`.
   - **Correction to this task's original premise: it is not true that "the strings are already behind `t()` in most places."** `PatientRegistrationForm.jsx` — patient-info section, address section, and the *entire* newer clinical questionnaire (known-diabetic, years-since-diagnosis, glycemic control, blood-pressure select, pregnancy, the 4 eye-symptom toggles, "none of these", the consent checkbox line, the duplicate-match banner) — has `useTranslation()` imported and `t` destructured but **never once called** (`grep -c '\bt('` on the file = 0). Every one of those strings is a hardcoded English literal. The `hi.json`/`mr.json` `registration`/`questionnaire` sections that already look complete belong to an **older, simpler version of this form** that this one superseded — they're not wired to what's on screen today.
   - Real remaining work here is a genuine i18n pass on ~60-80 strings plus two full translations plus a layout check (Devanagari text runs longer than English and this form has some fixed-width fields), not a "fill in the missing keys" job — did not start it tonight given the size and the risk of destabilizing a form just verified working (P1-2, above) this close to the deadline. Your call whether it's worth the remaining hours; if not, the demo can just run this screen in English.

Stop at whichever number you reach by tomorrow afternoon — 1 and 2 are done; 3's login-screen slice is done, the rest is optional and sized above.

### 5. Mobile: build something installable
No `eas.json` exists — right now the only way to show the mobile app is Expo Go over Wi-Fi, which broke once
already when your laptop's IP changed. If the mobile app is going in the video:
- Build an APK (`eas build --platform android --profile preview`, needs a free Expo account) so it isn't tied to your Wi-Fi during recording.
- Or, if that's too much for the time left, just make sure the laptop has a fixed IP or hostname for demo day and accept Expo Go as the delivery method.

---

## Also yours (quick, whenever there's a gap)

- **Continual learning wording** — per your call, it's DB-only for this round (doctor corrections stored, no retraining). Find the note in `docs/system-design-v4.md` (§16 Tier 2, item 9 / §17) and `docs/backend-plan-status.md` (Continual Learning row) that implies it's wired, and make sure they say "corrections captured and exportable; retraining is a manual, future-round step" — not "dormant" or "planned but unclear." One sentence each, so nobody reading the docs cold thinks it's broken.
- ~~**Simulink validation table formatting**~~ — **DONE, commit `ae701f8`, pushed.** Also found and fixed while verifying it live: the seeded `admin@demo.netrasetu.local` account couldn't log in (401) — its password had drifted from the documented demo value. Re-ran `npm run seed-users` (central-system/backend) to reset it; worth re-running once more right before recording as a cheap sanity check.
- **Open the PR** `integration` → `main` once you and Saad are both done and `demo-reset` + the runbook (`docs/DEMO_RUNBOOK.md`) pass clean. `origin/main` is currently 6 of your commits behind `integration`.
- **Decide before recording:** is the video showing the mobile app? (affects item 5's urgency) — and are you showing `/admin/phc-health` on camera? It currently shows a real "1 OF 4 CHECKS TRIPPED" banner because the seeded second PHC never contacts central. Correct, but red; `docs/DEMO.md` already flags this as a presenter's call.

## When you're both done

Run, in order: `node scripts/demo-reset.js` (must exit 0), then `docs/DEMO_RUNBOOK.md` scene by scene, twice. Log
anything that breaks in `docs/BUGLOG.md` (same format as the entries already there) and restart from `demo-reset`.
Then record.
