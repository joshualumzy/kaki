#!/usr/bin/env bash
# Timed live run, no agent needed. It asks you to press Enter at each moment, then writes the results to
# docs/agents/live-run-results.md. Run the demo yourself; this only keeps the stopwatch and your notes.
#   bash scripts/live-timing.sh            (then:  git add docs/agents/live-run-results.md && git commit && git push)
cd "$(dirname "$0")/.." || exit 1
out=docs/agents/live-run-results.md
now() { date +%s.%N; }
mark() { # label prompt
  read -r -p "$2  [Enter] " _ ; printf '%s' "$(now)"
}
diff() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }
ask() { local v; read -r -p "$1 " v; printf '%s' "$v"; }

rows=""
run_case() { # name what-to-say
  echo; echo "=== $1 ==="; echo "Say: $2"
  t0=$(mark T0 "Press Enter the moment you FINISH saying it.")
  t1=$(mark T1 "Press Enter when the AI starts to answer aloud.")
  t2=$(mark T2 "Press Enter when Sam says the task is sent (the dispatch cue).")
  t3=$(mark T3 "Press Enter when the AI answers the task aloud.")
  t4=$(mark T4 "Press Enter when the screen shows Accepted or Declined (or n/a if it never does).")
  heard=$(ask "What did the transcript show you said (as heard)?")
  result=$(ask "PASS or FAIL for this case?")
  notes=$(ask "Anything odd (one line)?")
  rows+="| $1 | $(diff "$t0" "$t1") | $(diff "$t0" "$t2") | $(diff "$t2" "$t3") | $(diff "$t3" "$t4") | $heard | $result | $notes |"$'\n'
}

echo "Open /demo, /screen and the phone page first. Run  bash scripts/live-preflight.sh  if unsure."
run_case "Accept: assignment to an AI role" "Priya, can you post the launch date in the team channel?"
run_case "Refuse: a task clearly not hers" "Priya, can you fix the oven fuse tonight?"
run_case "Messy phrasing" "the build crashes after ten customers, someone should file that"
run_case "Fast or accented" "$(ask 'Pick any request and say it fast or in your usual accent; type here what you will say:')"

echo; echo "Draft and Kaki (accepted case only)."
d1=$(ask "Seconds from Accepted until the draft appeared (guess is fine):")
d2=$(ask "Seconds from the draft until Kaki finished (done card with link):")
done_ok=$(ask "Did the post or email really appear in Mattermost/Mailpit/Gitea? yes/no:")
errors=$(ask "Any errors in the server or npc terminal? paste one line or 'none':")

{
  echo "# Live run results"
  echo
  echo "Run on $(date -u +%Y-%m-%dT%H:%MZ), commit $(git rev-parse --short HEAD). Times in seconds. Gaps: T0->T1 speech to first AI word; T0->T2 speech to Sam's dispatch cue; T2->T3 cue to the AI's answer; T3->T4 answer to the screen change."
  echo
  echo "| Case | T0->T1 | T0->T2 | T2->T3 | T3->T4 | Heard as | Result | Notes |"
  echo "|---|---|---|---|---|---|---|---|"
  printf '%s' "$rows"
  echo
  echo "- Accepted to draft: ${d1}s. Draft to Kaki done: ${d2}s. Output really appeared: ${done_ok}."
  echo "- Errors seen: ${errors}"
} > "$out"
echo; echo "Wrote $out"
echo "Now send it:  git add $out && git commit -m 'docs: live run results' && git fetch personal && git push personal HEAD"
