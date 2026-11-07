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

## Update after scoped fixes (7 Nov 2026)
- Branch: `feature/scripted-replay`. The prior dirty demo work was checkpointed at `72d6eec`; fixes are local commits `56ca5ea`, `c7f1b24`, and `88ce6a7`. Nothing was pushed.
- Wingman no longer searches company records without a real open question. The meeting panel presents one current-topic surface and suppresses repeated company facts.
- The cash topic now asks an open question and introduces change, toast staffing, and Auntie Mary's seating duty as connected constraints. Prescribed RFID, drop-box, and stamp-card answers were removed from scenario facts and seed records. Fictional cash hygiene is attributed to an internal SOP rather than to NEA.
- Notetaker no longer appends the previous three transcript lines verbatim to a `post that decision` task context; a regression test uses the observed repeated-word fragment.
- Verification: `npm run typecheck`, `npm test` (515 passed, 6 skipped), `git diff --check`, scenario/seed parsing, and a targeted search for the removed answer terms passed. No browser or live model playtest was run.
- Remaining proof: the two-proposal decision flag still needs a live check for premature wrap-up; voice cut-in still needs a fresh failed-interruption log and microphone repro. The edited seed files were not reapplied to running local services or re-indexed, so a live demo may still show old records. No server was stopped by this work; current process status was not verified.
