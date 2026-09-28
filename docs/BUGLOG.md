# Bug log: final demo runs

Found while running `docs/DEMO_RUNBOOK.md` end to end against real services, each run starting from
`node scripts/demo-reset.js`. Every fix restarted the run from `demo-reset`. Newest last.

| # | Found in | What broke | Cause | Fix |
|---|---|---|---|---|
| 1 | Prep | `demo-reset` ended with "FAILED:" and nothing else | Docker Desktop was not running; a refused connection is an `AggregateError` with an empty `message` | `scripts/demo-reset.js` prints the error code and "Is Postgres up? Start Docker Desktop, then: npm run db:up" |
| 2 | Reset, step 5 | Warm-up failed: `MatlabEngineFailed ... [Errno 13] Permission denied ...responses\seg_*.json` | On Windows the response file exists before MATLAB's `movefile` has released it; the client opened it at once | `matlabSessionClient.py` and `services/sessionClient.js` read again until their own deadline on `PermissionError`/`EACCES`/half-written JSON |
| 3 | Reset, step 1 | A second reset left the old web servers running | `pidsOnPort` used `netstat -p TCP` (IPv4 only); Vite listens on `[::1]` | `scripts/lib/demoStack.js` uses plain `netstat -ano` and matches `TCP` rows of both families |
| 4 | Scene 1 | PHC login: "Cannot reach the PHC backend at http://localhost:4000". Central login: "502 Bad Gateway from /api/v1/auth/login" | This checkout's backends run on 4200/5200, but the git-ignored `.env` of each web app still named 4000/5000 | `demo-reset` starts the PHC web app with `VITE_LOCAL_API_BASE` and the central web app with `CENTRAL_API_PROXY_TARGET` set to this checkout's ports (a real environment variable beats `.env` in Vite) |
| 5 | Scene 1 | After a reset, the PHC desktop opened straight to the form with the header stuck on "PHC BACKEND UNREACHABLE" | The browser kept last run's technician token; the reset wiped the accounts, so every call was `401`. The app trusted the stored session and reported the 401 as "unreachable" | `phc-local-app/frontend/src/api/localApiClient.js`: any `401` outside `/auth/login` clears the stored session and returns to the login screen. Verified in the browser against the stale session |
| 6 | Scene 7 | Case Detail showed no engine for the classifier, segmentation or rule engine, and nothing for a mobile case's quality gate | The UI never rendered `engineProvenance` | `CaseDetailPage.jsx`: an **ENGINES** tile lists every output's engine, "NOT RECORDED" for a null, "(FALLBACK)" when the fallback flag is set |

## Known, not fixed

- **Central fonts fall back to the system font** when `node_modules` is a junction to another checkout
  (Vite: "outside of Vite serving allow list"). Only this worktree; a normal checkout serves them.
- **PHC Health shows a red "1 OF 4 CHECKS TRIPPED" banner** because the seeded second site
  (PHC Wagholi) never contacts central. It is the correct answer; the runbook tells the presenter to
  decide whether to show the page.
- **`browser form_input` does not drive the login forms** (values set without the app noticing).
  Automation tooling only, not the product: typing works, and so does the app for a person.
- **The mobile scene needs a phone.** The runs below used the mobile app's own sync stack
  (`npm run test:sync` against live central) as the stand-in, as the runbook describes.
