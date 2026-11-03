# New actions check: wiki page and calendar event

You may be starting with no memory of earlier work: everything you need is in this file and the repo.

## Rules for the agent (read first)
- **No Puppeteer, Playwright, Selenium or any browser automation. Do not click, type or press anything in the app's pages.** All clicking and reading on `/screen`, `/phone`, the wiki and the event page is done by the **owner**.
- You only run **commands, API calls and file checks**, and verify afterwards from the services' APIs and recorded events.
- Do not change code. Do not kill Chrome. Do not run `docker compose down`, `-v` or `--remove-orphans`. Never print `.env` values.
- Report only what you verified, quoting event or API data. Never write PASS without data; write NOT VERIFIED instead. If the owner's answers and the data disagree, say so plainly.

Goal: check that (A) a wiki page action and (B) a calendar event action each go dispatch, draft, approve, run, link, mark done and sync, and that the link a person gets can be opened and understood. (C) A retry creates no duplicate.

Background: the notetaker does not suggest these two kinds yet (the Host side has to add them to its prompt), so the agent creates the tasks through the dev route.

## What YOU (the agent) do, before the owner starts
1. `git pull origin feature/scripted-replay` and `npm install`.
2. Start the stack: `npm run stack:up` (this now also starts `caldav` on port 5232). Do `npm run seed`, then make sure the repo-root `.env` has `WIKI_URL`, `WIKI_ADMIN_EMAIL`, `WIKI_ADMIN_PASSWORD`, `CALDAV_URL=http://127.0.0.1:5232` (copy the values from `docker/.env` or `.env.example`; print only the key names). Also the existing keys from `docs/manual-check-prep.md` (LLM, Gitea, Mattermost, email) so the server starts.
3. Start the server with dev routes and a normal (not replay) meeting: `KAKI_DEV_ROUTES=1 npm run dev 2>&1 | tee new-actions.log`, in the background. Confirm `curl -s http://localhost:3001/health` answers.
4. Start an event recorder (a small script outside the repo, WebSocket to `ws://localhost:3001/ws?role=<role>` for `screen` and `producer`, one JSON line per message into `docs/replay-events/newactions-<role>.jsonl`). Leave it running.
5. Record the "before" facts through the APIs: the wiki page list (GraphQL `pages { list { path } }` after logging in as in `docker/seed/wiki.ts`), and `curl -s http://127.0.0.1:5232/user/calendar/` status.
6. Create the two tasks (assignee `producer`):
```bash
curl -s -X POST http://localhost:3001/dev/suggest-task -H 'content-type: application/json' -d '{"title":"Write up the launch decisions on the wiki","context":"The final build is due 20 Nov. The booth is 3m x 2m. The team wants one page everyone can find.","suggestedAssignee":"producer","actionKind":"wiki_page"}'
curl -s -X POST http://localhost:3001/dev/suggest-task -H 'content-type: application/json' -d '{"title":"Schedule a follow-up with Starfruit","context":"Confirm the final build date with Starfruit. Next Friday at 10:00 for half an hour.","suggestedAssignee":"producer","actionKind":"calendar_event"}'
```
If a call returns an error, copy it into the report and stop.
7. Write `docs/new-actions-todo.md` for the owner by copying the "What the OWNER does" section below with the exact running URLs. Push it, then **tell the owner it is ready and stop and wait**.

## What the OWNER does (you copy this into the todo file)
The shared screen is `http://localhost:5173/screen`; the phone is `http://localhost:5173/phone?role=producer`.

**A. Wiki page**
1. On `/screen`, dispatch the Suggested task "Write up the launch decisions on the wiki" to the producer.
2. On the producer phone: "Let Kaki do it", wait for the draft. Read it. Does it say anything that is not in the task (an invented date or name)? Write yes/no and what.
3. Approve. When it shows completed, open the link on the card. Does it open a wiki page with the text? Is the page easy to find and read? Write yes/no.
4. Press Mark done / "Sync to meeting" if shown. Does the task reach Done on `/screen`?

**B. Calendar event**
1. Dispatch "Schedule a follow-up with Starfruit". "Let Kaki do it", wait for the draft.
2. The draft body starts with `Start: YYYY-MM-DD HH:MM` and `Duration: N minutes`. Is the date the Friday you expect? Write the date shown. Edit the start time to 11:00 and Approve.
3. Open the link on the card. Does it show a page with the title, the time (11:00) and the notes, with no extra software? Does the "Add to my calendar" button download a file? Write yes/no for each.
4. Sync to meeting. Does it reach Done on `/screen`?

**C. Retry has no duplicate**
1. Dispatch a second calendar task (the agent creates it on cue: tell the agent "make another calendar task"). "Let Kaki do it", wait for the draft.
2. Tell the agent "stop caldav". The agent stops it and says so. Press Approve. Copy the exact message. Is it understandable to a non-technical person?
3. Tell the agent "start caldav". When it says so, press **Retry**. Does it complete?

Then tell the agent "done".

## What YOU (the agent) do during and after
- On "make another calendar task": run the calendar `curl` from step 6 again with the title `Schedule a second follow-up with Starfruit`, and say "created".
- On "stop caldav": `docker stop $(docker ps -q --filter name=caldav)` and say "stopped". On "start caldav": `docker start` the same container, wait until `http://127.0.0.1:5232/` answers, say "started".
- On "done", verify from the **events and APIs only**:
  - A: the wiki task's events go CLAIMED, DRAFT_READY, RUNNING, COMPLETED (quote `artifactUrl`), then SYNCED if the owner synced. Fetch that URL with `curl -s -o /dev/null -w '%{http_code}'` (expect 200, or say what you got) and confirm the page path now exists in the wiki list and did not exist before.
  - B: the calendar task's events end COMPLETED with an `artifactUrl` ending `/api/calendar/<task id>`. `curl -s` that URL and quote the title and time lines from the HTML; `curl -s <url>?download=1` should return a `BEGIN:VCALENDAR` file with `DTSTART:...T110000` if the owner edited to 11:00. Quote it. Also `curl -s http://127.0.0.1:5232/user/calendar/<task id>.ics`.
  - C: the third task has a FAILED event with the exact error text, then RUNNING, then COMPLETED after the retry. The calendar collection holds **exactly one** `.ics` for that task id (and the count rose by one for it, not two).
- Write `docs/new-actions-results.md`: for A, B, C the events you saw (quoted), the API check, the owner's answers quoted as given, and **PASS / FAIL** with the reason. Mark anything you could not verify as NOT VERIFIED. Then stop the stack's `caldav` only if you started it. Commit the report and the `newactions-*.jsonl` files and push to `feature/scripted-replay`.
