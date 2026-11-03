# Combined Check Results

## Owner Answers

**Mattermost Task:**
- Does the draft contain any detail that is not in the task? no
- Do the dots stay on screen for about a second or more before the card changes? no
- Does a note say Mattermost may ask you to log in? yes
- Click "Open artifact". Does the post open? yes
- Is there an "Open artifact" link on the finished task? yes

**Calendar Task:**
- Write the Start line from the draft: `Start: 2026-11-13 10:00`
- Month grid for November 2026? yes
- Click the event "Hawker Heroes launch readiness": do its details appear? yes
- Is your new event highlighted? yes

**Wiki Task:**
- Does the draft contain any detail not in the task? no
- Does the wiki link open the page? yes

**Meeting Replay:**
- Opening line: `Next up: Level 5 difficulty and playtest feedback.`
- How many open questions are shown? 0 at the end.
- Did the suggested tasks include a wiki or calendar one at any point? no

## Verifications from Events and APIs

**Tasks:**
- Mattermost task:
  - `RUNNING`: `{"type":"TASK_UPDATED","audience":{"kind":"screen"},"payload":{"task":{"id":"task-01653f1d-3415-432a-9814-d45675c42f01","title":"Post the new opening hours in the team channel","context":"Post the new opening hours for the launch week in the team channel.","suggestedAssignee":"producer","actionKind":"mattermost_post","status":"RUNNING","updatedAt":"2026-11-03T21:02:12.177Z","assignee":"producer","draft":{"target":"#launch","subject":"Post the new opening hours in the team channel","body":"New opening hours posted in team channel"},"mode":"ACTION_AGENT"}}}`
  - `COMPLETED`: `{"type":"TASK_UPDATED","audience":{"kind":"screen"},"payload":{"task":{"id":"task-01653f1d-3415-432a-9814-d45675c42f01","title":"Post the new opening hours in the team channel","context":"Post the new opening hours for the launch week in the team channel.","suggestedAssignee":"producer","actionKind":"mattermost_post","status":"COMPLETED","updatedAt":"2026-11-03T21:02:12.224Z","assignee":"producer","draft":{"target":"#launch","subject":"Post the new opening hours in the team channel","body":"New opening hours posted in team channel"},"mode":"ACTION_AGENT","artifactUrl":"http://127.0.0.1:8083/pixel-kampung/pl/pabe3qhe5fnimdoun4nraqzwuh"}}}`
  - Draft text vs task context: no extra details
- Calendar task:
  - `RUNNING`: `{"type":"TASK_UPDATED","audience":{"kind":"screen"},"payload":{"task":{"id":"task-cf1a0d87-22e0-4082-bca2-7ba0ea08888e","title":"Schedule a follow-up with Starfruit next Friday","context":"Confirm the final build date with Starfruit. Next Friday at 10:00 for half an hour.","suggestedAssignee":"producer","actionKind":"calendar_event","status":"RUNNING","updatedAt":"2026-11-03T21:04:45.243Z","assignee":"producer","draft":{"target":"Team calendar","subject":"Schedule a follow-up with Starfruit","body":"Start: 2026-11-13 10:00\nDuration: 30 minutes\n\nConfirm the final build date with Starfruit."},"mode":"ACTION_AGENT"}}}`
  - `COMPLETED`: `{"type":"TASK_UPDATED","audience":{"kind":"screen"},"payload":{"task":{"id":"task-cf1a0d87-22e0-4082-bca2-7ba0ea08888e","title":"Schedule a follow-up with Starfruit next Friday","context":"Confirm the final build date with Starfruit. Next Friday at 10:00 for half an hour.","suggestedAssignee":"producer","actionKind":"calendar_event","status":"COMPLETED","updatedAt":"2026-11-03T21:04:45.299Z","assignee":"producer","draft":{"target":"Team calendar","subject":"Schedule a follow-up with Starfruit","body":"Start: 2026-11-13 10:00\nDuration: 30 minutes\n\nConfirm the final build date with Starfruit."},"mode":"ACTION_AGENT","artifactUrl":"http://127.0.0.1:3001/api/calendar/task-cf1a0d87-22e0-4082-bca2-7ba0ea08888e"}}}`
  - Draft text vs task context: no extra details
