# Smoke test: do the Host and the Wingman work end to end?

Run this on your own machine (it needs Docker, the school LLM gateway and, for part B, a microphone). It tells you what already
works and what is missing, so each owner knows what to fix. No voice or AI attendees are needed for part A.

## Set up once

1. `npm install`, then copy `.env.example` to `.env` and fill in `KAKI_LLM_BASE_URL`, `KAKI_LLM_API_KEY`, `KAKI_LLM_MODEL`.
2. `npm run stack:up`, then `npm run seed` (writes `docker/.env` with the Gitea and Mattermost tokens), then `npm run seed:verify`.
3. Copy into `.env`: `GITEA_*`, `MATTERMOST_*`, `MAILPIT_*`, `EMAIL_FROM` and `POSTGRES_URL` from `docker/.env` (see `.env.example`).
4. `npm run index:knowledge`, then `npm run knowledge:check` (company search must pass before the Wingman can answer anything).

## Part A: replay, no voice

```bash
KAKI_REPLAY=1 KAKI_REPLAY_SPEED=10 npm run dev
```

The Host plays `scenarios/pixel-kampung/replay/transcript.json` (52 lines, about 2 minutes at 10x). Open the shared screen
`http://localhost:5173/screen` and one phone page per role: `http://localhost:5173/phone?role=producer`, `lead_programmer`,
`game_designer`, `marketing_lead`. Start the replay (restart the server) after the pages are open, and watch.

What a working system shows (`scenarios/pixel-kampung/replay/expected.json` is the Host's own answer key):

| # | Check | Where | Owner if it fails |
|---|---|---|---|
| 1 | The agenda clock starts on the first line, advances through the four items, and talk time shows per role | screen | Host |
| 2 | Host speech lines appear: opening, "next up", time-out warnings, closing | screen | Host |
| 3 | The notetaker proposes tasks: a crash bug for `lead_programmer`, a launch-date post for `producer`, a streamer email for `marketing_lead` | each phone | Host |
| 4 | Open questions are found: where players quit (level 5), the final-build date | screen / phones | Host |
| 5 | `marketing_lead` is flagged quiet | marketing phone | Host |
| 6 | "Coming up" and "owner has been quiet" nudges arrive | owning role's phone | Wingman |
| 7 | Answers appear with sources: level 5 quit numbers (Postgres or Mattermost), the final build date, which should surface the wiki saying 20 Nov against Starfruit's email saying 17 Nov | the asking role's phone | Wingman |
| 8 | A phone can claim a task (`ACTION_AGENT` or manual) | phone | Wingman |
| 9 | An action draft appears: Gitea issue, Mattermost post, or email; edit the text, then approve | phone | Wingman |
| 10 | After approval the thing really exists: an issue in Gitea (`:8082`), a post in the `#launch` channel (`:8083`), an email in Mailpit (`:8084`) | those apps | Wingman |
| 11 | A failed action shows a clear message and can be retried | phone | Wingman |
| 12 | Mark done and sync work, and the shared screen shows the task states | phone, screen | Wingman |

There is no calendar action: only `gitea_issue`, `mattermost_post` and `email` exist.

## Part B: the live meeting

Same checks, fed by the live conversation instead of the replay. Start the server without `KAKI_REPLAY`:

```bash
npm run dev          # one terminal
npm run npc          # another
```

Open `http://localhost:5173/demo`, join as one role, and have a short meeting, for example: say that the build crashes after
ten customers in a row, ask what the final build date is, and ask the Producer's AI to post the launch date in Mattermost. Also open
`/screen` and the `/phone?role=...` page for your role. Check 1 to 5 again against what you actually said (the notetaker needs a
pause or a few lines before it reacts, about 7 s by default), then 6 to 12.

Things only part B can show: whether the AI attendees' own lines are treated sensibly by the notetaker (they are posted as transcript
lines too), and whether the Wingman panel in `/demo` (right-hand side) behaves like the phone page.

## Write down

For each failed row: what you saw, the server log line (look for `kaki host:` and `kaki wingman:` messages), and the row number.
Host rows go to the Host owner, Wingman rows are yours. If a log says `nudges disabled (missing ...)` or `company search is disabled`,
that is setup (step 3 or 4), not a bug.
