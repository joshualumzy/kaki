# Calendar check: how does Radicale show an event? (observe and report only)

Why: we may add a "schedule a follow-up" action. Every action must give the participant a **link to the result**. We need to know if a Radicale (CalDAV) event has a link a person can open and understand. Do not change any code. Do not kill Chrome. Do not print `.env` values.

Run these from the repo checkout on `feature/scripted-replay` (`git pull origin feature/scripted-replay` first). The calendar code lives on another branch, so use a **separate folder**:

```bash
git fetch origin feature/caldav-ingestion
git worktree add ../kaki-caldav origin/feature/caldav-ingestion
cd ../kaki-caldav
docker compose -f docker/docker-compose.yml up -d caldav
```
Wait about 10 seconds, then:
```bash
npx tsx scripts/seed-caldav.ts
```
(If `tsx` is missing, run `npm install` in `../kaki-caldav` first.) The output should say "Successfully injected". If it does not, copy the error and go to "Report".

## Observe (write down exactly what you see; take a screenshot for each browser step)
1. Open `http://127.0.0.1:5232/` in a browser. What is on the page? Can you see the event "Hawker Heroes launch readiness" anywhere there? (screenshot `calendar-1-root.png`)
2. Open `http://127.0.0.1:5232/user/calendar/pixel-kampung.ics`. Does the browser **show text, show a calendar view, or download a file**? (screenshot `calendar-2-ics.png`, or say "downloaded")
3. Run `curl -s http://127.0.0.1:5232/user/calendar/pixel-kampung.ics` and paste the output.
4. Simulate what an action would do: create a second event with a new UID and title `Follow-up with Starfruit` for next Friday 10:00-10:30, using `curl -X PUT -H "Content-Type: text/calendar; charset=utf-8" --data-binary @file.ics http://127.0.0.1:5232/user/calendar/followup-1.ics` (write a small valid `.ics` file first, in a scratch folder). Report the HTTP status.
5. Open that new event's URL in the browser. Same question as step 2.
6. Is there any page in Radicale where a person can see events as a calendar (a month or week grid)? Say yes or no, and where.
7. Optional, only if it takes under 5 minutes: add the calendar to a CalDAV viewer you already have (for example the macOS Calendar app: Settings, Accounts, Add Other Account, CalDAV, server `http://127.0.0.1:5232/user/`, no password). Does the event show up?

## Report
Write `docs/calendar-check-results.md` in the **main checkout** (not the `kaki-caldav` folder), one numbered answer per step above, with screenshots in `docs/screenshots/`. End with one line: "A person could / could not open the event link and understand it without extra software." Commit and push to `feature/scripted-replay`.

## Clean up
```bash
docker compose -f docker/docker-compose.yml stop caldav
cd ../it5007-courseproject-group-14 2>/dev/null || cd -
git worktree remove ../kaki-caldav --force
```
