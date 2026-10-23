# Scenarios

Each scenario lives in its own folder.

- `scenario.json` (required) — roles, attendees and agenda. Validated at startup.
- `demo-events.json` — sample events and tasks for `npm run emit-demo`.
- `seed/` — later: fake company data for Wingman.
- `replay/` — later: scripted transcript for Host.

Switch scenarios by setting `SCENARIO=<folder>` (default: `pixel-kampung`).
