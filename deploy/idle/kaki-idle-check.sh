#!/usr/bin/env bash
# Switch this Azure VM off (deallocate) after Kaki has had no people for KAKI_IDLE_MINUTES, or after
# nobody has taken a real action for KAKI_IDLE_BACKSTOP_MINUTES. A check that cannot read the
# server's state stays on loudly unless that has lasted the backstop too.
set -euo pipefail

IDLE_URL="${KAKI_IDLE_URL:-http://127.0.0.1:3001/idle}"
IDLE_MINUTES="${KAKI_IDLE_MINUTES:-60}"
BACKSTOP_MINUTES="${KAKI_IDLE_BACKSTOP_MINUTES:-120}"
UPTIME_FILE="${KAKI_IDLE_UPTIME_FILE:-/proc/uptime}"
STATE_FILE="${KAKI_IDLE_STATE_FILE:-/var/lib/kaki-idle/last-ok}"
DRY_RUN="${KAKI_IDLE_DRY_RUN:-0}"
INSTANCE_METADATA="http://169.254.169.254"
DEALLOCATE_API_VERSION="2024-07-01"
# A freshly booted VM gets this long before it may switch itself off, however idle it looks.
BOOT_GRACE_SECONDS=900

log() {
  printf 'kaki-idle: %s\n' "$*"
}

fail() {
  log "$*" >&2
  exit 1
}

stay_on() {
  log "idle check could not read server state; staying on ($*)" >&2
  exit 1
}

# Read one dotted field from JSON. Ubuntu usually has jq; the VM always has Node.
json_get() {
  local json="$1" path="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -er --arg path "$path" 'getpath($path | split(".")) // error("missing " + $path)'
    return
  fi
  printf '%s' "$json" | node -e '
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => {
      let value;
      try { value = JSON.parse(text); } catch { process.exit(3); }
      for (const key of process.argv[1].split(".")) {
        if (value === null || typeof value !== "object" || !(key in value)) process.exit(3);
        value = value[key];
      }
      if (value === undefined || value === null || typeof value === "object") process.exit(3);
      process.stdout.write(String(value));
    });
  ' "$path"
}

