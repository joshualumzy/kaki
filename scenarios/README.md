# Scenarios

Kaki is scenario-agnostic: every role, attendee, NPC personality, agenda item, and company dataset is loaded from `scenarios/<id>/`.

Switch scenarios via the `SCENARIO` environment variable:
- **`SCENARIO=kopitiam`** (`scenarios/kopitiam/`) — **Nanyang Kopitiam Co.** (Flagship Changi Jewel outlet launch sync: Operations Lead, Lead Programmer, Brand & Marketing Lead, Master Roaster & Chef, Finance & Procurement Lead).
- **`SCENARIO=pixel-kampung`** (`scenarios/pixel-kampung/`, default) — **Lah Studios** (*Hawker Heroes* pre-launch sync: Studio Manager, Producer, Lead Programmer, Game Designer, Marketing Lead).

## Scenario Folder Layout

- `scenario.json` (required) — Roles (with private `card` briefings), attendees, AI `npcs` (Azure TTS voice, personality, agenda, concerns), and the pool of agenda items.
  - In live `/demo` booth meetings, Kaki selects a crisp **2-item agenda** (`KAKI_AGENDA_ITEMS`, default `2`, 2 minutes per item) tailored to the visitor's chosen role so every session completes in ~3–4 minutes.
- `seed/` — Company records loaded by `npm run seed` and indexed by `npm run index:knowledge`:
  - `seed/gitea/issues.json` — Open and closed Gitea issues
  - `seed/mattermost/seed.json` — Channels and team threads
  - `seed/mail/emails.json` — Inbox messages in Mailpit
  - `seed/postgres/schema.sql` & `data.sql` — Structured SQL metrics
  - `seed/wiki/pages.json` & `*.md` — Team wiki pages
- `demo-events.json` — Sample events and tasks for `npm run emit-demo`.
- `replay/` — Scripted transcript (`transcript.json`) and expected extraction benchmark (`expected.json`).
