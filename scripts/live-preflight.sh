#!/usr/bin/env bash
# Checks the machine is ready for the live run. Changes nothing, prints no secret values.
#   bash scripts/live-preflight.sh          (add --full to also run typecheck and the test suite)
cd "$(dirname "$0")/.." || exit 1
fail=0
ok()  { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; fail=1; }

# 1. Keys: only whether a name is set, never the value.
for key in KAKI_LLM_BASE_URL KAKI_LLM_API_KEY KAKI_LLM_MODEL AZURE_SPEECH_KEY AZURE_SPEECH_REGION \
           GITEA_TOKEN MATTERMOST_TOKEN; do
  if [ -f .env ] && grep -Eq "^${key}=.+" .env; then ok "$key is set in .env"; else bad "$key is missing or empty in .env"; fi
done

# 2. Services answer.
check_url() { # name url
  if curl -fsS -m 3 -o /dev/null "$2" 2>/dev/null; then ok "$1 answers ($2)"; else bad "$1 does not answer ($2)"; fi
}
check_url "Wiki" "http://127.0.0.1:8081/"
check_url "Gitea" "http://127.0.0.1:8082/api/healthz"
check_url "Mattermost" "http://127.0.0.1:8083/api/v4/system/ping"
check_url "Mailpit" "http://127.0.0.1:8084/api/v1/info"
check_url "LiveKit" "http://127.0.0.1:7880/"
check_url "Kaki web (npm run dev)" "http://localhost:5173/"
if pgrep -f "src/npc/main" >/dev/null 2>&1; then
  ok "AI attendees are running (npm run npc)"
else
  bad "AI attendees are not running: start them with  npm run npc"
fi

# 3. Git: whether this branch is level with the owner's remote (skipped when there is no `personal` remote).
branch="$(git rev-parse --abbrev-ref HEAD)"
if git remote | grep -qx personal; then
  if git fetch -q personal "$branch" 2>/dev/null; then
    behind="$(git rev-list --count HEAD..personal/"$branch" 2>/dev/null || echo '?')"
    [ "$behind" = "0" ] && ok "branch $branch is not behind personal" || bad "branch $branch is $behind commit(s) behind personal: run  git pull --ff-only personal $branch"
  else
    bad "could not fetch personal/$branch"
  fi
fi

# 4. Optional: code health.
if [ "$1" = "--full" ]; then
  npm run typecheck >/dev/null 2>&1 && ok "typecheck is clean" || bad "typecheck has errors"
  npx vitest run >/dev/null 2>&1 && ok "all tests pass" || bad "tests fail"
fi

echo
[ "$fail" = 0 ] && echo "Ready for the live run." || echo "Fix the FAIL lines above, then run this again."
exit "$fail"
