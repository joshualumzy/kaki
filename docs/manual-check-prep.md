# Prepare the manual delegation check (for an agent; the owner then does the clicks)

Goal: leave the owner's machine in a clean, working state with everything running, so the owner only has to click through three delegations and read the results.
**You prepare and verify. You do not do the owner's clicks, and you do not mark anything PASS that you did not see.** Do not kill Chrome. Never print `.env` values (keys only: `awk -F= '{print $1}' .env`).

## 1. Pull and reset
1. `git pull origin feature/scripted-replay`.
2. Reset the stack so no old seed data survives: `docker compose -f docker/docker-compose.yml down -v`, then `npm run stack:up && npm run seed && npm run seed:verify`, then `npm run index:knowledge`.
3. Prove the old number is gone: query the `knowledge_chunks` table (or run the check script) and confirm **no chunk contains "14 out of 20"** and that level 5 says 19 of 29. If it still appears, stop and report where.

## 2. Check the settings (keys only)
`.env` must define every key below with a non-empty value (copy from `docker/.env` after the seed where the example file says so). List which are missing; fill them if the value is a local demo value in `docker/.env`; if a value is a secret you cannot find, stop and ask the owner.
`GITEA_URL GITEA_TOKEN GITEA_ORG GITEA_REPO MATTERMOST_URL MATTERMOST_TOKEN MATTERMOST_TEAM MATTERMOST_CHANNEL MAILPIT_SMTP_HOST MAILPIT_SMTP_PORT MAILPIT_URL EMAIL_FROM`, plus the LLM keys the action agent needs.

## 3. Prove each connector works on its own (so a later failure is not setup)
Without Kaki's UI, call each service's API with the same settings Kaki uses and show it works:
- Gitea: create a throwaway issue titled `kaki-prep-check`, note its URL, then close it.
- Mattermost: post `kaki-prep-check` in the channel in `MATTERMOST_CHANNEL`.
- Mailpit: send one email through the SMTP settings to the demo inbox, and confirm it appears at `MAILPIT_URL`.
Report each as worked / failed with the exact error line.

## 4. Record the "before" facts (the earlier runs skipped this)
After step 3 and before the owner starts, write down: Mailpit message count, newest Gitea issue number, newest post in the Mattermost channel (text and time).

## 5. Start everything and bring the meeting to the state the owner needs
1. `KAKI_REPLAY=1 KAKI_REPLAY_SPEED=10 npm run dev 2>&1 | tee replay.log`, leave it running in the background.
2. Open `/screen` and the four `/phone?role=...` pages, and wait for the replay to finish (the closing line has appeared; about 3.5 minutes).
3. Confirm the Suggested column holds the tasks and nothing is dispatched yet. **Do not dispatch or claim anything.**

## 6. Write the owner's checklist: `docs/manual-check-todo.md`
Tell the owner, in plain steps with the exact URLs and task titles on screen:
1. On `/screen`, pick three Suggested tasks: one that should become a Gitea issue, one a Mattermost post, one an email. Press "Dispatch".
2. On each assignee's phone: "Let Kaki do it", wait for the draft (up to about 60 s), change one word, Approve.
3. For each, note: the draft text (does it say only what was said in the meeting?), the final status, and click the link: does it open the real issue, post or email?
4. Anything that fails or reads confusingly: copy the text exactly.
Add the "before" facts from step 4, and say which terminal windows are running so the owner does not start a second server.

## 7. Afterwards (when the owner says they are done)
Check the after state through the APIs: new Gitea issue number(s), new Mattermost post(s), new email(s) not in the "before" facts, and compare them with what the owner reported. Save the events again to `docs/replay-events/` and write `docs/manual-check-results.md`: each item as seen (quote text exactly), and say clearly where your API check and the owner's report disagree.

Commit and push everything (including the checklist) to `feature/scripted-replay`.
