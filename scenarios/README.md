# Scenarios

Each scenario lives in its own folder.

- `scenario.json` (required) — roles, attendees and agenda. Validated at startup. Optional `npcs` makes some attendees AI attendees for the live demo meeting (`/demo`): each has `attendee` (an attendee's `name`), `voice` (an Azure text-to-speech voice), `personality`, `agenda`, `concerns` and optionally `knows`.
- `demo-events.json` — sample events and tasks for `npm run emit-demo`.
- `seed/` — later: fake company data for Wingman.
- `replay/transcript.json` — scripted, speaker-tagged transcript (`at` = seconds from the start, `speaker` = an attendee's Zoom name). Play it with `KAKI_REPLAY=1` (and `KAKI_REPLAY_SPEED=10` to speed it up).

Switch scenarios by setting `SCENARIO=<folder>` (default: `pixel-kampung`).
