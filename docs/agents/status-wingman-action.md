# Status: Wingman and Action side (for the next session)

Branch `feature/scripted-replay`. Owner focus: Wingman, Action and the phone/`/demo` front end. The Host side (notetaker, shared screen, replay) belongs to the project owner's friend: do not work on it.

## Proven (with saved events)
Dispatch, claim, draft, edit, approve, run, link, mark done and sync, for Gitea, Mattermost and email; manual mode; failure then retry with no duplicate. Evidence: `docs/manual-check-results.md`, `docs/final-actions-results.md`, `docs/replay-events/`.

## Fixed this round
Company search drops a bad fact instead of failing; plain, on-topic answers with clean source labels; drafting prompts use only the task context; phone shows "Kaki is drafting/sending" instead of hiding the card; connection errors say what to do.

## Open
- Done card on `/screen` shows no link (Host's folder: ask the friend).
- Host problems seen in replay (friend's list): too many and duplicate open questions, missing build-date question, nudge states the wrong build date, no real opening line, `actionKind` and thin task context.
- Mattermost links need a one-time login in the demo browser.
- Optional: calendar (`docs/calendar-check.md`, branch `feature/caldav-ingestion`), other new actions (wiki summary).
- Other branches with overlapping work, not merged: `feature/mock-crm-nocodb` (hybrid RAG search), `feature/contextual-timestamps`.

## Working rules with agents
Agents prepare and verify with commands, APIs and saved events; the owner does every click. No browser automation. Reports must quote events and say NOT VERIFIED rather than PASS. Check the agent's claims against its raw event files.
