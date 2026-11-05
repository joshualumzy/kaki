# Notetaker tuning log

State of the notetaker tuning, for whoever picks it up.
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
| 14 | `x-test-2` | 1 of 3 (commit `60f8167`) | Report header wrongly said `llama3.1:8b`; fixed in `35d4f06`. Runs 1 and 3 added "Take store screenshots from release candidate two" as a task |
| 15 | `x-test-2` | **3 of 3 PASS** (commit `35d4f06`, after reverting `18062dd` in `3ea05aa`) | 220 / 180 / 176 s per run (avg 192 s) |
| 16 | `x-test-2` | 2 of 3 (commit `4832b6f`, shorter prompt) | 203 / 188 / 159 s (avg 183 s). Run 3 lost the "where players quit" question; shorter prompt reverted |
| 17 | `x-test-2` | 2 of 3 (commit `16cd853`, long prompt + question-duplicate fix) | Fix worked (level 5 question kept). Run 3 had the unexpected screenshots task again, so it is model noise, not only `18062dd`. Runs took 205 / 287 / 340 s (one 60 s timeout): gateway slow, not comparable for speed |
| 18 | `x-test-2` | **3 of 3 PASS** (commit `0b8cf56`, long prompt + question-duplicate fix + how-to-answer rule) | 451 / 249 / 384 s (one 60 s timeout in run 1). Gateway slow: about 2x round 15's 192 s average, so not usable as a speed baseline |
| 19 | `x-test-2` | **3 of 3 PASS** (commit `e4bcd2c`, examples trimmed 14 to 4, rules unchanged) | 214 / 265 / 223 s (avg 234 s), no timeouts. Kept |

Done by the loop's rule for `x-test-2` at round 13. `llama3.1:8b` never passed.

## Current state

- Round 19: the example-only trim (`e4bcd2c`) is kept: 3 of 3, no timeouts. Speed is not proven equal: 234 s average is above round 15's 192 s but below round 18's 361 s for the longer prompt, and the gateway varied between them. The shorter prompt sends fewer tokens, so it should not be slower; a back-to-back run of `0b8cf56` and `e4bcd2c` would settle it if it matters.
- Round 18: 3 of 3 with the long prompt, the question-duplicate fix (`16cd853`) and the how-to-answer rule (`0b8cf56`). By the loop's rule this is done; round 17's failures are explained (screenshots task, fixed by `0b8cf56`; gateway timeouts).
- Timing is unreliable since round 17 (gateway slow, 60 s timeouts). Judge the simplification cuts on pass count first; compare speed only with a back-to-back run of the baseline.
- Prompt is the long version from round 15 (3 of 3). Round 14's regression came from `18062dd` (scenario situation and vocabulary given to the notetaker, which put "release candidate" and marketing in view); it is reverted in `3ea05aa`. `3fbdb98` (stale questions), `cb85c5c` (notetaker model env vars) and `ff7182c` (spoken welcome) stay.
- Shorter-prompt experiment (`4832b6f`, rules 5.1k to 2.9k chars, examples 13 to 3): 2 of 3 in round 16, so it is reverted. It was a little faster, but run 3 lost "where players quit": the model re-asked it while the earlier wording was open, the duplicate-question check dropped it, and the older one was closed in the same pass.

## Simplification plan (next attempt, one cut at a time)

Step 1 is done (`e4bcd2c`, kept). Cutting everything at once cannot say which cut hurt. Try the rest in order, 3 runs each; keep a cut only if it stays 3 of 3 and no slower than ~190 s per run, otherwise revert it:
1. DONE, kept: cut the examples that repeat a rule already stated (kept the volunteer, product-work, how-to-answer and doubted-answer ones).
2. Merge the two "do not repeat or re-ask" sentences into one.
3. Compress the product-work bullet.
4. Do not touch the question rules (stale, closing, duplicate) in the same round as another cut; round 16 suggests they are where the model is most fragile.
Also consider fixing the code side of round 16's failure: when a new question is dropped as a duplicate of an open one that the same reply closes, keep the new one.

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
- The notetaker prompt is long and was shaped on the 8B model; trimming it in one go failed (round 16), see the plan above.
- Latency for the AI attendees (time to the first spoken word) has not been measured; the eval cannot measure it.

## Environment

- Eval: `bash scripts/eval-round.sh` writes the next `docs/eval-runs/round-N.md` (it does not touch git; commit the report yourself).
