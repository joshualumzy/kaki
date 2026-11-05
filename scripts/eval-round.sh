#!/usr/bin/env bash
# One round of notetaker prompt tuning: run the real-LLM eval 3 times and write docs/eval-runs/round-N.md.
# It changes nothing else and does not touch git; commit the report yourself.
#
#   bash scripts/eval-round.sh          (RUNS=1 for a single quick run)
#
# Needs .env with KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL. The report never contains
# the key (it is redacted if it ever appears).
set -euo pipefail
cd "$(dirname "$0")/.."

RUNS="${RUNS:-3}"
EVAL_CMD="${EVAL_CMD:-npm run --silent eval:notetaker}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
DIR="docs/eval-runs"
mkdir -p "$DIR"

N=$(( $(find "$DIR" -maxdepth 1 -name "round-*.md" | wc -l) + 1 ))
OUT="$DIR/round-$N.md"
# The model name is configuration, not a secret; the key is never read here except to redact it below.
# The eval uses the notetaker model when KAKI_NOTETAKER_LLM_MODEL is set, so report that one.
MODEL="${KAKI_NOTETAKER_LLM_MODEL:-${KAKI_LLM_MODEL:-}}"
if [ -z "$MODEL" ] && [ -f .env ]; then MODEL="$(grep -E '^KAKI_NOTETAKER_LLM_MODEL=' .env | head -1 | cut -d= -f2- || true)"; fi
if [ -z "$MODEL" ] && [ -f .env ]; then MODEL="$(grep -E '^KAKI_LLM_MODEL=' .env | head -1 | cut -d= -f2- || true)"; fi
SECRET=""
if [ -f .env ]; then SECRET="$(grep -E '^KAKI_LLM_API_KEY=' .env | head -1 | cut -d= -f2- || true)"; fi

{
  echo "# Notetaker eval, round $N"
  echo
  echo "- branch: \`$BRANCH\`, commit: \`$(git rev-parse --short HEAD)\`, $(date -u +%Y-%m-%dT%H:%MZ)"
  echo "- model: \`${MODEL:-unknown}\`"
  echo "- prompt file last changed in: \`$(git log -1 --format='%h %s' -- server/src/host/notetaker.ts)\`"
  echo "- uncommitted prompt changes: $(git status --porcelain server/src/host/notetaker.ts | wc -l | tr -d ' ') file(s)"
  echo
} > "$OUT"

PASSES=0
for i in $(seq 1 "$RUNS"); do
  echo "Run $i of $RUNS (takes a minute or two)..."
  LOG="$(mktemp)"
  set +e
  $EVAL_CMD > "$LOG" 2>&1
  CODE=$?
  set -e
  # Ctrl-C (130) or kill (143): stop here and leave no half-written report behind.
  if [ "$CODE" -eq 130 ] || [ "$CODE" -eq 143 ]; then
    rm -f "$LOG" "$OUT"
    echo "Interrupted: nothing written."
    exit "$CODE"
  fi
  [ "$CODE" -eq 0 ] && PASSES=$((PASSES + 1))
  {
    echo "## Run $i: $([ "$CODE" -eq 0 ] && echo PASS || echo "FAIL (exit $CODE)")"
    echo
    echo '```text'
    tail -n 80 "$LOG"
    echo '```'
    echo
  } >> "$OUT"
  rm -f "$LOG"
done

# Never let a key reach the repo, whatever the tool printed.
if [ -n "$SECRET" ]; then
  SECRET="$SECRET" node -e '
    const fs = require("fs"); const f = process.argv[1];
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").split(process.env.SECRET).join("[redacted]"));
  ' "$OUT"
fi
sed -i.bak "s/^- uncommitted/- result: $PASSES of $RUNS runs passed\n- uncommitted/" "$OUT" && rm -f "$OUT.bak"

echo "Result: $PASSES of $RUNS runs passed. Report: $OUT"
