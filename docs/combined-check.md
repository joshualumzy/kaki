# Combined check (cleanup + one test of everything new)

Written for a literal-minded agent. Do the steps in order. Do not skip. Do not improvise. If a step fails, STOP and report the exact output; do not try to fix it by yourself.

Read `docs/new-actions-check.md` ("Rules for the agent") first and obey it. The owner does every click. You never open a browser.

## Git safety (non-negotiable)
- On the agent's machine the owner's remote is called `personal`. Push only to `personal`, branch `feature/scripted-replay`. Never push to `origin` there.
- Plain `git push personal feature/scripted-replay`. No `--force`, no `--force-with-lease`, no `reset --hard`, no `git clean`, no `git checkout -- <path>`.
- If a push is rejected: STOP, run `git fetch personal`, show `git log --oneline --graph --all -15`, explain, ask the owner.
- After every push, confirm the remote still has every commit it had before.

## What changed in this round (what we are testing)
1. The notetaker now knows `wiki_page` and `calendar_event`, and is told to always set `actionKind`, to not repeat questions in other words, and to ask about dates nobody gave.
2. The Done card on `/screen` shows an "Open artifact" link. For Mattermost tasks, a note says it may ask for a login.
3. The phone keeps the "sending" dots for at least 1.2 seconds.
4. Drafts keep the words of the task title.
5. The host's opening line lists the agenda and the first item.
6. The calendar grid: clicking an event shows its details (from the earlier fix, not yet checked live).

## Part A: your steps before the owner starts

A1. `git pull personal feature/scripted-replay` (plain pull; if it does not fast-forward, follow the git safety rules). Then `npm install`.

A2. Stack: `npm run stack:up`. Never run `docker compose down`. Check `curl -s http://localhost:3001/health` after step A4 and `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5232/` now (any answer other than a connection error is fine). Print the key names (not values) of `.env`: `awk -F= '/^[A-Z]/{print $1}' .env`. `CALDAV_URL`, `WIKI_*`, `MATTERMOST_*`, `GITEA_*` must be there. If one is missing, STOP and tell the owner.

A3. Calendar cleanup. List what is in the mock calendar:
```bash
curl -s -X PROPFIND -H 'Depth: 1' http://127.0.0.1:5232/user/calendar/ | grep -o '<D:href>[^<]*\.ics</D:href>' | sed 's/<[^>]*>//g'
```
Write the list in your report. Delete **every** `.ics` file in it **except** `pixel-kampung.ics`:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE http://127.0.0.1:5232/user/calendar/<file-name>.ics
```
(one command per file; `204` means deleted.) List again and confirm only `pixel-kampung.ics` is left. If `pixel-kampung.ics` is missing, STOP and tell the owner (do not recreate it yourself).

A4. Start the server in the background with logs kept: `KAKI_DEV_ROUTES=1 npm run dev 2>&1 | tee combined.log`. Confirm `curl -s http://localhost:3001/health` answers. Start the same event recorder as the earlier checks, writing `docs/replay-events/combined-screen.jsonl` (role `screen`) and `docs/replay-events/combined-producer.jsonl` (role `producer`). If you do not remember how, look at how `docs/replay-events/recheck-producer.jsonl` was produced in the commit history and in `docs/new-actions-recheck.md`; if you still cannot, STOP and ask.

A5. Create three tasks (copy exactly):
```bash
curl -s -X POST http://localhost:3001/dev/suggest-task -H 'content-type: application/json' -d '{"title":"Post the new opening hours in the team channel","context":"Post the new opening hours for the launch week in the team channel.","suggestedAssignee":"producer","actionKind":"mattermost_post"}'
curl -s -X POST http://localhost:3001/dev/suggest-task -H 'content-type: application/json' -d '{"title":"Schedule a follow-up with Starfruit next Friday","context":"Confirm the final build date with Starfruit. Next Friday at 10:00 for half an hour.","suggestedAssignee":"producer","actionKind":"calendar_event"}'
curl -s -X POST http://localhost:3001/dev/suggest-task -H 'content-type: application/json' -d '{"title":"Write up the meeting decisions on the wiki","context":"Decisions: the launch date stays. The final build is still to be confirmed.","suggestedAssignee":"producer","actionKind":"wiki_page"}'
```

