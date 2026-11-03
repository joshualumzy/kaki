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


## Git safety rules (non-negotiable)

- Work only on the branch the owner names. Push only to `personal`. Do not push to any other remote (including `origin`) unless the owner asks for that specific push in this conversation.
- Never use `git push --force`, `--force-with-lease`, `git reset --hard`, `git checkout -- <path>`, `git clean`, or `git branch -D` without asking the owner first. Say exactly what will be lost, and wait for a yes.
- If a push is rejected or branches have diverged, STOP. Do not force. Run `git fetch`, show the owner `git log --oneline --graph --all -15`, explain the cause in plain words, and propose a fix that keeps every commit, such as `git pull --rebase`. Wait for approval.
- Before discarding any uncommitted change, show `git status` and `git diff --stat` and say what the changes are. Prefer `git stash` over deleting.
- Before every push, run `git fetch personal` and check that the push would be a fast-forward. If it would not, treat it as the case above.
- Other people and other agents push to this repo while you work. Their commits are not yours to remove. After any push, confirm that the remote branch still contains every commit that was there before.
- When you report a git problem, say which commands you ran and what you lost or overwrote, if anything. Do not describe a force push as "aligning" or "syncing".
