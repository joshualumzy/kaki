# Final actions check: sync-back, manual mode, retry

You may be starting with no memory of earlier work: everything you need is in this file and the repo.

## Rules for the agent (read first)
- **Do NOT use Puppeteer, Playwright, Selenium or any browser automation. Do NOT click, type or press anything in the app's pages.** All clicking and reading on `/screen` and `/phone` is done by the **owner**. Browser automation has already produced wrong reports here.
- You only do things that are **commands, API calls and file checks**: setup, recording events, stopping and starting Docker containers on cue, and verifying results afterwards from the services' APIs and the recorded events.
- Do not change code. Do not kill Chrome. Never print `.env` values.
- Report only what you verified, quoting event or API data. Never write PASS without data. If the owner's report and the data disagree, say so plainly.

Goal: check three untested things. (A) a finished task syncs to the shared screen's Done column; (B) "I'll do it" (manual mode) works; (C) a failed action shows a clear message and Retry works, with no duplicate.

## What YOU (the agent) do, before the owner starts
1. `git pull origin feature/scripted-replay`.
2. If the Docker stack is not running or data looks stale: do steps 1 to 3 of `docs/manual-check-prep.md` (reset, seed, index, `.env` keys, connector tests).
3. Start the dev server in replay mode: `KAKI_REPLAY=1 KAKI_REPLAY_SPEED=10 npm run dev 2>&1 | tee final.log`, in the background. Wait until `/screen` has the closing line (about 4 minutes) by checking the server's event stream, not a browser.
4. Start an event recorder (a small script outside the repo, WebSocket to `ws://localhost:3001/ws?role=<role>` for `screen`, `producer`, `lead_programmer`, `game_designer`, `marketing_lead`, one JSON line per message into `docs/replay-events/final-<role>.jsonl`). Leave it running.
5. Record the "before" facts through the APIs: Mailpit message count, newest Gitea issue number.
6. Write `docs/final-actions-todo.md` for the owner by copying the "What the OWNER does" section below, adding the exact running URLs. Push it, then **tell the owner it is ready and stop and wait**.

## What the OWNER does (you copy this into the todo file)
Role ids are exactly `producer`, `lead_programmer`, `game_designer`, `marketing_lead`. Phone pages are `http://localhost:5173/phone?role=<id>`; the shared screen is `http://localhost:5173/screen`. Log in to Mattermost once in your browser first.

**A. Sync-back**
1. On `/screen`, dispatch the Suggested task about the ten-customer crash.
2. On that role's phone: "Let Kaki do it", wait for the draft, Approve, wait for it to show completed.
3. Press "Sync to meeting". Does the task move to **Done** on `/screen`? Does the Done card show a link? Write the answers (yes/no) and anything odd.

**B. Manual mode**
1. Dispatch a different Suggested task. On its phone press **"I'll do it"**.
2. Is there a **Mark done** button? Press it, then "Sync to meeting". Does it reach **Done** on `/screen`? Write yes/no.

**C. Failure and retry**
1. Dispatch the streamer email task. On its phone press "Let Kaki do it" and wait for the draft. Type any address in the To box.
2. **Stop here and tell the agent "stop mailpit".** The agent stops Mailpit and tells you when to continue.
3. Press Approve. Copy the exact message that appears. Is it understandable to a non-technical person?
4. Tell the agent "start mailpit". When it says so, press **Retry**. Does it complete?

Then tell the agent "done".

## What YOU (the agent) do during and after
- On "stop mailpit": `docker stop $(docker ps -q --filter name=mailpit)` and say "stopped". On "start mailpit": `docker start` the same container, wait until `MAILPIT_URL` answers, say "started".
- On "done": verify from the **events and APIs only**:
  - A: the crash task's events end in SYNCED; a Gitea issue newer than the "before" number exists and its URL matches the task's `artifactUrl`.
  - B: the manual task's events go DISPATCHED, CLAIMED (mode MANUAL), COMPLETED, SYNCED.
  - C: the email task has a FAILED event with the exact error text, then RUNNING, then COMPLETED after the retry; Mailpit's count went up by **exactly one** since the before number.
- Write `docs/final-actions-results.md`: for A, B, C: the events you saw (quoted), the API check, the owner's yes/no answers quoted as given, and **PASS / FAIL** with the reason. Mark anything you could not verify as NOT VERIFIED, not PASS. Commit the report and the `final-*.jsonl` files and push to `feature/scripted-replay`.
