#!/usr/bin/env bash
# Copies .live-logs/*.log to docs/live-runs/<timestamp>/*.txt so they can be committed
# (the .log extension is gitignored). Prints only line numbers of lines that look like secrets.
#   bash scripts/save-live-logs.sh            save the current run
#   bash scripts/save-live-logs.sh previous   save the run before the last restart (live-up.sh keeps it)
set -euo pipefail
cd "$(dirname "$0")/.."

src=.live-logs
[ "${1:-}" = previous ] && src=.live-logs/previous
[ -d "$src" ] || { echo "No $src/ here. Run scripts/live-up.sh first."; exit 1; }

dest="docs/live-runs/$(date +%Y%m%d-%H%M)"
mkdir -p "$dest"
for f in npc dev stack; do
  [ -f "$src/$f.log" ] && cp "$src/$f.log" "$dest/$f.txt"
done
[ -f "$src/npc.log" ] && grep -aE 'dropped|ignored|failed|accepts|declines|handed over|cue|error' "$src/npc.log" > "$dest/npc-key-lines.txt" || true

echo "Saved to $dest"
hits=$(grep -naEi 'key|token|secret|password|bearer' "$dest"/*.txt | cut -d: -f1,2 || true)
if [ -n "$hits" ]; then
  echo "WARNING: these lines look like secrets (file:line). Delete them before committing:"
  echo "$hits"
else
  echo "No lines matched key/token/secret/password/bearer. This is a word check, not a guarantee: skim the files before pushing."
fi
echo "Next: git add $dest && git commit -m 'Add live test logs' && git push -u personal feature/scripted-replay"
