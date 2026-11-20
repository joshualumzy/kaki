# Scenarios

Kaki is scenario-agnostic: every role, attendee, NPC personality, agenda item, and company dataset is loaded from `scenarios/<id>/`.

The shipped scenario is `SCENARIO=kopitiam` (`scenarios/kopitiam/`): **Nanyang Kopi & Toast** reopening its Raffles Place flagship tomorrow morning (Operations Director, Tech & POS Lead, Menu & Store Experience Lead, Marketing Lead, General Manager).

## Scenario Folder Layout

- `scenario.json` (required) — Roles (with private `card` briefings), attendees, AI `npcs` (Azure TTS voice, personality, agenda, concerns), and the pool of agenda items.
  - In live `/demo` booth meetings, Kaki selects a crisp **2-item agenda** (`KAKI_AGENDA_ITEMS`, default `2`, 2 minutes per item) tailored to the visitor's chosen role so every session completes in ~3–4 minutes.
- `seed/` — Company records loaded by `npm run seed` and indexed by `npm run index:knowledge`:
  - `seed/gitea/issues.json` — Open and closed Gitea issues
  - `seed/mattermost/seed.json` — Channels and team threads
  - `seed/mail/emails.json` — Inbox messages in Mailpit
  - `seed/postgres/schema.sql` & `data.sql` — Structured SQL metrics
  - `seed/wiki/pages.json` & `*.md` — Team wiki pages
- `replay/` — Scripted transcript (`transcript.json`) and expected extraction benchmark (`expected.json`).
