# it5007-courseproject-group-14

**Kaki**: a multi-agent meeting assistant. See the [PRD](docs/spec/PRD-kaki-meeting-assistant.md) and the [glossary](CONTEXT.md).

## Getting started

Requires Node 22.

```bash
npm install
npm run dev                       # server on :3001, web app on :5173
npm run emit-demo                 # in a second terminal: sends the scenario's sample events and tasks
npm test                          # all tests
```

`npm run dev` sets `KAKI_DEV_ROUTES=1`, enabling the `/dev/emit` and `/dev/suggest-task` routes that
`npm run emit-demo` uses; set `KAKI_DEV_ROUTES=0` to turn them off. They only answer requests from this machine, so phones on the
Wi-Fi (which the Vite dev server is open to) cannot call them.

Gitea issues use `GITEA_URL`, `GITEA_TOKEN`, `GITEA_ORG` and `GITEA_REPO` from `.env`;
without them a Gitea task fails with a clear message. Mattermost posts use `MATTERMOST_URL`,
`MATTERMOST_TOKEN`, `MATTERMOST_TEAM` and `MATTERMOST_CHANNEL` from `.env`; without them a Mattermost
task fails with a clear message. Emails use `MAILPIT_SMTP_HOST`, `MAILPIT_SMTP_PORT`, `MAILPIT_URL` and
`EMAIL_FROM` from `.env`; without them an email task fails with a clear message.

The shared screen's "Join on your phone" QR codes use `KAKI_PUBLIC_URL` when set (for example
`http://192.168.1.20:5173`); otherwise the server detects its first LAN IPv4 address and uses
`KAKI_WEB_PORT` (default `5173`). Set `KAKI_PUBLIC_URL` if phones cannot reach the detected address.

Open:
- Shared Action Panel: http://localhost:5173/screen
- A participant's phone: http://localhost:5173/phone?role=lead_programmer (roles come from the scenario)

The server keeps state in memory and restarts when server code changes; run `npm run emit-demo` again after a restart.

## Host sign-in (optional)

Auth is off by default, so the in-memory dev flow and the `/phone?role=...` links need no account.
Start the server with `KAKI_AUTH=1` to require a host sign-in for `/screen` and a meeting code for
phones:

```bash
KAKI_AUTH=1 \
POSTGRES_URL="postgres://kaki:kaki_dev_password@127.0.0.1:5433/kaki" \
KAKI_HOST_EMAIL=host@example.com \
KAKI_HOST_PASSWORD=choose-a-dev-password \
npm run dev
```

`KAKI_AUTH=1` requires `POSTGRES_URL` (the demo stack's value is in `docker/.env`); the server
fails at startup without it. On startup, if both `KAKI_HOST_EMAIL` and `KAKI_HOST_PASSWORD` are
set, the server creates that host account when it is missing and never overwrites an existing one.
To add a host account yourself, with the password read from the terminal without echo:

```bash
POSTGRES_URL="..." npm run host:create -- host@example.com
```

Open http://localhost:5173/login to sign in as the host. The server makes one six-character
meeting code per run; it appears with the phone QR codes on the shared screen, and phones join
with the code and a role (no account). Sessions last 12 hours. Set `KAKI_PUBLIC_URL=https://...`
when the app is served over HTTPS so the session cookie is marked `Secure`.

## Working on the code

- Folder ownership and the rules for changing shared code: [docs/ownership.md](docs/ownership.md).
- Demo scenarios: [scenarios/README.md](scenarios/README.md).
