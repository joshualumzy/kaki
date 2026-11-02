# Smoke test: do the Host and the Wingman work end to end?

Run this on your own machine (it needs Docker, the school LLM gateway and, for part B, a microphone). Its job is to produce **evidence**:
what works, what does not, and the exact log lines for each failure, so the Host and Wingman owners can fix them without guessing.

Rules for whoever runs it (a person or an AI agent):

- Do not print or paste `.env` values, tokens or keys anywhere. Paste log lines only after checking they contain none.
- Do not fix anything while running. Observe and record. Fixing changes the evidence.
- Every row ends as exactly one of `PASS`, `FAIL` or `NOT RUN` (say why). Never leave a row blank, never write "seems fine".
- Write the results to `docs/smoke-test-results.md` using the template at the bottom, commit it to `feature/scripted-replay` and push.

## Set up once

1. `npm install`, then copy `.env.example` to `.env` and fill in `KAKI_LLM_BASE_URL`, `KAKI_LLM_API_KEY`, `KAKI_LLM_MODEL`.
2. `npm run stack:up`, then `npm run seed` (writes `docker/.env`), then `npm run seed:verify`. Expect it to pass.
3. Copy into `.env`: `GITEA_*`, `MATTERMOST_*`, `MAILPIT_*`, `EMAIL_FROM` and `POSTGRES_URL` from `docker/.env` (see `.env.example`).
4. `npm run index:knowledge`, then `npm run knowledge:check`. Company search must pass before the Wingman can answer anything.
5. Reset anything left from an earlier run so evidence is clean: in Mailpit (`:8084`) choose Delete all, and note how many issues Gitea (`:8082`)
   has and the newest post in Mattermost `#launch` (`:8083`). **Write these three "before" facts in the results file.** A thing only counts
   as created by Kaki if it is not in the "before" facts.

## Part A: replay, no voice

Start the server with the log kept in a file, and restart it for every run so the replay starts at the beginning:

```bash
KAKI_REPLAY=1 KAKI_REPLAY_SPEED=10 npm run dev 2>&1 | tee smoke-a.log
```

The Host plays `scenarios/pixel-kampung/replay/transcript.json` (52 lines, about 2 minutes at 10x), then stops. Before starting the server, open
all of these and keep them open:

- Shared screen: `http://localhost:5173/screen`
- One phone page per role: `http://localhost:5173/phone?role=producer`, `lead_programmer`, `game_designer`, `marketing_lead`

If the phone page asks for a name or meeting code, use the code shown on the shared screen under "Join on phone".

Take a screenshot at about 30 s, 60 s and 120 s, and one more after the replay ends. Name them `smoke-a-<seconds>s-<screen|role>.png`.

### What to check (answer key: `scenarios/pixel-kampung/replay/expected.json`)

| # | Check | Where | Pass means | Owner if it fails |
|---|---|---|---|---|
| 1 | Agenda clock | screen | The ring starts on the first line and moves through the 4 items in order | Host |
| 2 | Host speech | screen "Live feed" | Lines tagged HOST: an opening, a "next up", at least one time-out warning, a closing | Host |
| 3 | Proposed tasks | screen board, "Suggested" | Three tasks appear: crash bug to `lead_programmer`, launch-date post to `producer`, streamer email to `marketing_lead`. Milestone report and store page text to `producer` are also fine. | Host |
| 4 | Open questions | screen | At some point during the replay both appear: where players quit (level 5) and the final-build date. Look at the 30 s and 60 s screenshots. | Host |
| 5 | Quiet role | screen | `marketing_lead` is flagged quiet | Host |
| 6 | Nudges | the owning role's phone | A "coming up" nudge and an "owner has been quiet" nudge arrive on the right phone | Wingman |
| 7 | Answers with sources | the asking role's phone | A level 5 quit-numbers answer and a final-build-date answer. The build date should surface the wiki (20 Nov) against Starfruit's email (17 Nov). | Wingman |
| 8 | Duplicates and relevance | phones | Each question is answered once, and every fact under it is about that question | Wingman |
| 9 | Claim | phone | A task can be claimed (action agent or manual) | Wingman |
| 10 | Draft | phone | An action draft appears (Gitea issue, Mattermost post or email). Edit one word of the text, then approve. | Wingman |
| 11 | It really happened | Gitea / Mattermost / Mailpit | After approval a **new** issue, `#launch` post or email exists that is not in the "before" facts. Record its title and time. | Wingman |
| 12 | Failure and retry | phone | Only if something failed: the message is clear and retry works. If nothing failed, write `NOT RUN (nothing failed)`. | Wingman |
| 13 | Mark done and sync | phone, screen | Mark one task done on the phone; the screen board moves it to "Done" | Wingman |

