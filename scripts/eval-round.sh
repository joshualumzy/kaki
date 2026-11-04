#!/usr/bin/env bash
# One round of notetaker prompt tuning: pull the latest prompt, run the real-LLM eval 3 times,
# write docs/eval-runs/round-N.md, and commit + push ONLY that file.
#
#   REMOTE=personal bash scripts/eval-round.sh   (REMOTE defaults to origin)
#
# Needs .env with KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL. The report never contains
# the key (it is redacted if it ever appears). DRY_RUN=1 skips pull, commit and push (for trying it out).
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE="${REMOTE:-origin}"
RUNS="${RUNS:-3}"
EVAL_CMD="${EVAL_CMD:-npm run --silent eval:notetaker}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
DIR="docs/eval-runs"
mkdir -p "$DIR"

if [ "${DRY_RUN:-0}" != "1" ]; then
  echo "Pulling the latest prompt on $BRANCH..."
  git pull --ff-only "$REMOTE" "$BRANCH"
fi

N=$(( $(find "$DIR" -maxdepth 1 -name "round-*.md" | wc -l) + 1 ))
OUT="$DIR/round-$N.md"
# The model name is configuration, not a secret; the key is never read here except to redact it below.
MODEL="${KAKI_LLM_MODEL:-}"
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
if [ "${DRY_RUN:-0}" = "1" ]; then echo "(dry run: nothing committed or pushed)"; exit 0; fi

git add -- "$OUT"
git commit -m "docs: notetaker eval round $N ($PASSES of $RUNS runs passed)" --only -- "$OUT"
git push "$REMOTE" "$BRANCH"
echo "Pushed. Tell Claude: round $N is up."
