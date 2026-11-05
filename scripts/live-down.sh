#!/usr/bin/env bash
# Stops what live-up.sh started (only those processes). Add --stack to stop the Docker stack as well.
cd "$(dirname "$0")/.." || exit 1
if [ -s .live-logs/pids ]; then
  while read -r pid; do
    [ -n "$pid" ] && kill -- "-$pid" 2>/dev/null && echo "Stopped process group $pid"
  done < .live-logs/pids
  : > .live-logs/pids
else
  echo "Nothing recorded as running."
fi
[ "$1" = "--stack" ] && npm run stack:down
exit 0
