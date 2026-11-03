# New actions check todo

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

---
*Before Facts:*
- Wiki pages list: `hawker-heroes/game-design`, `hawker-heroes/publisher-contract`, `hawker-heroes/booth-rules`, `random/lunch-spots`
- Radicale `/user/calendar/` has 2 events (launch readiness & follow-up).