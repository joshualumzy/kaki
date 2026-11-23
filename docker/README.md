# Kaki Docker Stack

A local, self-hosted company stack used by **Kaki Wingman** (for `pgvector` RAG search) and **Kaki Action** (for live task execution). Every credential is a local development dummy.

## Quickstart

The easiest way to boot, seed, and index the entire stack is from the repository root:

```bash
SCENARIO=kopitiam npm run live:up
```

Or step by step:

```bash
npm run stack:up          # docker compose -f docker/docker-compose.yml up -d
npm run seed              # waits for health, then seeds the active SCENARIO
npm run seed:verify       # verifies API access and seeded records
npm run index:knowledge   # embeds and indexes all 5 data sources into pgvector
```

`npm run seed` is idempotent and writes `docker/.env` (gitignored) with generated Gitea and Mattermost tokens.

## Service Ports (Bound to `127.0.0.1`)

| Service | Local URL | Port | Purpose |
| --- | --- | --- | --- |
| **Wiki.js** | `http://127.0.0.1:8081` | `8081` | Team wiki (RAG source + `wiki_page` action + auto meeting minutes) |
| **Gitea** | `http://127.0.0.1:8082` | `8082` (SSH `2222`) | Issue tracker (RAG source + `gitea_issue` action) |
| **Mattermost** | `http://127.0.0.1:8083` | `8083` | Team chat (RAG source + `mattermost_post` action) |
| **Mailpit** | `http://127.0.0.1:8084` | `8084` (SMTP `1025`) | Email server & web inbox (RAG source + `email` action) |
| **Radicale CalDAV** | `http://127.0.0.1:5232` | `5232` | CalDAV calendar server (`calendar_event` action) |
| **PostgreSQL (`pgvector`)** | `postgres://kaki:kaki_dev_password@127.0.0.1:5433/kaki` | `5433` | Structured company tables + `knowledge_chunks` vector store |
| **LiveKit** | `ws://127.0.0.1:7880` | `7880` | WebRTC audio room for `/practice` |

## Dev Logins (Unified `demo` / `demo`)

- **Wiki.js (`http://127.0.0.1:8081`):** `demo` / `demo`
- **Gitea (`http://127.0.0.1:8082`):** `demo` / `demo` (or `wei-ling` / `demo`)
- **Mattermost (`http://127.0.0.1:8083`):** `demo` / `demo` (or `weiling` / `demo`)
- **Radicale CalDAV (`http://127.0.0.1:5232`):** `demo` / `demo` (no password required)
- **Mailpit (`http://127.0.0.1:8084`):** Opens directly (no login required)

## Resetting the Stack

```bash
npm run stack:down
docker compose -f docker/docker-compose.yml down -v   # wipes all volumes
npm run stack:up && npm run seed && npm run index:knowledge
```
