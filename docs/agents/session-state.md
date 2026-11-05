# Where the project stands (written for a fresh Claude session; 2026-11-05)

Read `AGENTS.md` first (remote rules: cloud Claude pushes `origin`, the owner's Mac uses `personal`; Claude may push to `origin` whenever appropriate), then `docs/agents/priorities.md` (the long dated log of what was built and why) and `docs/agents/free-agent-tasks.md` (steps for the local agent, including Task D, the multi-person test).

Branch: `feature/scripted-replay`. Nothing built since the third live run has been heard live; everything is unit-tested only (478 tests, `npx tsc -b` clean). Sandbox note: this cloud session has no LLM key, Azure key or microphone, so it cannot run evals or voice tests.

## What the live demo is
`/demo`: a visitor joins a LiveKit room with AI attendees (Arjun, Mei, Daniel, Sam as host; Wei Ling when not the visitor's seat), talks by voice (Azure speech), and sees Kaki Wingman (private, per role) and Kaki Host (shared) in a dock. A notetaker turns what is said into tasks, Kaki runs them (Gitea, Mattermost, email, calendar).

## Built and unit-tested, not heard live
- Visitor context: situation card, role card, short welcome naming what the visitor answers for.
- Meeting code join gate (first person free, later people need the 4-character code; `KAKI_MEETING_CODE` fixes it), phone layout (Meeting/Kaki switch under 700 px).
- Noise filter at speech-to-text (`NPC_STT_MIN_CONFIDENCE`, default 0.6), deferred barge-in (`NPC_BARGE_IN_MS`, default 900), "Your turn" banner.
- Items adapt to the visitor's role: `observe` (characters talk it through, plain words), `involve` (the host hands the item over and asks for a next step and date), `decide` (a `contested` item: opposing sides, then the visitor decides). `itemMode` in `shared/src/demo.ts`; agenda `decision`, `contested`, scenario `glossary`.
- Plain-language rules in the prompts; accept/decline lines are statements only; AI colleagues are asked without the phone line; Host feed shows only "Kaki noticed a task".
- `KAKI_CLOCK_SPEED` shortens a live agenda (the replay data was deliberately not changed).

## Known open
- The notetaker prompt got a "asking someone to summarise in the meeting is not a task" rule that has NOT been through the evals (`docs/agents/tuning-loop.md`; needs a model key). Keep it only if it holds 3 of 3.
- Barge-in: the real cause of the AI restarting itself in the last live run may be the echo estimate (mic peak 0.2 vs an estimated echo 0.02); try headphones and `NPC_DEBUG_VAD=1`.
- Whether the observe/involve/decide flow, the plain language and the host's questions sound natural is unknown until the next live run. The owner will report with exact lines; tune the prompts against them.
- Dispatch cue can be dropped if the room stays busy for 20 s (`DEFAULT_ANNOUNCE_GIVE_UP_MS`).
- Task A recheck of earlier failures (company search, Gitea draft, launch-date task, open questions showing 0) is for an agent with keys.
- Not built: separate rooms per meeting code (one meeting at a time), a task built in per role (deliberately emergent).

## Next
1. The owner runs the one-person live test (checklist given in chat; steps equal Task D with one person) and sends exact lines, the `grep` of `.live-logs/npc.log` for `dropped|ignored|failed|accepts|declines|handed over`, and what felt unnatural.
2. Claude fixes what it shows, batching fixes, testing less often.
3. Then the two-human test (Task D) when a second person is available.
