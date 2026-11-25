#!/usr/bin/env bash
# Nightly Postgres backup for the Kaki VM. Runs pg_dump inside the compose Postgres container,
# using the POSTGRES_URL from the server's own env file, writes a compressed dump to a root-only
# directory, keeps dumps from the last 7 days and removes older ones. Any failure exits non-zero and is visible
# in journalctl.
set -euo pipefail
umask 077

APP_DIR="${KAKI_APP_DIR:-/home/azureuser/app}"
BACKUP_DIR="${KAKI_BACKUP_DIR:-/var/backups/kaki}"
KEEP_DAYS="${KAKI_BACKUP_KEEP_DAYS:-7}"
ENV_FILE="${KAKI_ENV_FILE:-$APP_DIR/.env}"
COMPOSE_FILE="${KAKI_COMPOSE_FILE:-$APP_DIR/docker/docker-compose.yml}"
HELPER="$APP_DIR/deploy/backup/read-postgres-url.mjs"

log() {
  printf 'kaki-backup: %s\n' "$*"
}

fail() {
  log "$*" >&2
  exit 1
}

tmp=""
cleanup() {
  if [[ -n "$tmp" && -f "$tmp" ]]; then
    rm -f -- "$tmp"
  fi
}
trap cleanup EXIT

if ! [[ "$KEEP_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  fail "KAKI_BACKUP_KEEP_DAYS must be a positive whole number, got '$KEEP_DAYS'"
fi
command -v docker >/dev/null 2>&1 || fail "docker is required to run pg_dump in the Postgres container"
command -v node >/dev/null 2>&1 || fail "node is required to read POSTGRES_URL from $ENV_FILE"
command -v gzip >/dev/null 2>&1 || fail "gzip is required to compress the dump"
[[ -r "$ENV_FILE" ]] || fail "cannot read the server env file $ENV_FILE"
[[ -r "$COMPOSE_FILE" ]] || fail "cannot read the Postgres compose file $COMPOSE_FILE"
[[ -r "$HELPER" ]] || fail "cannot read $HELPER"

if ! read -r DB_USER DB_NAME < <(node "$HELPER" "$ENV_FILE"); then
  fail "could not read the database user and name from POSTGRES_URL in $ENV_FILE"
fi
if [[ -z "$DB_USER" || -z "$DB_NAME" ]]; then
  fail "POSTGRES_URL in $ENV_FILE must name a user and a database"
fi

install -d -m 700 -o root -g root "$BACKUP_DIR" ||
  fail "could not create $BACKUP_DIR with owner-only permissions"
chmod 700 "$BACKUP_DIR" || fail "could not make $BACKUP_DIR owner-only"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_DIR/kaki-$stamp.sql.gz"
tmp="$BACKUP_DIR/.kaki-$stamp.sql.gz.tmp"

log "dumping database '$DB_NAME' as '$DB_USER' from $COMPOSE_FILE"
if ! docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump --clean --if-exists --no-owner --no-privileges --no-password -U "$DB_USER" -d "$DB_NAME" |
  gzip -c >"$tmp"; then
  fail "pg_dump failed; no new backup was kept"
fi

[[ -s "$tmp" ]] || fail "pg_dump produced an empty file"
gzip -t "$tmp" || fail "the compressed dump is corrupt"
if ! gzip -dc "$tmp" | tail -n 5 | grep 'PostgreSQL database dump complete' >/dev/null; then
  fail "the dump is incomplete (no pg_dump completion marker)"
fi

chmod 600 "$tmp" || fail "could not make the new dump owner-only"
mv -f -- "$tmp" "$target" || fail "could not move the new dump into $target"
tmp=""
log "wrote $target ($(wc -c <"$target") bytes)"

if ! old_backups=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'kaki-*.sql.gz'  -mtime +"$((KEEP_DAYS - 1))" ! -path "$target"); then
  fail "could not list old backups in $BACKUP_DIR for retention"
fi
while IFS= read -r old; do
  [[ -n "$old" ]] || continue
  rm -f -- "$old" || fail "could not remove old backup $old"
  log "removed old backup $old"
done <<<"$old_backups"

kept=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'kaki-*.sql.gz' | wc -l)
log "kept backups from the last $KEEP_DAYS days ($kept present)"
