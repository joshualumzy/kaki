# Status: Wingman and Action side (for the next session)

Branch `feature/scripted-replay`. Owner focus: Wingman, Action and the phone/`/demo` front end. The Host side (notetaker, shared screen, replay) belongs to the project owner's friend: do not work on it.

## Proven (with saved events)
Dispatch, claim, draft, edit, approve, run, link, mark done and sync, for Gitea, Mattermost and email; manual mode; failure then retry with no duplicate. Evidence: `docs/manual-check-results.md`, `docs/final-actions-results.md`, `docs/replay-events/`.

## Fixed this round
Company search drops a bad fact instead of failing; plain, on-topic answers with clean source labels; drafting prompts use only the task context; phone shows "Kaki is drafting/sending" instead of hiding the card; connection errors say what to do.

## Open
- **Five integrations are built:** Gitea, Mattermost, email (proven with saved events), wiki page (`wiki_page`) and calendar event (`calendar_event`). The wiki action passed its live check (`docs/new-actions-results.md`). The calendar link opens our own mock month-grid page at `/api/calendar/<id>`, with clickable events (the click fix, commit 99f4324, has NOT been re-checked live). Decision: no sixth integration (CRM skipped).
- **Calendar leftovers:** the mock calendar still holds duplicate test events from earlier checks (for example `followup-1.ics`). An agent should list the collection and delete the leftovers with `curl -X DELETE`, keeping the seeded `pixel-kampung.ics`.
- **Next batch (our side), then one combined test:** (1) phone shows "sending" for at least about a second; (2) Mattermost link needs a one-time login in the demo browser: clearer card or a fix; (3) one pass over the draft prompts of all five actions so none invent details.
- **For the Host owner (see `docs/notes-for-friend.md`):** add `wiki_page` and `calendar_event` to the notetaker prompt; show the link on the Done card on `/screen`; the replay problems listed there. Also review the shared files the Action side changed.
- Other branches with overlapping work, not merged: `feature/mock-crm-nocodb`, `feature/contextual-timestamps`.
- Light mode only (`data-theme="light"` in `web/index.html`).

## Working rules with agents
Agents prepare and verify with commands, APIs and saved events; the owner does every click. No browser automation. Reports must quote events and say NOT VERIFIED rather than PASS. Check the agent's claims against its raw event files.
- Git: the owner's remote is `personal` on the agent's machine (`origin` there is the group repo). Plain pushes only, no force; see the git safety rules in `AGENTS.md`. An earlier force push dropped a commit; check the remote still has every commit after any push.
