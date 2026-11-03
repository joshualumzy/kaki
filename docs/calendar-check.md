# Calendar check: how does Radicale show an event? (the agent runs commands, the owner looks)

You may be starting with no memory of earlier work. Do not change code.

## Rules for the agent
- **No browser automation** (no Puppeteer, Playwright or Selenium) and no screenshots by script. Anything that needs a browser or the Calendar app is done by the **owner**.
- Use commands only (`git`, `docker`, `curl`, `npx tsx`). Do not run `docker compose down`, `-v` or `--remove-orphans`: the main stack may be running. Do not kill Chrome. Never print `.env` values.
- Report only what you saw; quote command output exactly.

Why: we may add a "schedule a follow-up" action. Every action must give the participant a **link to the result**, so we need to know if a Radicale (CalDAV) event has a link a person can open and understand.

## Agent: setup
Run from the main checkout (`git pull origin feature/scripted-replay` first). The calendar code is on another branch, so use a separate folder next to the repo, and remember the main checkout's path as `$MAIN` (`MAIN=$(pwd)`):
```bash
git fetch origin feature/caldav-ingestion
git worktree add ../kaki-caldav origin/feature/caldav-ingestion
cd ../kaki-caldav && npm install
docker compose -f docker/docker-compose.yml up -d caldav
sleep 10
npx tsx scripts/seed-caldav.ts
```
The seed output should say "Successfully injected". If not, copy the error into the report and stop.

Then run and paste the output of:
1. `curl -s http://127.0.0.1:5232/user/calendar/pixel-kampung.ics`
2. Create a second event the way an action would: write a small valid `.ics` (new UID, title `Follow-up with Starfruit`, next Friday 10:00 to 10:30) into a scratch folder, then `curl -i -X PUT -H "Content-Type: text/calendar; charset=utf-8" --data-binary @<file> http://127.0.0.1:5232/user/calendar/followup-1.ics` and report the HTTP status.
3. `curl -s http://127.0.0.1:5232/user/calendar/followup-1.ics`

Then **stop and tell the owner**: "ready: please do the owner steps".

## Owner steps (about 5 minutes; write the answers in chat to the agent)
1. In your browser open `http://127.0.0.1:5232/`. What do you see? Is the event "Hawker Heroes launch readiness" visible there? (yes/no, one line)
2. Open `http://127.0.0.1:5232/user/calendar/followup-1.ics`. Does the browser **show text, show a calendar view, or download a file**?
3. Is there any page that shows events as a calendar (month or week grid)? yes/no, where.
4. Optional: add the calendar to a viewer you already use (macOS Calendar: Settings, Accounts, Add Other Account, CalDAV, server `http://127.0.0.1:5232/user/`, no password). Does the event show up?
Tell the agent "done".

## Agent: report and clean up
Write `docs/calendar-check-results.md` in the **main checkout** (`$MAIN`): the command outputs, and the owner's answers quoted as given. End with one line: "A person could / could not open the event link and understand it without extra software." Commit and push to `feature/scripted-replay`. Then:
```bash
cd "$MAIN"
docker compose -f ../kaki-caldav/docker/docker-compose.yml stop caldav
git worktree remove ../kaki-caldav --force
```
