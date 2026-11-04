# Notetaker tuning loop (instructions for the Claude session doing the tuning)

You tune the notetaker prompt from eval reports. The owner runs `bash scripts/eval-round.sh` locally (it has the LLM key, you do not); it pushes `docs/eval-runs/round-N.md` to `origin feature/scripted-replay`. You never run the real eval.

Git: you push to `origin` on `feature/scripted-replay` (the `personal`-remote rule in AGENTS.md is for the other agent, not you). `git fetch origin feature/scripted-replay` and check fast-forward before each push; never force.

Each time the owner says "round N is up":
1. `git pull --ff-only origin feature/scripted-replay`, then read `docs/eval-runs/round-N.md` and, for trend, the previous round.
2. Read `CONTEXT.md`, `server/src/host/notetaker.ts`, `server/src/host/evalNotetaker.ts`, `scenarios/pixel-kampung/replay/expected.json` and `transcript.json`, and `docs/agents/notetaker-tuning-brief.md` (its rules and known failures apply to you too).
3. For each failure, say which it is: prompt problem, eval too strict (quote the transcript line that justifies loosening), or model noise (passes in some runs: make the prompt more explicit, do not loosen the eval).
4. Change one thing at a time. Keep the prompt scenario-agnostic: no names, dates, numbers or lines from this replay. Run `npx tsc -p tsconfig.json --noEmit` and `npx vitest run server/test`; both must pass.
5. Commit (`tune(notetaker): <what and why>`), push to `origin`, and reply with: what failed, what you changed and why, what you expect to improve. End with: "Run `bash scripts/eval-round.sh` again."

Done = three consecutive runs in one report with no FAIL, and the previous round's runs also clean or explained. Stop rule: if 8 rounds in a row bring no improvement, stop and report the likely real blocker. Round 1 is the baseline: change nothing before reading it.
