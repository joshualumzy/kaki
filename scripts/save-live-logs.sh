#!/usr/bin/env bash
# Copies .live-logs/*.log to docs/live-runs/<timestamp>/*.txt so they can be committed
# (the .log extension is gitignored). Prints only line numbers of lines that look like secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d .live-logs ] || { echo "No .live-logs/ here. Run scripts/live-up.sh first."; exit 1; }

dest="docs/live-runs/$(date +%Y%m%d-%H%M)"
mkdir -p "$dest"
for f in npc dev stack; do
  [ -f ".live-logs/$f.log" ] && cp ".live-logs/$f.log" "$dest/$f.txt"
done
[ -f .live-logs/npc.log ] && grep -E 'dropped|ignored|failed|accepts|declines|handed over|cue|error' .live-logs/npc.log > "$dest/npc-key-lines.txt" || true

echo "Saved to $dest"
hits=$(grep -nEi 'key|token|secret|password|bearer' "$dest"/*.txt | cut -d: -f1,2 || true)
if [ -n "$hits" ]; then
  echo "WARNING: these lines look like secrets (file:line). Delete them before committing:"
  echo "$hits"
else
  echo "No secret-like lines found."
fi
echo "Next: git add $dest && git commit -m 'Add live test logs' && git push -u personal feature/scripted-replay"
