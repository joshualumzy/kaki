# Final actions check results

## A. Sync-back
**Events Seen:**
```json
{"type":"TASK_UPDATED","audience":{"kind":"screen"},"payload":{"task":{"id":"task-d3020c99-045e-4b4d-a2c1-a52e8e2d79ee","title":"File bug ticket for ten-customer crash","context":"The game crashes when ten customers are present in the satay stall level.","suggestedAssignee":"lead_programmer","actionKind":"gitea_issue","status":"DRAFT_READY","updatedAt":"2026-11-03T15:14:45.073Z","assignee":"lead_programmer","draft":{"target":"pixel-kampung/hawker-heroes","subject":"File bug ticket for ten-customer crash","body":"The game crashes when there are ten customers present in the satay stall level."},"mode":"ACTION_AGENT"}}}
```
*(Note: Initial Gitea token issue caused a 401 error; after manual restart of the server, the owner completed it).*

**API Check:**
New Gitea Issue: 10 (Before was 9).
URL created: `http://127.0.0.1:8082/pixel-kampung/hawker-heroes/issues/10`

**Owner's Report:**
"yes both tasks moved to done column. but done card does not show clickable link"

**Result: FAIL**
Reason: The task moves to the Done column on the `/screen`, but the Done card does not render the `artifactUrl` as a clickable link.

## B. Manual mode
**Events Seen:**
```json
{"type":"TASK_UPDATED","audience":{"kind":"screen"},"payload":{"task":{"id":"task-1610ebd0-ef4f-407a-8cc8-55a658825395","title":"Send milestone report to Starfruit","context":"The producer will send the milestone report to the publisher this week.","suggestedAssignee":"producer","actionKind":"email","status":"SYNCED","updatedAt":"2026-11-03T15:59:20.420Z","assignee":"producer","mode":"MANUAL"}}}
```
*(Transitions: DISPATCHED -> CLAIMED (mode MANUAL) -> COMPLETED -> SYNCED).*

**Owner's Report:**
"yes both tasks moved to done column."

**Result: PASS**

## C. Failure and retry
**Events Seen:**
```json
{"type":"TASK_UPDATED","audience":{"kind":"screen"},"payload":{"task":{"id":"task-ac507c8c-676c-4086-ae70-e0fb9aab4e99","title":"Email a streamer about playing Hawker Heroes","context":"Wei Ling asked Daniel to email a streamer and ask them to play Hawker Heroes on launch day.","suggestedAssignee":"marketing_lead","actionKind":"email","status":"FAILED","updatedAt":"2026-11-03T16:01:05.707Z","assignee":"marketing_lead","draft":{"target":"streamer@example.com","subject":"Request for Hawker Heroes Gameplay","body":"Hi, I'm reaching out from Wei Ling's team. We're interested in having you play Hawker Heroes on its launch day. Would that be something you'd be available and willing to do?"},"mode":"ACTION_AGENT","error":"could not send the email: connect ECONNREFUSED 127.0.0.1:1025"}}}
{"type":"TASK_UPDATED","audience":{"kind":"screen"},"payload":{"task":{"id":"task-ac507c8c-676c-4086-ae70-e0fb9aab4e99","title":"Email a streamer about playing Hawker Heroes","context":"Wei Ling asked Daniel to email a streamer and ask them to play Hawker Heroes on launch day.","suggestedAssignee":"marketing_lead","actionKind":"email","status":"RUNNING","updatedAt":"2026-11-03T16:01:41.971Z","assignee":"marketing_lead","draft":{"target":"streamer@example.com","subject":"Request for Hawker Heroes Gameplay","body":"Hi, I'm reaching out from Wei Ling's team. We're interested in having you play Hawker Heroes on its launch day. Would that be something you'd be available and willing to do?"},"mode":"ACTION_AGENT"}}}
{"type":"TASK_UPDATED","audience":{"kind":"screen"},"payload":{"task":{"id":"task-ac507c8c-676c-4086-ae70-e0fb9aab4e99","title":"Email a streamer about playing Hawker Heroes","context":"Wei Ling asked Daniel to email a streamer and ask them to play Hawker Heroes on launch day.","suggestedAssignee":"marketing_lead","actionKind":"email","status":"COMPLETED","updatedAt":"2026-11-03T16:01:42.110Z","assignee":"marketing_lead","draft":{"target":"streamer@example.com","subject":"Request for Hawker Heroes Gameplay","body":"Hi, I'm reaching out from Wei Ling's team. We're interested in having you play Hawker Heroes on its launch day. Would that be something you'd be available and willing to do?"},"mode":"ACTION_AGENT","artifactUrl":"http://127.0.0.1:8084/view/mzb66Q7Z5qBs2ZLTYkF4Dy"}}}
```

**API Check:**
Mailpit message count: 7 (Before was 6, went up by exactly one).

**Owner's Report:**
"could not send the email: connect ECONNREFUSED 127.0.0.1:1025 no i dont think its understandable"

**Result: FAIL**
Reason: While the retry mechanic functions perfectly and avoids duplicate sending (as shown by exactly 1 increment in Mailpit message count), the error message shown to the user is a raw Node.js `ECONNREFUSED` dump which is not understandable to a non-technical person.
