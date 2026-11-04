# Notetaker tuning log

State of the notetaker tuning, for whoever picks it up (loop rules: `docs/agents/tuning-loop.md`).
Reports are in `docs/eval-runs/round-N.md`; each header names the model and commit.

## Rounds

| Round | Model | Result | Notes |
|---|---|---|---|
| 1-7 | `llama3.1:8b` | 0 of 3 each; failure lines 26, 22, 15, 19, 17, 19, 12 | Prompt rules + code checks (evidence for tasks and for closing questions) |
| 8 | `X-test-1` | invalid | Model name is case-sensitive (`x-test-1`); every call got HTTP 503 |
| 9 | `llama3.1:8b` | 0 of 3 (20 lines) | Product-work examples did not help the 8B model |
| 10 | `x-test-1` (GLM flash) | invalid | 82 of ~90 calls hit the 20 s timeout; too slow |
| 11 | `x-test-2` (DeepSeek flash) | 1 of 1 PASS | ~4.9 s per call |
| 12 | `x-test-2` | invalid | Cancelled (exit 130); the script then pushed a bogus report. Fixed in `6b0b775` |
| 13 | `x-test-2` | **3 of 3 PASS** (commit `6b0b775`, prompt last changed in `822f00f`) | ~6.5 s per call; same 5 tasks each run |

Done by the loop's rule for `x-test-2` at round 13. `llama3.1:8b` never passed.

## Changes since round 13 (not yet re-run)

- `3fbdb98` prompt: do not list a question the next lines answer; check every open question each pass (round 13 ended with 6-7 stale open questions).
- `18062dd` prompt: the scenario's `situation` and `vocabulary` are given to the notetaker as background.
- `cb85c5c` `KAKI_NOTETAKER_LLM_MODEL` / `KAKI_NOTETAKER_LLM_TIMEOUT_MS` (optional; fall back to `KAKI_LLM_MODEL`). The eval uses the same helper.
- `ff7182c` the spoken welcome names the visitor and their role (`server/src/host/opening.ts`, used by the NPC runner).

**Next step:** run the 3-run check again on `x-test-2` (command below). Keep it only if it is still 3 of 3; if not, revert the prompt commit(s) that caused it (`git revert 18062dd` / `3fbdb98`) and re-run.

```bash
git pull --ff-only personal feature/scripted-replay
KAKI_NOTETAKER_LLM_MODEL=x-test-2 KAKI_LLM_TIMEOUT_MS=60000 REMOTE=personal bash scripts/eval-round.sh
```

## What the prompt and code now rely on

- Task and answer evidence must be a near word-for-word transcript line (`groundingLine`); otherwise the item is dropped and logged.
- Whoever says "I'll ..." owns the task (`volunteerRole`), whatever role the topic seems to belong to.
- Questions close only with a quoted answer (`answeredQuestions`); `answeredQuestionIds` is still accepted.
- Product work itself is not a task; a ticket/post/write-up is, only when someone is asked to produce it or volunteers.
- The eval prints a log line whenever a question is closed or dropped, which is how the stale-question problem was found.

## Known gaps

- Only `pixel-kampung` has a replay, and the eval keyword for "where players quit" is just `level 5`, so any question mentioning level 5 satisfies it (loose, not strict).
- The eval does not check for stale open questions at the end.
- Nothing tests a live visitor's unscripted speech. A set of visitor-style probe lines (messy phrasing, a firm answer, an assignment from the visitor) would.
- The notetaker prompt is long and was shaped on the 8B model; a trimmed version is an experiment worth running against the 3 of 3 baseline.
- Latency for the AI attendees (time to the first spoken word) has not been measured; the eval cannot measure it.

## Environment

- Eval: `REMOTE=personal bash scripts/eval-round.sh` (the report is committed and pushed by the script; Ctrl-C leaves nothing behind).
- On the owner's machine `origin` is the classroom repo and `personal` is `joshualumzy/it5007-project`. The tuning session's `origin` is the latter.
