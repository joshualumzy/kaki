# Agent Guidelines

## Agent skills

### Issue tracker

GitHub issues tracked via `gh` CLI for `IT5007-2610/it5007-courseproject-group-14`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles mapped 1:1 to GitHub labels (`ready-for-agent`, `needs-triage`, `needs-info`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`CONTEXT.md` at root). See `docs/agents/domain.md`.

### Critical System Safety
- **NEVER kill Chrome:** Do not run `pkill`, `killall`, or `kill` commands targeting "chrome", "Google Chrome", or any browser wildcard. If a Puppeteer process is orphaned, either target its specific PID directly after verifying it is headless, or ask the user to close it. Never risk killing the user's personal browser session.

- **NEVER extract secrets:** Never read from the MacOS Keychain (`security` command), never read raw `~/.ssh/` keys, and never extract global environment variables containing `TOKEN`, `SECRET`, `PASSWORD`, or `API_KEY`. If a task requires a credential, stop and ask the user to provide it or inject it manually.

- **Safe `.env` reading:** Never read the raw contents of `.env` files using `cat` or similar commands that expose secret values to the context/logs. If you need to know the configuration schema, extract only the keys using commands like `awk -F= '{print $1}' .env`. You may only read specific values if you can definitively prove they are non-sensitive configuration (e.g., localhost ports) needed for debugging.
