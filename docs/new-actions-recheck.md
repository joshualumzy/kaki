# New actions re-check (short): calendar grid, date fix, animation, light mode

You may be starting with no memory of earlier work. This follows `docs/new-actions-check.md`; read its "Rules for the agent" first and obey them. They apply here.

## Git safety (non-negotiable)
- Push only to `origin`, branch `feature/scripted-replay`. Do not push to any other remote.
- No `--force`, `--force-with-lease`, `reset --hard`, `git checkout -- <path>`, `git clean`. If a push is rejected or branches diverged: STOP, run `git fetch`, show `git log --oneline --graph --all -15`, explain, and ask the owner.
- Before discarding any uncommitted change, show `git status` and ask. Prefer `git stash`.
- After every push, confirm the remote still has every commit it had before.

## What changed since the last check
- The calendar link now opens a month-grid team calendar (all events, the new one highlighted), with no .ics link.
- "next Friday" dates are looked up from a table of weekdays, not counted.
- The phone shows animated dots while Kaki drafts or sends.
- The whole app is light mode only.

## What YOU (the agent) do, before the owner starts
1. `git pull origin feature/scripted-replay` (plain pull; if it does not fast-forward, follow the git safety rules). `npm install`.
2. Make sure the stack is up (`npm run stack:up`, do not run `docker compose down`), and `.env` has `CALDAV_URL` and the `WIKI_*` keys (print key names only).
3. Restart the server: `KAKI_DEV_ROUTES=1 npm run dev 2>&1 | tee recheck.log` in the background. Confirm `curl -s http://localhost:3001/health` answers. Start the same event recorder as before, writing `docs/replay-events/recheck-<role>.jsonl` for `screen` and `producer`.
4. Make sure the seeded calendar event exists: `curl -s http://127.0.0.1:5232/user/calendar/pixel-kampung.ics` should print `BEGIN:VCALENDAR`. If not, run `npx tsx scripts/seed-caldav.ts` from a checkout of `origin/feature/caldav-ingestion` in a separate folder (see `docs/calendar-check.md` setup) and say so in the report.
5. Create the task:
```bash
curl -s -X POST http://localhost:3001/dev/suggest-task -H 'content-type: application/json' -d '{"title":"Schedule a follow-up with Starfruit next Friday","context":"Confirm the final build date with Starfruit. Next Friday at 10:00 for half an hour.","suggestedAssignee":"producer","actionKind":"calendar_event"}'
```
6. Write `docs/new-actions-recheck-todo.md` for the owner by copying the section below with the running URLs. Push it, then **tell the owner it is ready and stop and wait**.

## What the OWNER does (copy this into the todo file)
Shared screen: `http://localhost:5173/screen`. Phone: `http://localhost:5173/phone?role=producer`.
1. **Light mode:** Are `/screen` and `/phone` light? Is anything dark? yes/no.
2. Dispatch "Schedule a follow-up with Starfruit next Friday" to the producer. Press "Let Kaki do it".
3. **Animation:** While it drafts, do you see moving dots next to the text? yes/no.
4. **Date:** Write the `Start:` line shown in the draft. (Today is Tue 3 Nov 2026, so 2026-11-06 or 2026-11-13 is correct; 2026-11-12 is wrong.)
5. Approve. While it sends, do the dots show again? yes/no.
6. Open the link on the card. Do you see a **month grid** for November 2026? Is the "Hawker Heroes launch readiness" event on 1 Nov? Is your new event highlighted? Is there any .ics button or download? Do Previous and Next work? Answer each yes/no.
7. Is this what you meant by "a mocked calendar that is hosted like everything else"? yes/no, and what is missing.
Then tell the agent "done".

## What YOU (the agent) do after "done"
Verify from events and APIs only:
- The task's events end COMPLETED with an `artifactUrl` ending `/api/calendar/<task id>`. Quote the draft's `Start:` line.
- `curl -s -o /dev/null -w '%{http_code}' <artifactUrl>` and quote the code; `curl -s <artifactUrl>` should contain `November 2026`, `Hawker Heroes launch readiness` and `class="chip focus"`, and should not contain `.ics`. Quote the matching lines.
- Calendar collection: exactly one `.ics` for this task id.
Write `docs/new-actions-recheck-results.md`: events quoted, API checks, the owner's answers quoted as given, and PASS / FAIL for each of: light mode, animation, date, calendar grid. Anything you could not verify is NOT VERIFIED, not PASS. Commit and push with a plain `git push origin feature/scripted-replay`.
