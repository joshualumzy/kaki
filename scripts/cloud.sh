#!/usr/bin/env bash
# Manage the Azure cloud deployment (kaki-vm in KAKI-BOT-RG):
#   npm run cloud:up       Start the Azure VM and wait until https://kaki.southeastasia.cloudapp.azure.com is live
#   npm run cloud:down     Deallocate the Azure VM so compute billing drops to $0/hr
#   npm run cloud:status   Check VM power state and live health
set -e

RG="KAKI-BOT-RG"
VM="kaki-vm"
URL="https://kaki.southeastasia.cloudapp.azure.com"

# shellcheck source=scripts/live-checks.sh
. "$(dirname "$0")/live-checks.sh"

# The deployment must never accept scripted speech. An unreadable health body fails too: a check
# that cannot tell is not a pass.
check_fake_speech() { # health-json
  local code=0
  health_reports_fake_speech "$1" || code=$?
  if [ "$code" -eq 0 ]; then
    echo ""
    echo "FAIL  $URL/health reports fakeSpeech=true. KAKI_FAKE_STT must be off in a deployment." >&2
    return 1
  fi
  if [ "$code" -eq 2 ]; then
    return 1
  fi
  return 0
}

cmd="${1:-status}"

case "$cmd" in
  up|start)
    echo "Starting Azure VM ($VM in $RG)..."
    az vm start --resource-group "$RG" --name "$VM"
    echo -n "Waiting for $URL/health to come online"
    for _ in $(seq 1 60); do
      health_body="$(curl -fsS -m 3 "$URL/health" 2>/dev/null || true)"
      if [ -n "$health_body" ]; then
        check_fake_speech "$health_body" || exit 1
        echo " OK!"
        echo ""
        echo "Cloud demo is LIVE:"
        echo "  Main App:   $URL"
        echo "  Wiki.js:    http://kaki.southeastasia.cloudapp.azure.com:8081  (demo / demo)"
        echo "  Gitea:      http://kaki.southeastasia.cloudapp.azure.com:8082  (demo / demo)"
        echo "  Mattermost: https://kaki.southeastasia.cloudapp.azure.com:8443  (demo / demo)"
        echo "  Mailpit:    http://kaki.southeastasia.cloudapp.azure.com:8084"
        echo "  Calendar:   http://kaki.southeastasia.cloudapp.azure.com:5232  (demo / demo)"
        exit 0
      fi
      echo -n "."
      sleep 2
    done
    echo ""
    echo "VM started, but $URL/health is still warming up. Try opening $URL in a moment."
    ;;
  down|stop)
    echo "Deallocating Azure VM ($VM in $RG) so compute billing stops..."
    az vm deallocate --resource-group "$RG" --name "$VM"
    echo "VM is now deallocated (\$0/hr compute). Run 'npm run cloud:up' anytime to wake it back up."
    ;;
  status)
    state=$(az vm get-instance-view --resource-group "$RG" --name "$VM" --query "instanceView.statuses[?starts_with(code, 'PowerState/')].displayStatus | [0]" -o tsv 2>/dev/null || echo "unknown")
    echo "Azure VM ($VM): $state"
    health_body="$(curl -fsS -m 3 "$URL/health" 2>/dev/null || true)"
    if [ -n "$health_body" ]; then
      echo "Website ($URL): ONLINE"
      check_fake_speech "$health_body" || exit 1
    else
      echo "Website ($URL): OFFLINE (run 'npm run cloud:up' to start)"
    fi
    ;;
  *)
    echo "Usage: bash scripts/cloud.sh [up|down|status]"
    exit 1
    ;;
esac
