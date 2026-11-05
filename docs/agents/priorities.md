# Priorities beyond the notetaker (ranked, from a docs-only review)

Written from `HANDOFF.md`, `docs/agents/status-wingman-action.md` and the saved check results. Nothing was run, and many results predate later fixes, so treat this as a ranking by risk, not verified findings. The agent session had no LLM key, Azure access or microphone.

## Ranked

1. **Run the whole live path once, timed (test).** Visitor speaks -> AI attendees answer -> notetaker finds a task -> Sam announces it -> the phone accepts -> Wingman drafts -> Kaki runs. Pieces are proven separately; Azure, the real model, real acoustics and the spoken cues are "not verified live" (HANDOFF). Needs the owner (clicks, microphone, keys).
2. **A task for a role an AI plays has nobody to accept it (gap, small).** Open in the status note. Most roles at the booth are AI. Pick a rule (for example Sam keeps them on the screen and says so) and test it.
3. **Voice latency and mishearing (test).** About 950 ms pipeline overhead before model and Azure. The smoke test saw "the build crashes after ten customers" recognised as "belt crashes off to 10 customers". Measure time to first spoken word with the real model; try messy and accented sentences.
4. **Re-run earlier failures marked fixed (test, cheap).** Company search throwing on missing `date`/`source` (smoke rows 6, 7); Gitea draft inventing a bug template; launch-date task on the wrong role; open questions showing 0; the "Email a streamer" run marked FAIL in `final-actions-results.md`. Compare against the saved events.
5. **Deployment safety.** LiveKit runs with `--dev` public keys; Azure VM LiveKit ports are closed until a production config exists. Blocks visitors on their own devices; not needed for one laptop at the booth.
6. **Smaller:** round-16 duplicate-question drop in the notetaker; wire the visitor-probe replay into the eval (`REPLAY` folder choice, `answeredQuestions` check); calendar grid and sending animation (FAIL in the recheck); unmerged branches `feature/mock-crm-nocodb` and `feature/contextual-timestamps`; the shared-file PR.

## Skip for now
More prompt trimming, mood tags and Azure speaking styles, the combined meeting page, phones as visitor devices, multiple rooms.

## Related
- Visitor-probe draft: `scenarios/pixel-kampung/replay-visitor/` (not wired into the eval, not run).
- Notetaker state: `docs/agents/tuning-log.md`, `docs/agents/tuning-loop.md`.
