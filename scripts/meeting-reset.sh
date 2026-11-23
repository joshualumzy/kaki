#!/usr/bin/env bash
# Discard the saved meeting so the server starts with a clean screen next time.
# Run with: npm run meeting:reset -- <meetingId>
# Resolves configuration exactly as `npm start` does: the shell and root .env win, then the values
# `npm run seed` wrote to docker/.env.
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=scripts/live-checks.sh
. scripts/live-checks.sh
wire_generated_env .env docker/.env
exec npx tsx server/src/persist/reset.ts "$@"
