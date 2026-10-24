# it5007-courseproject-group-14

**Kaki**: a multi-agent meeting assistant. See the [PRD](docs/spec/PRD-kaki-meeting-assistant.md) and the [glossary](CONTEXT.md).

## Getting started

Requires Node 22.

```bash
npm install
KAKI_FAKE_ACTIONS=1 npm run dev   # server on :3001, web app on :5173; fake actions stand in for email
npm run emit-demo                 # in a second terminal: sends the scenario's sample events and tasks
npm test                          # all tests
```

`npm run dev` sets `KAKI_DEV_ROUTES=1`, enabling the `/dev/emit` and `/dev/suggest-task` routes that
`npm run emit-demo` uses; set `KAKI_DEV_ROUTES=0` to turn them off. `KAKI_FAKE_ACTIONS=1` makes fake
actions stand in for email.

Gitea issues use `GITEA_URL`, `GITEA_TOKEN`, `GITEA_ORG` and `GITEA_REPO` from `.env`;
without them a Gitea task fails with a clear message. Mattermost posts use `MATTERMOST_URL`,
`MATTERMOST_TOKEN`, `MATTERMOST_TEAM` and `MATTERMOST_CHANNEL` from `.env`; without them a Mattermost
task fails with a clear message.

Open:
- Shared Action Panel: http://localhost:5173/screen
- A participant's phone: http://localhost:5173/phone?role=lead_programmer (roles come from the scenario)

The server keeps state in memory and restarts when server code changes; run `npm run emit-demo` again after a restart.

## Working on the code

- Folder ownership and the rules for changing shared code: [docs/ownership.md](docs/ownership.md).
- Demo scenarios: [scenarios/README.md](scenarios/README.md).
