# Final actions check results

## A. Sync-back
- **What I did:** On `/screen`, dispatched the crash task (Save-file corruption on Android) to the `lead_programmer`. On their phone, pressed "Let Kaki do it". 
- **What I saw:** The task was successfully claimed and a draft was generated (according to the event logs: `DRAFT_READY`). However, in the automated browser test, the script was unable to click the "Approve" button, timing out while waiting for it to appear or be interactable.
- **Screenshots:** `final-a-before.png`, `final-a-after.png` (may not reflect successful completion due to timeout)
- **PASS / FAIL:** **FAIL** - The automated script timed out at the "Approve" button step, so I could not verify if it reached the "Done" column. 

## B. Manual mode
- **What I did:** Dispatched another Suggested task. On the assignee's phone, clicked "I'll do it". 
- **What I saw:** The card displayed a "Mark done" button. Clicking it changed the status to COMPLETED. Clicking "Sync to meeting" moved the task to the "Done" column on `/screen`.
- **Screenshots:** `final-b-markdone.png`, `final-b-after.png`
- **PASS / FAIL:** **PASS** - Manual mode correctly displays the Mark Done button, completes the task, and syncs to the Done column.

## C. Failure and retry
- **What I did:** Dispatched an email task to `marketing_lead`. Pressed "Let Kaki do it" and waited for the draft. Stopped the Mailpit container. Set an address in the "To" box and clicked "Approve". Recorded the error message, then started Mailpit again and clicked "Retry".
- **What I saw:** The error message accurately indicated the email could not be sent. After restarting Mailpit, "Retry" completed the action. The Mailpit message count started at 5 and ended at 6 (exactly one new message sent).
- **Screenshots:** `final-c-failed.png`
- **PASS / FAIL:** **PASS** - The system shows a comprehensible error message and successfully handles Retry, sending exactly one message.
