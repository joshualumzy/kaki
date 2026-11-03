# Brief: tune the notetaker prompt until `npm run eval:notetaker` is clean

You are tuning one prompt. Do not build features. Work autonomously and loop until the exit criteria are met or you hit the stop rule.

## Setup (once)
- Repo root, branch `feature/scripted-replay`. `.env` must already hold `KAKI_LLM_BASE_URL`, `KAKI_LLM_API_KEY`, `KAKI_LLM_MODEL`. If it does not, stop and tell the owner.
- Never print or read `.env` values (use `awk -F= '{print $1}' .env` to list keys only). Never run `pkill`/`killall` on Chrome.
- Read first: `CONTEXT.md`, `server/src/host/notetaker.ts`, `server/src/host/evalNotetaker.ts`, `scenarios/pixel-kampung/replay/expected.json`, `scenarios/pixel-kampung/replay/transcript.json`, `docs/notes-for-friend.md`.

## The loop
1. `npm run eval:notetaker 2>&1 | tee eval-N.txt` (N = run number; delete these files afterwards, do not commit them). Real model, so results vary: run it 3 times before judging any change.
2. For each failure, decide which of three causes it is, and say so in one line before changing anything:
   - **Prompt problem**: the model really produced something wrong. Fix the prompt.
   - **Eval too strict**: the model's output is correct for the meeting, but `expected.json` keywords or the matching in `evalNotetaker.ts` reject it. Confirm by reading `transcript.json` for the exact line that supports the model's output. Only then loosen the check (add a keyword or an `acceptedTasks` entry).
   - **Model noise**: passes in 2 of 3 runs. Make the prompt more explicit; do not loosen the eval.
3. Change ONE thing at a time, rerun 3 times, keep the change only if failures go down and nothing new fails. Otherwise revert it.
4. Commit each kept change on its own: `git commit -m "tune(notetaker): <what and why>"`. Push only when the owner asks.

## Known failures to fix (from the live run)
- Near-duplicate tasks across roles (three patience-timer tasks): one task per piece of work, assigned once.
- Product work suggested as tasks (design or code changes nobody agreed to do in the meeting): only commitments someone made or was asked to make.
- The launch-date post is assigned to `marketing_lead` but belongs to `producer` (follow the transcript).
- Eval FAIL: crash bug appears twice, launch-date post missing, two questions missing. The live run does ask those questions, so check whether the eval is too strict before touching the prompt.
- Nudges quote the old contract build date (20 Nov) when a newer email says 17 Nov: prefer the newest dated source, and name it.

## Hard rules
- You may edit only `server/src/host/notetaker.ts` and, for confirmed "eval too strict" cases, `server/src/host/evalNotetaker.ts` and `scenarios/pixel-kampung/replay/expected.json`.
- Do not edit `shared/**`, `scenario.json`, transcripts, seed data, or anything in `server/src/npc/`.
- Do not make the prompt scenario-specific: no hard-coded names, dates, numbers or quoted lines from this transcript. The prompt must work for any scenario. A prompt that passes by memorising the replay is a failure.
- Never weaken the eval to make a failure disappear without the transcript line that justifies it.
- `npx tsc -p tsconfig.json --noEmit` and `npx vitest run server/test` must still pass after every change.

## Exit criteria
Three consecutive eval runs with no FAIL, and the typecheck and tests green. Then report: the final prompt diff, each eval change with its justifying transcript line, and the pass/fail table for the last three runs.

## Stop rule
If 8 prompt iterations in a row bring no improvement, stop and report what you tried and what you think the real blocker is (for example a model limit or a contradictory expectation). Do not keep guessing.
