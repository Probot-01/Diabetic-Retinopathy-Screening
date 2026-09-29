# Tanuj — final checklist

**2026-09-29, deadline tomorrow night.** Everything below is genuinely yours — either it needs your own
credentials/decisions, or it needs a real phone in your hand. Everything else in `TASKS_TANUJ.md` is done and
pushed to `origin/integration`; this file doesn't repeat it. The full evidence trail for every claim below is in
the commits on `integration` and in `docs/STALE_CLAIMS_AUDIT.md`.

The ppt is done, so nothing here is about slides — this is purely "does the system work" from here on, per your
instruction. `system-design-v4.md` is accepted as behind current reality where the two disagree (see the audit
doc for exactly where); nothing in this checklist is blocked on reconciling that doc.

---

## 1. Twilio — the one thing only you can enter

You said you have credentials. Exact steps (already in `TASKS_TANUJ.md` §P0-2, repeated here since it's the
top item):

```
central-system/backend/.env
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+1XXXXXXXXXX
SMS_DRY_RUN=          <- blank or delete this line; 1 means "don't actually send"
```

Restart the central backend after saving. Verify: get a case referred (the demo already produces one — the
disagreement/override case), check `notifications.status` in Postgres is no longer `dry_run`, check your phone.
**Trial account:** it can only text numbers you've verified in the Twilio console first — do that for whatever
number is used in the demo, before you need it live, not during recording.

## 2. Mobile — physical device, not just the sync logic

**What's already proven, so this isn't starting from zero:** phone↔desktop sync (continuous replication,
power-cut resilience, USB bundle fallback — 12/12), pairing/revoke/TLS (24/24), and phone↔central direct upload
(happy path, chunked upload, offline queueing, idempotent resend — 9/9) were all re-run today against this
live stack with zero code fixes needed on the sync side itself. The mobile capture pipeline (quality gate on a
real image, camera-lens ingest) was also verified end to end with a real MATLAB grading call. **What's left is
specifically the things an automated test cannot check:**

- Actually holding a phone, opening the app in Expo Go, granting camera/storage permissions, and seeing the UI
  render correctly on real hardware and a real screen size.
- The camera-lens attachment / capture ergonomics in person, if that's part of the demo.
- Confirming your laptop's current LAN address is what the phone expects (it changed once before, per
  `docs/DEMO.md`) — check this same-day, not the night before.
- Anything in `docs/INTEGRATION_AUDIT.md` §8's mobile checklist you haven't personally walked yet.

Build an installable APK first if the demo needs the app off Wi-Fi (`eas build --platform android --profile
preview`, needs a free Expo account) — otherwise a fixed IP/hostname plus Expo Go is fine and cheaper right now.

## 3. Model weights to Saad — reconsider whether you still need to

Originally P0-1 in `TASKS_TANUJ.md`. **Given today's reassignment** ("since Saad does not have the model
weights, all integration and tests related to those must run here"), everything actually left on
`TASKS_SAAD.md` no longer touches inference at all:

- P0-1 (PHC auth default) — a config flip + `demo-reset` change, no weights.
- P1-5 (`npm audit` + retest) — dependency vulnerabilities, retested via the JS quality-gate fallback path, no
  classifier weights involved.
- The P2 items (repo clutter, encryption/backup docs, pairing UI) — no weights.

The two items that *did* need weights (MC-dropout wiring, the quality-gate `.exe`) have already been picked up
here today (§5 below) rather than left for him. **So: you may not need to send Saad the weights link at all**,
unless he specifically wants to run the full ML pipeline himself for some other reason. Worth a one-line message
to him either way, so he's not blocked waiting on a link that may no longer matter for what's on his plate.

## 4. Deployment — still explicitly parked

Unchanged from before: Vercel/Render/where the DB and models actually live is out of scope until after the
video, per your own call. Nothing to do here yet.

## 5. Decisions before recording

- **Is the video showing the mobile app?** Affects how much of §2 above is urgent tonight vs. can slip.
- **Is `/admin/phc-health` on camera?** It shows a real "1 of 4 checks tripped" banner (the seeded second PHC
  never contacts central) — correct, but red. `docs/DEMO.md` already flags this as your call to present or avoid.
- **The corrected v2c numbers in `docs/STALE_CLAIMS_AUDIT.md` §3.1** (grade-4 recall, grade-1 recall, QWK) — the
  ppt is already made, so this is only relevant if you want to correct a slide or answer a judge's question
  about the numbers with the current figures instead of the ones in `system-design-v4.md`. No action needed if
  not.

## 6. When you and Saad are both done

`node scripts/demo-reset.js` (must exit 0), then `docs/DEMO_RUNBOOK.md` scene by scene, twice, restarting from
`demo-reset` between runs. Log anything that breaks in `docs/BUGLOG.md`. Then open the `integration` → `main` PR
(`origin/main` is currently several commits behind). Then record.

---

## Reference: what was done today (for context, not action)

P1-1/P1-2/P1-3 (best-effort path, use-existing-patient/capture-other-eye, full Hindi+Marathi i18n on the whole
registration form), the Simulink table + a broken demo-admin login found and fixed along the way, P2-2/P2-7/P2-8
hygiene fixes, `scripts/fetch-models.js`, `docs/STALE_CLAIMS_AUDIT.md` (a full doc-vs-code sweep, separate from
`system-design-v4.md` per your instruction not to edit it), mobile↔desktop sync fully re-verified (peer, sync,
dry-run, fovea, mobile-lens suites — all real, all passing on this machine), a genuine same-machine MATLAB
timeout bug found and fixed (quality gate cold-start racing central's persistent classification session), the
MC-dropout honest-label fix, and the quality-gate compiled executable (build status: see the commit that lands
right after this file, once MATLAB Compiler finishes on this machine).