A6. Replay (notetaker + host check). Follow `docs/replay-check.md` steps for starting the replay at 10x speed with the recorder running. Let it finish.

A7. Write `docs/combined-check-todo.md` for the owner by copying Part B below, with the real URLs. Commit and push it (plain push to `personal`), then **tell the owner it is ready, and stop and wait for "done"**.

## Part B: what the OWNER does (copy this into the todo file)
Shared screen: `http://localhost:5173/screen`. Phone: `http://localhost:5173/phone?role=producer`.

First time in the demo browser only: open `http://127.0.0.1:8083`, log in as `weiling` with password `kaki_mattermost_dev`. (This is the dev-only login from the local test stack.)

1. On the phone, dispatch the Mattermost task to the producer. Press "Let Kaki do it". Read the draft. **Does the draft contain any detail that is not in the task (an invented date, name or number)?** yes/no, and copy it.
2. Approve it. **Do the dots stay on screen for about a second or more before the card changes?** yes/no.
3. On the card after it finishes: **does a note say Mattermost may ask you to log in?** yes/no. Click "Open artifact". **Does the post open?** yes/no.
4. On `/screen`, look at the Done column. **Is there an "Open artifact" link on the finished task?** yes/no.
5. Dispatch the calendar task. Let Kaki do it. **Write the `Start:` line from the draft.** (Today is Tue 3 Nov 2026: 2026-11-06 or 2026-11-13 is right.) Approve it.
6. Open the calendar link. **Month grid for November 2026? yes/no. Click the event "Hawker Heroes launch readiness": do its details appear? yes/no. Is your new event highlighted? yes/no.**
7. Dispatch the wiki task. Let Kaki do it. **Does the draft contain any detail not in the task? yes/no.** Approve it. **Does the wiki link open the page? yes/no.**
8. After the replay: on `/screen`, **write the opening line the host said at the start, and say how many open questions are shown and whether any two of them ask the same thing.** (yes/no)
9. Did the suggested tasks include a wiki or calendar one at any point? Write what you saw.
Then tell the agent "done".

## Part C: your steps after "done"
Verify from the saved events and APIs only. No claims without a quote.
- For each of the three tasks: quote the events showing the status order (… RUNNING, COMPLETED) and the `artifactUrl`. Quote the draft text of each and compare with the task context: list any detail not in the task.
- For the RUNNING status: print the event timestamps of RUNNING and the next COMPLETED event. (The 1.2-second hold is in the browser only, so mark it "owner's answer only".)
- `curl -s -o /dev/null -w '%{http_code}' <artifactUrl>` for the wiki and calendar links; quote the codes. For the calendar, `curl -s <artifactUrl>` must contain `November 2026`, `Hawker Heroes launch readiness` and `class="chip focus"`.
- Calendar collection: re-run the list from A3. Quote the result.
- From the screen events: quote the OPENING `HOST_SPEECH_TRIGGERED` text. List every `openQuestions` text in the last `MEETING_RECORD_UPDATED` event and say if any pair repeats. Say whether the final-build question appears. List every suggested task with its `actionKind` (or "missing").
- Run `npm run eval:notetaker` if the LLM keys are set; paste the whole output. If they are not set, write NOT VERIFIED.

Write `docs/combined-check-results.md`: events quoted, API checks, the owner's answers quoted as given, and PASS / FAIL for each of: Mattermost draft, sending hold, Mattermost link and note, Done-card link, calendar date, calendar grid + click, wiki draft + link, opening line, duplicate questions, actionKind. Anything you could not verify is NOT VERIFIED, not PASS. Commit and push with a plain `git push personal feature/scripted-replay`, then confirm the remote still has every earlier commit.
