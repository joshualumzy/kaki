# Kopitiam live diagnosis — 7 Nov 2026

## Done
- Inspected current `feature/scripted-replay` checkout without changing application code. Worktree already had many unrelated uncommitted changes; preserve them.
- Read current demo handoff, source, saved logs, live read-only `/ws?role=screen` state, and user's 19:55 screenshot/transcript.
- The cash topic is one-shot: the opening already says the NEA constraint, and scenario role/NPC facts plus the proactive company lookup reveal the RFID/cash workaround before the visitor weighs in.
- `MeetingPanel.tsx` renders both `CurrentTopicCard` and `From the company records`; the latter is shown after a loose briefing gate. Duplicate filtering can fall back to repeated facts. `knowledge/module.ts` searches proactively on an agenda item with no open question.
- Screenshot shows the visitor suggested separating cash collection from food prep. Arjun first misread this as moving the counter; after fragmented speech, he accepted moving a cash box. The live retained `DISPATCHED` task context includes the verbatim fragments, including `Whatever that that that that box. Away from the food, right?` and Arjun's paraphrase. It has no saved draft body; the screenshot is a task request, not an action draft.
- Saved `.live-logs/npc.log` ends 6 Nov 23:25 and `.live-logs/events-live.jsonl` ends 7 Nov 09:15, before the 19:37 task. They cannot diagnose today's failed voice interruption. `TypeBar.tsx` still sends `stop`; `runner.ts` still handles it. `EnergyVad.close()` resets state and does not permanently disable detection. Need fresh NPC log during a failed cut-in to locate the fault.
- At inspection, local web and server endpoints both returned HTTP 200. No server was stopped by this diagnosis; current NPC process status was not verified.
- Read-only `worker deepseek` was run for panel diagnosis; daemon restart lost its session. A bounded `HERDR_ENV=0 worker deepseek` retry timed out (exit 124). Both produced partial output only, so conclusions above are independently checked rather than accepted from the worker. No application edits by worker were requested.

## Next
- Tell the user the screenshot confirms a task-context quality bug and repeated/early Wingman facts; do not claim the exact voice-interruption cause yet.
- If asked to fix, coordinate a scoped implementation while preserving the dirty worktree: one relevant Wingman context surface, evidence only when new and relevant, task context that omits raw speech fragments and verifies the decision, and a fresh interruption log/repro.
- Browser UI control requires fresh explicit consent under AGENTS.md. Use installed Chrome for Playwright if authorized.
