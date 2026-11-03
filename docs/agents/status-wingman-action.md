# Status: Wingman and Action side (for the next session)

Branch `feature/scripted-replay`. Owner focus: Wingman, Action and the phone/`/demo` front end. The Host side (notetaker, shared screen, replay) belongs to the project owner's friend: do not work on it.

## Proven (with saved events)
Dispatch, claim, draft, edit, approve, run, link, mark done and sync, for Gitea, Mattermost and email; manual mode; failure then retry with no duplicate. Evidence: `docs/manual-check-results.md`, `docs/final-actions-results.md`, `docs/replay-events/`.

## Fixed this round
Company search drops a bad fact instead of failing; plain, on-topic answers with clean source labels; drafting prompts use only the task context; phone shows "Kaki is drafting/sending" instead of hiding the card; connection errors say what to do.

## Done since the last note
Notetaker prompt knows `wiki_page`/`calendar_event`, always sets `actionKind`, fuzzy question dedupe, drops non-questions. Done card on `/screen` shows the artifact link; Mattermost login note on the card. Phone "sending" state held >= 1.2 s from the Approve click. Opening welcome line (retained for late screens). Typecheck is clean. Combined check run: `docs/combined-check-results.md`, `docs/combined-check-followup-results.md`, events in `docs/replay-events/combined*.jsonl`. Calendar leftovers cleaned.

## Open
- **Notetaker tuning (needs the real LLM, `npm run eval:notetaker`):** near-duplicate tasks across roles (three patience-timer tasks), product work suggested as tasks, launch-date post assigned to marketing_lead instead of producer, eval FAIL (crash bug twice, missing launch-date post, two missing questions; the live run does ask them, so the eval's check may be too strict). The nudge can quote the old contract build date (20 Nov) instead of the newer email (17 Nov).
- **Next steps, in order:** (1) ~~the host's spoken cues voiced through Sam~~ done in code (`NpcConversation.announce`, `followHostCues` in `npc/main.ts`; not yet heard live: needs `npm run npc` plus a person in `/demo`, and the opening is spoken after the person's first words because that is when the Host publishes it); (2) ~~dispatch flow~~ decided and built: Sam auto-dispatches each new task to the role the notetaker named (`host/autoDispatch.ts`, off with `KAKI_AUTO_DISPATCH=0`), says it aloud (`HOST_SPEECH_TRIGGERED` kind `DISPATCH`), and the recipient accepts (claim) or declines (`DECLINE_TASK`: back to SUGGESTED, nobody assigned, `declinedBy` set, so a person can re-offer it from `/screen`). Facilitator roles and roles nobody plays stay SUGGESTED. Open: a task for a role played by an AI attendee has no phone to accept it, so those need a rule (for example Sam keeps them on the screen); (3) one combined meeting page: video plus toggles for the shared-screen panel and the personal Wingman panel; (4) cloud deploy.
- **Cloud plan (Azure):** a new dedicated VM `kaki-vm`, Ubuntu 24.04, Standard B2s_v2 (resize to D4s_v4 only for demos), Southeast Asia, public IP 20.212.144.1, name `kaki.southeastasia.cloudapp.azure.com`, auto-shutdown on. Inbound 22/80/443 open. Do NOT open the LiveKit ports yet: `docker-compose.yml` runs LiveKit with `--dev` (public dev keys); write a production LiveKit config (real keys, public IP setting), Dockerfiles, compose and a Caddy HTTPS config, then give one final list of ports. Mattermost auto-login only after the deploy shares one domain.
- **For the Host owner (`docs/notes-for-friend.md`):** review the shared files the Action side changed. Ask what they intend for the spoken cues and for `/screen` (read-only view vs the Dispatch/Dismiss buttons it has now).
- Other branches with overlapping work, not merged: `feature/mock-crm-nocodb`, `feature/contextual-timestamps`.
- Light mode only (`data-theme="light"` in `web/index.html`).

## Working rules with agents
Agents prepare and verify with commands, APIs and saved events; the owner does every click. No browser automation. Reports must quote events and say NOT VERIFIED rather than PASS. Check the agent's claims against its raw event files.
- Git: the owner's remote is `personal` on the agent's machine (`origin` there is the group repo). Plain pushes only, no force; see the git safety rules in `AGENTS.md`. An earlier force push dropped a commit; check the remote still has every commit after any push.