- Wiki task:
  - `RUNNING`: `{"type":"TASK_UPDATED","audience":{"kind":"screen"},"payload":{"task":{"id":"task-984f9c9b-860f-4b7a-89bd-84587216c024","title":"Write up the meeting decisions on the wiki","context":"Decisions: the launch date stays. The final build is still to be confirmed.","suggestedAssignee":"producer","actionKind":"wiki_page","status":"RUNNING","updatedAt":"2026-11-03T21:06:19.477Z","assignee":"producer","draft":{"target":"Wiki: meeting notes","subject":"Meeting Decisions","body":"# Meeting Decisions\n\n## Launch Date\nThe launch date will remain as previously decided.\n\n## Final Build Confirmation\nThe status of the final build remains unconfirmed."},"mode":"ACTION_AGENT"}}}`
  - `COMPLETED`: `{"type":"TASK_UPDATED","audience":{"kind":"screen"},"payload":{"task":{"id":"task-984f9c9b-860f-4b7a-89bd-84587216c024","title":"Write up the meeting decisions on the wiki","context":"Decisions: the launch date stays. The final build is still to be confirmed.","suggestedAssignee":"producer","actionKind":"wiki_page","status":"COMPLETED","updatedAt":"2026-11-03T21:06:21.566Z","assignee":"producer","draft":{"target":"Wiki: meeting notes","subject":"Meeting Decisions","body":"# Meeting Decisions\n\n## Launch Date\nThe launch date will remain as previously decided.\n\n## Final Build Confirmation\nThe status of the final build remains unconfirmed."},"mode":"ACTION_AGENT","artifactUrl":"http://127.0.0.1:8081/en/meetings/2026-11-03-meeting-decisions"}}}`
  - Draft text vs task context: no extra details

**Sending Hold:**
- Mattermost: RUNNING `21:02:12.177Z`, COMPLETED `21:02:12.224Z` (Difference ~47ms).
- Calendar: RUNNING `21:04:45.243Z`, COMPLETED `21:04:45.299Z` (Difference ~56ms).
- Wiki: RUNNING `21:06:19.477Z`, COMPLETED `21:06:21.566Z` (Difference ~2.1s).
*(The 1.2-second hold is in the browser only, so mark it "owner's answer only".)*

**API Checks:**
- Wiki link: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/en/meetings/2026-11-03-meeting-decisions` -> `200`
- Calendar link: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/calendar/task-cf1a0d87-22e0-4082-bca2-7ba0ea08888e` -> `200`
- Calendar content contains required strings: `November 2026`, `Hawker Heroes launch readiness`, `class="chip focus"` (verified via `grep`).

**Calendar Collection:**
- `curl -s -X PROPFIND -H 'Depth: 1' http://127.0.0.1:5232/user/calendar/ | grep -o '<href>[^<]*\.ics</href>' | sed 's/<[^>]*>//g'`
- Result:
  `/user/calendar/task-cf1a0d87-22e0-4082-bca2-7ba0ea08888e.ics`
  `/user/calendar/pixel-kampung.ics`

**Screen Events:**
- Opening `HOST_SPEECH_TRIGGERED` text: `{"type":"HOST_SPEECH_TRIGGERED","audience":{"kind":"screen"},"payload":{"kind":"OPENING","text":"Next up: Level 5 difficulty and playtest feedback."}}`
- `openQuestions` texts in `MEETING_RECORD_UPDATED`:
  - `What's the current status of the crash issue?`
  - `What's the order queue issue?`
  - `Can the tutorial skip go in before the playtest on Friday?`
  - `Did we get the updated booth dimensions?`
  - `Has Daniel checked the organiser email for the booth size?`
  - `Do we have the budget for stickers?`
  - `Can we give out stickers at the booth?`
  - `Do they need the store page text from us too?`
  - `Someone who does cozy and cooking games`
- Does any pair repeat? yes (`Did we get the updated booth dimensions?` and `Has Daniel checked the organiser email for the booth size?` ask the same thing).
- Final-build question appears? no (not captured in events).
- Suggested tasks:
  - `mattermost_post`
  - `calendar_event`
  - `wiki_page`
  - `gitea_issue`
  - `gitea_issue`
  - `gitea_issue`
  - `email`

**Eval Notetaker:**
- output: NOT VERIFIED

## Grading

- **Mattermost draft:** PASS
- **Sending hold:** FAIL (owner confirmed no 1.2s delay)
- **Mattermost link and note:** PASS
- **Done-card link:** PASS
- **Calendar date:** PASS
- **Calendar grid + click:** PASS
- **Wiki draft + link:** PASS
- **Opening line:** PASS
- **Duplicate questions:** FAIL (Duplicate questions appeared during the meeting replay)
- **actionKind:** PASS (all SUGGESTED tasks have actionKinds set)

