# NetraSetu — standing rules for every Claude Code session

## Source of truth
- `docs/api-contracts.md` wins over any plan or existing code for request/response shapes, enums, IDs, dates, error shape. If code disagrees with it, fix the code — unless the contract is genuinely unbuildable, in which case STOP and report; any contract change gets a dated Changelog entry.
- `docs/system-design-v4.md` defines behavior. `docs/implementation-plan-*.md` define who owns what.
- Never assume a feature exists because a doc describes it. Confirm with file:line evidence, or say "not found".

## Non-negotiables
- No frontend may fabricate a result in place of a failure (design §1.22). A failed request shows an error or genuinely queues for retry. Mock data only when `DATA_MODE=mock` is explicitly set, and then a visible "DEMO DATA" banner is on screen. Never auto-fallback to mock on error.
- Every case records which engine produced each ML output (matlab / python / js-fallback). No silent engine fallback.
- Do not retrain, modify, or re-export model weights. Do not change rule-engine thresholds (RED_FLOOR=3, GRADE3_QUAD_MIN=3, RULE_MAX_GRADE=3) unless explicitly told.
- Only public-dataset images (IDRiD, APTOS, Messidor-2, DRIVE, CHASE_DB1) in seeds, tests, and deployments. No real patient data.
- Never commit secrets. Every service reads config from env; every service has an `.env.example`.
- Never weaken or delete a test to make it pass.

## Working style
- The user (Tanuj) does not write MATLAB; do all MATLAB work yourself via the `matlab` CLI (`matlab -batch "..."`). Report exact commands run.
- Small, reviewable commits with clear messages, one concern per commit.
- End every session with a short report: what changed (files), what was verified (how), what's still broken, and any decision you need from Tanuj. Stop at the checkpoint named in the prompt.