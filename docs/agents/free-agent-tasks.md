# Tasks for the free agent (step by step, with the owner)

Who this is for: the agent that runs on the owner's machine at no cost to the Claude Code cloud session. It works on `personal` (= `joshualumzy/it5007-project`) and walks the owner through the steps one at a time. The cloud agent writes these instructions; this agent runs them and pushes the results back.

Use this file for work that is token-heavy or needs the owner (clicks, microphone, keys). Source of the task list: `docs/agents/priorities.md`.

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

## Task B: timed live run (needs the owner)
Goal: run the full path once and time it. Chain: visitor speaks -> AI attendees answer -> notetaker finds a task -> Sam announces it -> phone accepts -> Wingman drafts -> Kaki runs.
1. Ask the owner to confirm: LLM key set, Azure speech key set, microphone works. Check key NAMES only.
2. Start the services (see `HANDOFF.md` and `docs/agents/status-wingman-action.md` for the commands; `npm run npc` plus a person in `/demo`). Ask the owner to open `/demo` and `/screen`, and a phone on the Wingman page.
3. Give the owner this script to say, one line at a time, and note a timestamp at each marker:
   - T0: owner finishes the first sentence. T1: first spoken word from an AI attendee. Latency = T1 - T0.
   - Say a messy sentence: "the build crashes after ten customers". Note what the transcript shows (heard correctly or not).
   - Say an assignment: "Sam, can you post the launch date in the team channel?" (adjust to the scenario). Note: task appears, Sam announces it, who it goes to.
   - Accept on the phone. Note: Wingman draft appears (T2), Kaki runs it (T3), done card shows the link (T4).
4. For a task aimed at a role an AI plays, note whether anyone can accept it. This is the open gap; record what actually happened.
5. Repeat the three speech lines once with an accent or faster pace.
6. Write `docs/agents/live-run-results.md`: a table of T0..T4 with seconds, the transcript lines as heard, every PASS/FAIL, anything that broke, plus the server console errors (copy the lines, no keys). Commit, fetch, confirm fast-forward, `git push personal HEAD`.

## Task C: notetaker eval rounds (token heavy, optional)
Only if the owner asks. Follow `docs/agents/tuning-loop.md` and the plan in `docs/agents/tuning-log.md`. One prompt cut per round, 3 runs each. Run: `REMOTE=personal bash scripts/eval-round.sh` (it commits and pushes the report). Keep a cut only if 3 of 3 and no slower than about 190 s per run.

## When done
Tell the owner which files were pushed and the commit hash. The cloud agent reads the results from `personal` and updates `docs/agents/priorities.md`.
