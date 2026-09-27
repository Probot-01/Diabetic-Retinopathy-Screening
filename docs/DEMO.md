# Recording the demo

Everything runs locally. Two commands: one resets, one takes central away and brings it back.

```
node scripts/demo-reset.js                   # ~4-5 minutes; prints logins and case references at the end
node scripts/demo-offline.js stop | restore | status | cycle
```

`demo-reset` stops this checkout's stack (by the ports in its own `.env` files, so a second
worktree's stack is never touched), drops and recreates its database, clears central media and the
PHC desktop's SQLite queue and stored images, runs every migration, re-seeds the two central users
and both PHC sites (with `phc_code`, fresh API keys), creates the PHC desktop technician, starts
everything, waits for every `/health` component, warms MATLAB and the models, then creates five
cases through the real path (PHC backend -> MATLAB quality gate -> sync -> central grading) from
IDRiD images listed in `scripts/demo-set.json`. It checks each case got the outcome the demo needs
(exit code 2 and a `!!` line if not) and applies the reviews. Passwords are generated per run and
printed once; nothing is written to a file git can see (service logs go to the OS temp folder).

| Case | Image | CNN / rule engine | State after reset |
|---|---|---|---|
| normal | IDRiD_041 | 0 / 0, agree | reviewed, confirmed |
| normal | IDRiD_044 | 0 / 0, agree | reviewed, confirmed |
| referable | IDRiD_020 | 2 / 2, agree, tier B | **unreviewed** (live review scene) |
| referable | IDRiD_010 | 2 / 2, agree, tier B | **unreviewed** (live review scene) |
| branch disagreement | IDRiD_005 | 4 / 1, disagree | reviewed, overridden to grade 4, referral raised |

Patient references (`PT-XXXXXX`) are random per run; the reset prints the table.

## Expected screens

- **Central sign-in.** Motion on: the intro plays; scrolling to the end, or the SKIP link, shows the
  role cards and the form. Reduced motion (OS setting): no intro, role cards at once.
- **Ophthalmologist queue.** The two unreviewed referables (grade 2, tier B, CNN and rule engine agree).
  Reviewed cases leave the queue. Opening a case claims it for you ("CLAIMED BY YOU").
- **Case detail.** Header shows the patient reference. Uncertainty and lesion-attention consistency
  read NOT COMPUTED (the pipeline does not produce them); that is honest, not a bug.
- **Admin.** Overview, Dashboard, Referrals (one row: the grade-4 override, "manual follow-up",
  because SMS is not configured), PHC Health, Resource Planning.
- **PHC Health.** PHC Kharadi ACTIVE. PHC Wagholi is seeded but never sends anything, so it shows
  SILENT and the System Health card reads "1 OF 4 CHECKS TRIPPED". Both use one rule: no contact in
  `PHC_SILENT_HOURS` (default 24). If that red banner is unwanted on camera, do not show that page
  before a Wagholi case exists (decision for the presenter).
- **Resource Planning.** "Simulation results not yet generated." until the model is run.
- All times are IST.

## Offline scene (PHC desktop, http://localhost:5273)

1. Online: header **ONLINE, 0 PENDING**.
2. `node scripts/demo-offline.js stop`. Wait about 15 seconds (the PHC polls every 10 s). Header
   becomes **OFFLINE, 0 PENDING**. The PHC keeps working: registration, capture, quality check and
   both questionnaires all run locally.
3. Capture a patient. Header **OFFLINE, 1 PENDING**; the queue row reads
   **QUEUED - PENDING UPLOAD**, action WAITING (SYNC).
4. `node scripts/demo-offline.js restore` (about 6-7 s to a healthy backend). Within about 10 s the
   header returns to **ONLINE, 0 PENDING** and, after grading (~20 s), the row reads **RESULT READY**.
5. Do not show the central web app while it is stopped: it cannot check its session and falls back
   to the sign-in intro.

The MATLAB session, segmentation worker, Postgres and both web apps stay up during the scene, which
is why a restore takes seconds. Rehearsal leaves a 6th case behind: run `demo-reset` again before recording.

## Mobile app

Clear the phone's local store before recording; it keeps its own data. It lives in the app's SQLite
database `netrasetu.db` plus SecureStore. Expo Go on Android: Settings > Apps > Expo Go > Storage >
Clear data. iOS or a standalone build: delete and reinstall. PHC001's API key changes on every reset
(`phc-local-app/backend/.env`), so the app needs the new one.

## Known flake

The quality gate is a fresh `matlab -batch` per capture. On Windows it occasionally dies at start
(exit 3221225794) when other MATLAB processes are running. `demo-reset` re-runs the check up to
three times; in the live PHC flow the technician gets "quality check could not run" and can retry.