# The epoch of the last successful read, so a server that later hangs still has a clock.
read_state_epoch() {
  [[ -r "$STATE_FILE" ]] || return 1
  local text first
  text=$(<"$STATE_FILE")
  first=${text%%[[:space:]]*}
  [[ "$first" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$first"
}

write_state_epoch() {
  local dir now_epoch
  now_epoch=$(date +%s)
  dir=$(dirname "$STATE_FILE")
  if ! mkdir -p "$dir" 2>/dev/null; then
    log "warning: could not create ${dir}; a later unreadable stretch will count from boot" >&2
    return 0
  fi
  if ! printf '%s\n' "$now_epoch" > "$STATE_FILE" 2>/dev/null; then
    log "warning: could not write ${STATE_FILE}; a later unreadable stretch will count from boot" >&2
  fi
}

if ! [[ "$IDLE_MINUTES" =~ ^[0-9]+$ ]]; then
  fail "KAKI_IDLE_MINUTES must be a whole number of minutes, got '$IDLE_MINUTES'"
fi
if ! [[ "$BACKSTOP_MINUTES" =~ ^[0-9]+$ ]]; then
  fail "KAKI_IDLE_BACKSTOP_MINUTES must be a whole number of minutes, got '$BACKSTOP_MINUTES'"
fi

if [[ ! -r "$UPTIME_FILE" ]]; then
  stay_on "cannot read $UPTIME_FILE"
fi
uptime_text=$(<"$UPTIME_FILE")
uptime_field=${uptime_text%%[[:space:]]*}
uptime_seconds=${uptime_field%%.*}
if ! [[ "$uptime_seconds" =~ ^[0-9]+$ ]]; then
  stay_on "could not read uptime from $UPTIME_FILE"
fi

threshold_seconds=$((IDLE_MINUTES * 60))
backstop_seconds=$((BACKSTOP_MINUTES * 60))
people=""
idle_seconds=""
action_idle_seconds=""
decision=""
rule=""

# A read that told us nothing is not proof of idleness: stay on until it has been failing for the
# whole backstop, counted from the last good read (or from boot when there is no record yet).
unreadable() {
  local reason="$1"
  if (( uptime_seconds < BOOT_GRACE_SECONDS )); then
    stay_on "${reason}; the VM booted ${uptime_seconds}s ago, under ${BOOT_GRACE_SECONDS}s"
  fi
  local since boot_epoch now_epoch unreadable_seconds unreadable_minutes
  now_epoch=$(date +%s)
  boot_epoch=$(( now_epoch - uptime_seconds ))
  # A record from before the last switch-off is stale: never count further back than this boot.
  if ! since=$(read_state_epoch) || (( since < boot_epoch )); then
    since=$boot_epoch
  fi
  unreadable_seconds=$(( now_epoch - since ))
  if (( unreadable_seconds < 0 )); then
    unreadable_seconds=0
  fi
  unreadable_minutes=$(( unreadable_seconds / 60 ))
  if (( unreadable_seconds >= backstop_seconds )); then
    log "server unreadable for ${unreadable_minutes} min; switching off (${reason})" >&2
    decision="deallocate: server unreadable for ${unreadable_minutes} min"
    rule="unreadable backstop"
    people="${people:-unknown}"
    idle_seconds="${idle_seconds:-unknown}"
    action_idle_seconds="${action_idle_seconds:-unknown}"
    return 0
  fi
  stay_on "${reason}; unreadable for ${unreadable_minutes} min, under the ${BACKSTOP_MINUTES} min backstop"
}

# Read and validate one snapshot; false means unreadable() has already decided what to do.
read_server() {
  if ! body=$(curl -fsS --max-time 5 "$IDLE_URL" 2>/dev/null); then
    unreadable "GET $IDLE_URL failed"
    return 1
  fi
  if ! people=$(json_get "$body" peopleConnected); then
    unreadable "peopleConnected is missing from $IDLE_URL"
    return 1
  fi
  if ! idle_seconds=$(json_get "$body" idleSeconds); then
    unreadable "idleSeconds is missing from $IDLE_URL"
    return 1
  fi
  if ! action_idle_seconds=$(json_get "$body" actionIdleSeconds); then
    unreadable "actionIdleSeconds is missing from $IDLE_URL"
    return 1
  fi
  if ! [[ "$people" =~ ^[0-9]+$ ]] || ! [[ "$idle_seconds" =~ ^[0-9]+$ ]] ||
    ! [[ "$action_idle_seconds" =~ ^[0-9]+$ ]]; then
    unreadable "peopleConnected, idleSeconds and actionIdleSeconds must be whole numbers"
    return 1
  fi
  return 0
}

if read_server; then
  write_state_epoch
  if (( uptime_seconds < BOOT_GRACE_SECONDS )); then
    decision="stay on: the VM booted ${uptime_seconds}s ago, under ${BOOT_GRACE_SECONDS}s"
    rule="boot grace"
  elif (( action_idle_seconds >= backstop_seconds )); then
    decision="deallocate: no person action for ${action_idle_seconds}s, over the ${backstop_seconds}s backstop"
    rule="action backstop"
  elif (( people > 0 )); then
    decision="stay on: ${people} people connected"
    rule="people connected"
  elif (( idle_seconds < threshold_seconds )); then
    decision="stay on: idle ${idle_seconds}s is under ${threshold_seconds}s"
    rule="idle window"
  else
    decision="deallocate"
    rule="idle window"
  fi
fi

log "decision=${decision} rule=${rule} peopleConnected=${people} idleSeconds=${idle_seconds} actionIdleSeconds=${action_idle_seconds} thresholdSeconds=${threshold_seconds} backstopSeconds=${backstop_seconds} uptimeSeconds=${uptime_seconds}"

if [[ "$DRY_RUN" == "1" ]]; then
  if [[ "$decision" == deallocate* ]]; then
    log "dry run: would POST https://management.azure.com/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Compute/virtualMachines/{name}/deallocate?api-version=${DEALLOCATE_API_VERSION}"
  else
    log "dry run: would make no Azure call"
  fi
  exit 0
fi

if [[ "$decision" != deallocate* ]]; then
  exit 0
fi

if ! token_json=$(curl -fsS --max-time 5 -H 'Metadata:true' \
  "$INSTANCE_METADATA/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/" 2>/dev/null); then
  fail "could not get a managed-identity token from Azure instance metadata"
fi
if ! token=$(json_get "$token_json" access_token); then
  fail "the managed-identity token response had no access_token"
fi

if ! instance_json=$(curl -fsS --max-time 5 -H 'Metadata:true' \
  "$INSTANCE_METADATA/metadata/instance?api-version=2021-02-01" 2>/dev/null); then
  fail "could not read this VM's identity from Azure instance metadata"
fi
if ! subscription=$(json_get "$instance_json" compute.subscriptionId); then
  fail "Azure instance metadata had no subscription id"
fi
if ! resource_group=$(json_get "$instance_json" compute.resourceGroupName); then
  fail "Azure instance metadata had no resource group"
fi
if ! vm_name=$(json_get "$instance_json" compute.name); then
  fail "Azure instance metadata had no VM name"
fi

deallocate_url="https://management.azure.com/subscriptions/${subscription}/resourceGroups/${resource_group}/providers/Microsoft.Compute/virtualMachines/${vm_name}/deallocate?api-version=${DEALLOCATE_API_VERSION}"
if ! status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST \
  -H "Authorization: Bearer ${token}" -H 'Content-Length: 0' "$deallocate_url"); then
  fail "could not reach Azure Resource Manager to deallocate ${vm_name}"
fi
if [[ ! "$status" =~ ^2[0-9][0-9]$ ]]; then
  fail "Azure refused to deallocate ${vm_name} (HTTP ${status})"
fi

log "Azure accepted the deallocate request for ${vm_name} (HTTP ${status}); the VM is switching off"
