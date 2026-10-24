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
`npm run emit-demo` uses; set `KAKI_DEV_ROUTES=0` to turn them off.

Gitea issues use `GITEA_URL`, `GITEA_TOKEN`, `GITEA_ORG` and `GITEA_REPO` from `.env`;
without them a Gitea task fails with a clear message. Mattermost posts use `MATTERMOST_URL`,
`MATTERMOST_TOKEN`, `MATTERMOST_TEAM` and `MATTERMOST_CHANNEL` from `.env`; without them a Mattermost
task fails with a clear message. Emails use `MAILPIT_SMTP_HOST`, `MAILPIT_SMTP_PORT`, `MAILPIT_URL` and
`EMAIL_FROM` from `.env`; without them an email task fails with a clear message.

Open:
- Shared Action Panel: http://localhost:5173/screen
- A participant's phone: http://localhost:5173/phone?role=lead_programmer (roles come from the scenario)

The server keeps state in memory and restarts when server code changes; run `npm run emit-demo` again after a restart.

## Working on the code

- Folder ownership and the rules for changing shared code: [docs/ownership.md](docs/ownership.md).
- Demo scenarios: [scenarios/README.md](scenarios/README.md).
