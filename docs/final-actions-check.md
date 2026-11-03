# Final actions check: sync-back, manual mode, retry

You may be starting with no memory of earlier work: everything you need is in this file and the repo. Do not change code. Do not kill Chrome. Never print `.env` values. Report only what you saw.

Goal: check three things not yet tested. (A) a finished task syncs to the shared screen's Done column; (B) "I'll do it" (manual mode) works end to end; (C) a failed action shows a clear message and Retry works.

## Setup
1. `git pull origin feature/scripted-replay`.
2. If the Docker stack is not running or the data looks stale: follow steps 1 to 3 of `docs/manual-check-prep.md` (reset, seed, index, `.env` keys, connector tests).
3. Restart the dev server in replay mode so there are fresh tasks: stop the old one, then `KAKI_REPLAY=1 KAKI_REPLAY_SPEED=10 npm run dev 2>&1 | tee final.log`. Wait about 4 minutes, until the live feed shows "That's everything. Thanks all, good meeting."
4. Open `http://localhost:5173/screen`. The role ids are exactly `producer`, `lead_programmer`, `game_designer`, `marketing_lead`: phone pages are `http://localhost:5173/phone?role=<id>`. Do not invent other ids.
5. Log in to Mattermost once in the browser you use (http://localhost:8065 or the port in `docker/README.md`), so links open without a login page.

## Record events (so claims can be checked)
Run a small script outside the repo that connects to `ws://localhost:3001/ws?role=screen` and each role id above and appends every message as one JSON line to `docs/replay-events/final-<role>.jsonl`. Start it before step A.

## A. Sync-back
1. On `/screen`, dispatch the Suggested task whose title mentions the crash to its suggested role.
2. On that role's phone: "Let Kaki do it", wait for the draft, Approve, wait for COMPLETED.
3. Press "Sync to meeting". Does the task move to **Done** on `/screen`? Take screenshots of the screen before and after (`docs/screenshots/final-a-before.png`, `final-a-after.png`). Does the Done card show a link? Note the task's final status in the events (expect SYNCED).

## B. Manual mode
1. Dispatch a different Suggested task. On the phone press **"I'll do it"**.
2. Does the card now show a **Mark done** button? Press it. Status should become COMPLETED, then press "Sync to meeting" and confirm it reaches Done on `/screen`. Screenshots `final-b-*.png`.

## C. Failure and retry
1. Dispatch an email task (the streamer email). On its phone press "Let Kaki do it" and wait for the draft.
2. **Before approving**, stop Mailpit: `docker stop $(docker ps -q --filter name=mailpit)`. Type any address in the "To" box, then Approve.
3. Record the exact message the phone shows. Is it understandable to a non-technical person? Screenshot `final-c-failed.png`.
4. Start Mailpit again (`docker start <container>`), press **Retry**. Does it complete? Does Mailpit's message count go up by exactly one (not two)? Record the count before and after.

## Report: `docs/final-actions-results.md`
For A, B and C: what you did, what you saw (quote messages exactly), the screenshot names, and one line **PASS / FAIL** with the reason. If a button was missing or did nothing, say which and paste the matching lines from `final.log` or the events. Commit the report, screenshots and event files, and push to `feature/scripted-replay`.