Dispatching: on the shared screen, press "Dispatch to ..." on a Suggested task. It then appears on that role's phone. Do this for at least
three tasks: one that becomes a Gitea issue, one a Mattermost post, one an email. There is no calendar action.

Known before you start (from the first run, so do not report them as new unless they changed): the same question was answered twice on a phone;
the "tutorial skip" answer included unrelated level 5 and milestone facts; the launch-date task went to `marketing_lead`, not `producer`; open
questions showed 0; the Studio Manager still has a QR code; Mei's profile says 14 of 20 quit while the seed data says 19 of 29.

## Part B: the live meeting

Same checks 1 to 13, now fed by the live conversation. Stop the replay server, then:

```bash
npm run dev 2>&1 | tee smoke-b-dev.log      # one terminal
npm run npc 2>&1 | tee smoke-b-npc.log      # another
```

Open `http://localhost:5173/demo` in Chrome, join as **Producer** with the microphone on, and open `/screen` and
`/phone?role=producer` in other windows. Use headphones. Say these things, one at a time, pausing a few seconds after each answer:

1. "Hi everyone, let's start."
2. "Arjun, the build crashes after ten customers in a row. Can you file a bug for it?"
3. "What is the final build date?"
4. "Mei, why are players quitting on level 5?"
5. "Please post the launch date in Mattermost."
6. Say nothing for 20 seconds (this should trigger a nudge or a quiet flag).
7. Type this into the type bar instead of speaking: `What did Starfruit say about the build date?`, then press Enter.
8. While an attendee is speaking, press Stop (and once, Escape).

For each step write down: what you said, who answered, whether the answer was relevant, and any awkward delay (more than about 4 s).

Things only part B shows: whether the AI attendees' own lines are handled sensibly by the notetaker (they are posted as transcript lines
too), whether the Wingman panel in `/demo` behaves like the phone page, and whether the Kaki Host tab shows the same clock as `/screen`.
The notetaker needs a pause or a few lines before it reacts (about 7 s by default).

## Collecting log evidence

For each `FAIL`, find the matching log lines and paste at most 10 of them, oldest first. Useful searches:

```bash
grep -n "kaki host:" smoke-a.log | tail -40
grep -n "kaki wingman:" smoke-a.log | tail -40
grep -n -i "error\|failed\|disabled" smoke-a.log | tail -40
```

If a log says `nudges disabled (missing ...)` or `company search is disabled`, that is setup (step 3 or 4), not a bug: fix the setup and re-run.

## Results file: `docs/smoke-test-results.md`

Copy this template exactly and fill it in.

```markdown
# Smoke test results

- Date and time:
- Commit tested (`git rev-parse --short HEAD`):
- Part run: A / B / both
- Machine and browser:

## Before facts
- Mailpit emails before: N
- Gitea issues before: N (newest: "...")
- Mattermost #launch newest post before: "..."

## Results
| # | Result (PASS / FAIL / NOT RUN) | What I saw (one or two sentences) | Evidence (screenshot name or log lines) |
|---|---|---|---|
| 1 | | | |
...one row for each of 1 to 13...

## Part B script
| Step | What I said or typed | Who answered | Relevant? (yes/no) | Delay | Notes |
|---|---|---|---|---|---|

## New problems not in the "known" list
(one bullet each: row number, what happened, log lines)

## Setup problems I had
(commands that failed and their error text, with no secrets)
```

Finish by listing which rows each owner (Host, Wingman) has to look at. Then commit `docs/smoke-test-results.md` and any screenshots, not the
`.log` files, and push to `feature/scripted-replay`.
