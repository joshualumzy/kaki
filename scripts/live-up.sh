#!/usr/bin/env bash
# Starts everything for the live run in the background, so you need one terminal, not three.
#   bash scripts/live-up.sh        start the Docker stack, the Kaki server + web, and the AI attendees, then run the preflight
#   bash scripts/live-down.sh      stop the Kaki server, web and AI attendees (add --stack to stop Docker too)
# Logs go to .live-logs/dev.log and .live-logs/npc.log:  tail -f .live-logs/npc.log
cd "$(dirname "$0")/.." || exit 1
mkdir -p .live-logs
pids=.live-logs/pids

if [ -s "$pids" ] && xargs -a "$pids" ps -p >/dev/null 2>&1; then
  echo "Already running (see $pids). Run  bash scripts/live-down.sh  first to restart."
  exit 1
fi
: > "$pids"

# Keep the last run's logs (one run back) instead of overwriting them, so a failing run can still be saved after a restart:
# bash scripts/save-live-logs.sh previous
if ls .live-logs/*.log >/dev/null 2>&1; then
  rm -rf .live-logs/previous
  mkdir -p .live-logs/previous
  mv .live-logs/*.log .live-logs/previous/
fi

echo "Starting the Docker stack (Gitea, Mattermost, LiveKit, Mailpit...)"
npm run stack:up >.live-logs/stack.log 2>&1 || { echo "stack:up failed; see .live-logs/stack.log"; exit 1; }

start() { # name command...
  local name="$1"; shift
  # Job control (set -m) gives the process its own process group, so live-down.sh can stop it and its children.
  # (setsid does not exist on macOS.)
  local pid
  pid=$(set -m; nohup "$@" >".live-logs/$name.log" 2>&1 </dev/null & echo $!)
  echo "$pid" >> "$pids"
  echo "Started $name (pid $pid, log .live-logs/$name.log)"
}

start dev npm run dev
echo -n "Waiting for the web app"
for _ in $(seq 1 60); do curl -fsS -m 2 -o /dev/null http://localhost:5173/ 2>/dev/null && break; echo -n "."; sleep 1; done
echo
start npc npm run npc
echo "Giving the AI attendees a few seconds to join..."; sleep 8

bash scripts/live-preflight.sh
echo
echo "Open http://localhost:5173/demo and /screen. Watch the AI:  tail -f .live-logs/npc.log"
