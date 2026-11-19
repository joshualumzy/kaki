#!/usr/bin/env bash
# Prerequisite checks for scripts/live-up.sh. Sourced, not run: the tests call these with temporary files.
# Nothing here prints a value from an env file; it only tells whether a key is set.

# Print the key names .env.example marks as required, one per line, from its "# required:" line.
required_keys() { # example-file
  [ -f "$1" ] || return 1
  awk '
    /^#[[:space:]]*required:/ {
      sub(/^#[[:space:]]*required:[[:space:]]*/, "")
      n = split($0, names, /[[:space:]]+/)
      for (i = 1; i <= n; i++) if (names[i] != "") print names[i]
    }
  ' "$1"
}

# Print the value of KEY in an env file, without the surrounding quotes, or nothing when it is not set.
env_value() { # env-file key
  local file="$1" key="$2" line value
  [ -f "$file" ] || return 1
  line=$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" 2>/dev/null | tail -n 1)
  [ -n "$line" ] || return 1
  value=${line#*=}
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Print each required key that is missing or empty in the env file. A key already set in the shell counts as set.
missing_required_keys() { # env-file example-file
  local env_file="$1" example="$2" key
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    [ -n "${!key:-}" ] && continue
    [ -z "$(env_value "$env_file" "$key")" ] && echo "$key"
  done < <(required_keys "$example")
  return 0
}

# Whether a key is set in the environment, in .env, or (for the seed-generated tokens) in docker/.env.
key_is_set() { # key file...
  local key="$1" file
  shift
  [ -n "${!key:-}" ] && return 0
  for file in "$@"; do
    [ -n "$(env_value "$file" "$key")" ] && return 0
  done
  return 1
}

# Export the integration settings the seed generates in docker/.env, unless the shell or the user's
# .env already set them (their values win). The names it exported are appended to WIRED_KEYS.
WIRED_KEYS=()
wire_generated_env() { # preferred-env generated-env
  local preferred="$1" generated="$2" key value
  for key in GITEA_URL GITEA_TOKEN GITEA_ORG GITEA_REPO \
             MATTERMOST_URL MATTERMOST_TOKEN MATTERMOST_TEAM MATTERMOST_CHANNEL \
             MAILPIT_URL MAILPIT_SMTP_HOST MAILPIT_SMTP_PORT \
             WIKI_URL WIKI_ADMIN_EMAIL WIKI_ADMIN_PASSWORD CALDAV_URL; do
    [ -n "${!key:-}" ] && continue
    [ -n "$(env_value "$preferred" "$key")" ] && continue
    value=$(env_value "$generated" "$key")
    [ -n "$value" ] || continue
    export "$key=$value"
    WIRED_KEYS+=("$key")
  done
  return 0
}
