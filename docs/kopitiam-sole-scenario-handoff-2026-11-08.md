# Kopitiam sole scenario handoff — 8 Nov 2026

## Done
- Branch `feature/scripted-replay`; baseline commits `b20d159` (sole scenario migration) and `224b07a` (cumulative proposal decisions and seed verifier). No push.
- Pixel Kampung source removed; Kopitiam is default, with replay, expected extraction, demo events, four agenda discussions, and rewritten seed records. Generic scenario loader remains.
- Offline gate after cumulative fix: typecheck, 532 tests passed / 6 skipped. Live local seed refreshed through in-memory environment without changing either `.env`; `seed:verify` passed 15/15, knowledge search passed, `emit-demo` posted 7 events and 3 tasks.
- Local `.env` files still contain legacy Gitea/Mattermost organization IDs; use temporary `GITEA_ORG=kopitiam MATTERMOST_TEAM=kopitiam` overrides for live verification. An older unrelated git stash remains untouched.

## Active work and next steps
- Playtest fixes are now in the worktree: 15s bounded assessment, imperative proposal and follow-up classification, and stronger factual grounding for Auntie Mary. Full typecheck and 539 tests passed / 6 skipped. Re-run `/private/tmp/kopitiam-playtest.mts` for the affected cases.
- Real CLI playtest across four topics/visitor roles exposed those defects. Topic 1 and seating creative plans settled; cash creative proposal timed out; butter creative settled. The model sometimes invented staff resignation and repeated a cash objection after timeout. Re-run affected cases from `/private/tmp/kopitiam-playtest.mts` after fixes.
- Real Kopitiam replay evaluation (`node --env-file=.env --import tsx server/src/host/evalNotetaker.ts`) failed: extracted an unassigned Zack-terms task, dropped unresolved tourist/local split, and missed cash float wording. The notetaker currently accepts `answeredQuestionIds` without evidence; investigate that and task grounding, add tests, and rerun. Do not weaken expected results without evidence.
- Inspect task drafts for grounded details, run replay evaluation again, check live process configuration versus legacy local env IDs, and finish final `git status`/`git diff --check`/`codex-context`.
- No browser/Computer Use permission granted; use shell or structured tools only. Do not wipe Docker volumes or overwrite local `.env`.
