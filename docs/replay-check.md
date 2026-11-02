# Replay check (for an agent on the project owner's machine)

Goal: see what the Host and Wingman actually produce in replay mode, so the owner and reviewer can judge it. **Observe and report. Do not change code.**
Replay only: no microphone, no `npm run npc`, no `/demo`. Do not kill Chrome. Do not print `.env` values.

## Setup (see `docs/smoke-test.md` for detail)
1. `npm run stack:up`, then `npm run seed` and `npm run index:knowledge` (the index must exist or search is disabled).
2. Record "before" facts: Mailpit email count, newest Gitea issue number, newest Mattermost `#launch` post.
3. `KAKI_REPLAY=1 KAKI_REPLAY_SPEED=10 npm run dev 2>&1 | tee replay.log`

**Wait for the whole replay.** The transcript is 35 minutes of meeting time (52 lines), about 3.5 minutes at 10x. It is finished only when the live feed shows Wei Ling's closing line ("That's everything. Thanks all, good meeting."). Tasks, the build-date question, the closing host speech and the quiet nudge all happen late. Take screenshots at about 60 s, 120 s, 180 s and after the closing line, and say in the report how far the replay got.

## Capture events (the part screenshots cannot show)
Write a small script **outside the repo** (for example in a scratch folder) that opens a WebSocket to `ws://localhost:3001/ws?role=<role>` for
`screen`, `producer`, `lead_programmer`, `game_designer`, `marketing_lead` **before** the replay starts, and appends every message as one JSON line to
`events-<role>.jsonl`. Start the server, then the scripts, then begin the replay (restart the server if the replay already started).

**Pull first** (`git pull origin feature/scripted-replay`) so you test the latest search and the 19-of-29 data, then **re-run `npm run index:knowledge`** (the seed text and prompt changed). Put the commit you tested at the top of the report. Before starting, delete any old `replay.log` and `events-*.jsonl`.

## Report: `docs/replay-check-results.md`
Fill each section from the captured events, quoting text exactly. No judging beyond PASS / FAIL / what you saw.

1. **Tasks** (`TASK_UPDATED` with status SUGGESTED): table of title, suggested assignee. Expected: crash bug -> `lead_programmer`, launch-date post -> `producer`,
   streamer email -> `marketing_lead` (see `scenarios/pixel-kampung/replay/expected.json`).
2. **Open questions** (`MEETING_RECORD_UPDATED.payload.openQuestions`): every distinct question with its `id` and `forRole`. Expected: where players quit on level 5, and the final-build date.
3. **Answers** (`FACT_FOUND`): for each, the question and **every fact's full text, source and date, verbatim**, and which role's feed received it. Note any question answered more than once.
4. **Nudges** (`NUDGE`): text, role, and the replay second it arrived.
5. **Host speech** (`HOST_SPEECH_TRIGGERED`): kind and text.
6. **Quiet flag**: who, and when.
7. **Errors**: every `kaki host:` / `kaki wingman:` line in `replay.log` containing error, failed or disabled (max 10 per problem).

## Then, once, by hand (about 10 minutes, owner or agent with a browser)
Press "Dispatch to ..." on three Suggested tasks (a Gitea issue, a Mattermost post, an email). On each phone: claim with the action agent, edit one word, approve.
Record for each: draft text, final status, the artifact link shown, whether the link opens the real issue/post/email, and anything that failed or read confusingly.

Also commit the raw `events-*.jsonl` files to `docs/replay-events/` (they are small) so the reviewer can check your quotes.

Commit the results file and screenshots (`docs/screenshots/replay-*.png`) and push to `feature/scripted-replay`.
