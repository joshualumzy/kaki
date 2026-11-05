# Tasks for the free agent (step by step, with the owner)

Who this is for: the agent that runs on the owner's machine at no cost to the Claude Code cloud session. It works on `personal` (= `joshualumzy/it5007-project`) and walks the owner through the steps one at a time. The cloud agent writes these instructions; this agent runs them and pushes the results back.

Use this file for work that is token-heavy or needs the owner (clicks, microphone, keys). Anything that is only a fixed set of commands is a script under `scripts/` that the owner runs alone; this file covers what needs judgment or help. Source of the task list: `docs/agents/priorities.md`.

## Rules (from `AGENTS.md`, non-negotiable)
- Push only to `personal`. Never `origin` (the classroom repo) unless the owner asks for that push.
- Before every push: `git fetch personal`, check the push is a fast-forward. If not, stop, show `git log --oneline --graph --all -15`, and ask. Never force.
- Never read `.env` contents (keys only: `awk -F= '{print $1}' .env`). Never kill Chrome.
- One step at a time: say what you will do, wait for the owner's "done" or "ok" before the next step.
- Write results to the files named below. Do not edit code unless a task says so. Report failures as they are; do not soften them.

## Task A: re-check earlier failures marked fixed (token heavy, no owner needed)
Goal: confirm five fixes against the saved events. Read only; write one report.
1. `git pull --rebase personal feature/scripted-replay`.
2. Find the saved results: `docs/*-results.md` and `docs/replay-events/*.jsonl`. List what exists to the owner.
3. For each item, find the matching rows/events and write PASS, FAIL or NOT FOUND with the exact line as evidence:
   - Company search no longer throws on a missing `date` or `source` (smoke rows 6, 7).
   - The Gitea draft does not invent a bug template.
   - The launch-date task goes to the producer, not marketing_lead.
   - Open questions do not show 0 when questions were asked.
   - The "Email a streamer" run (`final-actions-results.md`) is no longer FAIL.
4. If a result predates the fix commit (`git log` the file vs the fix), mark it STALE: it needs a re-run (put it in Task B).
5. Save the report as `docs/agents/recheck-results.md`. Commit: `docs: recheck of earlier failures`. Fetch, confirm fast-forward, `git push personal HEAD`.

## Task B: timed live run (needs the owner; mostly scripts)
Goal: run the full path once and time it: visitor speaks -> AI attendees answer -> notetaker finds a task -> Sam announces it -> the AI accepts or declines aloud -> draft -> Kaki runs.

Scripts the owner can run alone, no agent: `bash scripts/live-preflight.sh` (keys by name, services, git level; add `--full` for typecheck and tests) and `bash scripts/live-timing.sh` (stopwatch and notes, writes `docs/agents/live-run-results.md`).

The agent's part, step by step:
1. Run `bash scripts/live-up.sh`: it starts Docker, the server and web, and the AI attendees in the background (logs in `.live-logs/`) and ends with the preflight. For each FAIL, help the owner fix it (missing key names in `.env`: names only, never print values; read `.live-logs/*.log` for why a service did not start), then `bash scripts/live-down.sh` and `live-up.sh` again until it says "Ready for the live run." Stop everything afterwards with `bash scripts/live-down.sh --stack`.
2. Ask the owner to open `/demo`, `/screen`, and a phone on the Wingman page.
3. Tell the owner to run `bash scripts/live-timing.sh` and speak the four lines it prints, pressing Enter at each moment. Help only if something fails. While they do it, watch `tail -f .live-logs/npc.log` for lines starting `[npc` such as "accepts", "declines", "is reading the draft", and copy any error lines (no keys) for the owner to paste when asked.
4. Check what the run should show. Accept case: the AI answers aloud, the screen shows Accepted only after her words, the draft appears, the AI approves it about 6 s later (`NPC_APPROVE_DELAY_MS`), Kaki runs it and the output exists in Mattermost, Mailpit or Gitea. Refuse case: she says no and the task returns to the screen as SUGGESTED. Sam's dispatch line is identical for every role.
5. Commit and push the results: `git add docs/agents/live-run-results.md`, commit `docs: live run results`, `git fetch personal`, confirm fast-forward, `git push personal HEAD`. Never force.

## Task C: notetaker eval rounds (token heavy, optional)
Only if the owner asks. Follow `docs/agents/tuning-loop.md` and the plan in `docs/agents/tuning-log.md`. One prompt cut per round, 3 runs each. Run: `REMOTE=personal bash scripts/eval-round.sh` (it commits and pushes the report). Keep a cut only if 3 of 3 and no slower than about 190 s per run.

## When done
Tell the owner which files were pushed and the commit hash. The cloud agent reads the results from `personal` and updates `docs/agents/priorities.md`.
