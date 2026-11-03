# Final actions check todo

Role ids are exactly `producer`, `lead_programmer`, `game_designer`, `marketing_lead`. Phone pages are `http://localhost:5173/phone?role=<id>`; the shared screen is `http://localhost:5173/screen`. Log in to Mattermost once in your browser first (http://localhost:8083).

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

---
*URLs to open:*
- Screen: http://localhost:5173/screen
- Producer: http://localhost:5173/phone?role=producer
- Lead Programmer: http://localhost:5173/phone?role=lead_programmer
- Game Designer: http://localhost:5173/phone?role=game_designer
- Marketing Lead: http://localhost:5173/phone?role=marketing_lead

*Before Facts:*
- Newest Gitea issue: 9
- Mailpit message count: 6
- Newest Mattermost post: "kaki-prep-check" at 2026-11-03T15:20:57.215Z
