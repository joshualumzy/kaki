# Combined check: follow-up (short)

For a literal-minded agent. Do the steps in order. If a step fails, STOP and show the exact output.
Obey the git safety rules in `AGENTS.md` and `docs/combined-check.md`: push only to `personal`, branch `feature/scripted-replay`, plain `git push`, never force. If a push is rejected, STOP and ask.

## Why
The first combined check could not be fully checked because the recorded event files were not pushed. Two fixes were also made since then: the phone's "sending" state now starts at the Approve click, and the host's welcome line is now kept for a screen that connects late.

## Steps

1. `git pull --rebase personal feature/scripted-replay` (if it does not fast-forward cleanly, STOP and show `git log --oneline --graph --all -15`). Run `npm install`.

2. Find the event recordings from the earlier combined check (the `combined-screen.jsonl` and `combined-producer.jsonl` files, or whatever your recorder wrote). Copy them into `docs/replay-events/` with exactly these names: `combined-screen.jsonl` and `combined-producer.jsonl`. If you cannot find them, say so and go to step 3 anyway.

3. Run the replay once more with the recorder on, and open the shared screen **before** the replay starts and keep it open (follow `docs/replay-check.md`). Save the screen events as `docs/replay-events/combined2-screen.jsonl`. Let the replay finish.

4. Quote from `combined2-screen.jsonl`, with the line copied word for word, no summary:
   - Every `HOST_SPEECH_TRIGGERED` event: its `kind` and `text`, in order.
   - The **last** `MEETING_RECORD_UPDATED` event's `openQuestions` list (only that one event, not all events).
   - The number of `openQuestions` in each `MEETING_RECORD_UPDATED` event, in order (one number per event).
   - Every `newTasks`/`TASK_UPDATED` with `status` `SUGGESTED`: the title and `actionKind`.

5. Run `npm run eval:notetaker`. It needs the `KAKI_LLM_*` keys in `.env`. Print only the key names to check (`awk -F= '/^KAKI_LLM/{print $1}' .env`), never the values. Paste the **whole output** of the command into the report. If the keys are missing, write NOT VERIFIED and say which keys are missing.

6. Write `docs/combined-check-followup-results.md` with the quotes from step 4 and the output from step 5. Do not write PASS or FAIL for anything you could not verify; write NOT VERIFIED. Commit all of `docs/replay-events/combined*.jsonl` and the results file, then `git push personal feature/scripted-replay`. Confirm the remote still has every earlier commit, then tell the owner it is done.

## Owner's part (two quick checks while the replay runs)
Open `http://localhost:5173/screen` before starting. Then:
1. **Opening line:** what is the first Host message you see in the feed? (Expected: it starts with "Welcome to".) Write it exactly.
2. **Sending dots:** on `http://localhost:5173/phone?role=producer`, dispatch any task, press "Let Kaki do it", and Approve. Do the dots stay for about a second after you press Approve? yes/no.
Add both answers to the end of the agent's results file, or tell the agent.
