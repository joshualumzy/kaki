# Kaki — Multi-Agent AI Meeting Assistant

**Kaki** is a real-time, multi-agent meeting assistant that pairs a live voice/text meeting stage with private participant wingmen, live company-record RAG, and human-in-the-loop post-meeting actions across 5 external tools.

See the [Product Requirements Document](docs/spec/PRD-kaki-meeting-assistant.md), the [Live Demo Architecture](docs/live-demo.md), the [Human Playtest Findings](docs/playtests/feifei-action-plan.md), and the [Domain Glossary](CONTEXT.md).

---

## 1. Live Cloud Demo (Azure VM)

The project is deployed on Azure (`kaki-vm` in `KAKI-BOT-RG`, Southeast Asia) with automatic Let's Encrypt HTTPS for browser and phone microphone support:

- **Main Meeting App:** **`https://kaki.southeastasia.cloudapp.azure.com`**
  - **Practice** (AI colleagues fill the seats): open `/practice`, no sign-in needed.
  - **Real meeting** (you chair, others join with your invite code): sign in as the meeting owner with `demo@kaki.demo` / `demo`.
- **Cloud Company Systems (Unified Login: `demo` / `demo`):**
  - **Wiki.js:** `http://kaki.southeastasia.cloudapp.azure.com:8081` (`demo` / `demo`)
  - **Gitea:** `http://kaki.southeastasia.cloudapp.azure.com:8082` (`demo` / `demo` — or NPC usernames `wei-ling`, `arjun`, `mei`, `daniel` with password `demo`)
  - **Mattermost:** `https://kaki.southeastasia.cloudapp.azure.com:8443` (`demo` / `demo` — or NPC usernames `weiling`, `arjun`, `mei`, `daniel` with password `demo`)
  - **Mailpit (Email Inbox):** `http://kaki.southeastasia.cloudapp.azure.com:8084` *(no login required)*
  - **Radicale Calendar:** `http://kaki.southeastasia.cloudapp.azure.com:5232` (`demo` / `demo`)

### Waking Up or Stopping the Cloud VM
To save Azure student credits, `kaki-vm` automatically deallocates itself after **2 hours of zero visitor activity**. Anyone with Azure CLI access to `KAKI-BOT-RG` (or via the Azure Portal **Start** button) can wake it up in ~45 seconds:

```bash
npm run cloud:status   # Check if kaki-vm is running and https://kaki.southeastasia.cloudapp.azure.com is online
npm run cloud:up       # Start kaki-vm and wait until the live site and all integrations are ready
npm run cloud:down     # Immediately deallocate kaki-vm ($0/hr compute billing)
```

---

## 2. Architecture Overview

Kaki splits meeting assistance across three specialized agents and an interactive AI attendee engine:

1. **Kaki Host (`server/src/host/`):** Tracks the agenda clock, detects open questions and action items via a grounded LLM Notetaker, auto-dispatches follow-ups to the right role, and triggers closing summaries.
2. **Kaki Wingman (`server/src/wingman/`):** Delivers private, role-filtered nudges when a participant has unshared domain facts, and answers open questions automatically from company records using PostgreSQL + `pgvector` semantic RAG (`bge-m3`).
3. **Kaki Action (`server/src/action/`):** Drafts concrete external artifacts for claimed tasks and executes them upon human approval across 5 live systems—plus drafts full Markdown meeting minutes when a meeting concludes, for a person in the room to approve before they go to the team wiki.
4. **LiveKit NPC Director (`server/src/npc/`):** Powers the interactive voice booth where one or more humans (on laptop or phone) speak or type with AI colleagues over WebRTC (LiveKit + Azure Speech STT/TTS + voice-activity barge-in).

---

## 3. Local Quickstart

Requires **Node 22+** and **Docker Desktop**.

### Step 1: Configure `.env`
Copy `.env.example` to `.env` and fill in the five required keys: your OpenAI-compatible LLM gateway (`KAKI_LLM_BASE_URL`, `KAKI_LLM_API_KEY`, `KAKI_LLM_MODEL`) and Azure Speech (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`):

```bash
cp .env.example .env
```

### Step 2: One command
```bash
npm start
```

This installs dependencies if `node_modules` is missing, starts the 7 Docker containers, seeds the **Nanyang Kopi & Toast (`kopitiam`)** scenario into Postgres, Wiki.js, Gitea, Mattermost, Mailpit, and Radicale Calendar, indexes the knowledge chunks into `pgvector`, starts the Kaki server (:3001), Vite web (:5173) and the AI attendees, then runs the preflight. It stops early with the exact fix if Docker is not running, `.env` is missing, or a required key is empty. The seed generates the Gitea and Mattermost tokens in `docker/.env`, and `npm start` passes them to Kaki for you.

Once running, open **`http://localhost:5173`** (or `http://localhost:5173/demo`) in Chrome.

### Step 3: Stop
```bash
npm stop              # stop the Kaki server, web app and AI attendees
npm stop -- --stack   # also stop the Docker containers
```

---

## 4. Active External Integrations & Unified Logins (`demo` / `demo`)

All backing services run via [`docker/docker-compose.yml`](docker/docker-compose.yml) (see [docker/README.md](docker/README.md)) and use **`demo` / `demo`** as the unified login:

| Integration | Purpose | Local Endpoint | Login (`Username` / `Password`) | Module |
| --- | --- | --- | --- | --- |
| **Gitea** | Creates engineering / ops issues from approved drafts | `http://127.0.0.1:8082` | `demo` / `demo` *(or `wei-ling`, `arjun`, `mei`, `daniel` / `demo`)* | `server/src/action/gitea.ts` |
| **Mattermost** | Posts announcements & updates to team channels | `http://127.0.0.1:8083` | `demo` / `demo` *(or `weiling`, `arjun`, `mei`, `daniel` / `demo`)* | `server/src/action/mattermost.ts` |
| **Wiki.js** | Publishes team wiki pages + approved end-of-meeting minutes | `http://127.0.0.1:8081` | `demo` / `demo` | `server/src/action/wiki.ts` |
| **Mailpit** | Sends drafted emails via SMTP & serves web inbox viewer | `http://127.0.0.1:8084` | *No login required* | `server/src/action/email.ts` |
| **Radicale (CalDAV)** | Books `.ics` calendar events & serves seeded Kopitiam calendar | `http://127.0.0.1:5232` | `demo` / `demo` | `server/src/action/calendar.ts` |
| **PostgreSQL + `pgvector`** | Stores company records & 1024-dim `bge-m3` RAG embeddings | `127.0.0.1:5433` | `kaki` / `kaki_dev_password` | `server/src/wingman/knowledge/` |
| **LiveKit + Azure Speech** | Real-time WebRTC audio room, server VAD, STT & multi-voice TTS | `ws://127.0.0.1:7880` | `devkey` / `secret` | `server/src/npc/` |

> **Per-User Attribution:** When a human visitor joins the meeting with their name, Kaki automatically updates the `demo` profile display name in Gitea and Mattermost to match the visitor's name. Tasks completed by AI colleagues are posted from each NPC's own account (`arjun`, `mei`, `daniel`, `weiling`/`wei-ling`).

---

## 5. Useful Commands

```bash
npm start                 # One-command local demo: checks, Docker, seed, index, server + web + AI, preflight
npm stop                  # Stop local server, web app, and AI attendees (add -- --stack for Docker)
npm run live:up           # Same as npm start (older name)
npm run live:down         # Same as npm stop
npm run cloud:up          # Start Azure VM (kaki-vm) and wait for https://kaki.southeastasia.cloudapp.azure.com
npm run cloud:down        # Deallocate Azure VM ($0/hr compute billing)
npm run cloud:status      # Check Azure VM state and live HTTPS health
npm run stack:up          # Start the 7 Docker containers
npm run seed              # Idempotently seed all Docker services with the Kopitiam scenario
npm run seed:verify       # Run 15 automated health & content checks against the Docker stack
npm run index:knowledge   # Embed and index seeded company records into pgvector
npm run knowledge:check   # Verify live pgvector semantic search & role-filtered facts
npm run typecheck         # Type-check all workspaces (@kaki/shared, @kaki/server, @kaki/web)
npm test                  # Run the full Vitest suite
```

---

## 6. Repository Structure

```text
├── shared/               # Shared TypeScript protocol types, validators, and agenda helpers
├── server/               # Node.js + WebSocket backend & agent modules
│   ├── src/action/       # Kaki Action connectors (Gitea, Mattermost, Email, Wiki.js, Calendar)
│   ├── src/auth/         # Optional host sign-in & 6-character meeting code sessions
│   ├── src/host/         # Kaki Host (agenda clock, grounded LLM notetaker, auto-dispatch)
│   ├── src/npc/          # LiveKit WebRTC runner, NPC Director, VAD barge-in & Azure STT/TTS
│   ├── src/wingman/      # Kaki Wingman (pgvector RAG company search & private role nudges)
│   └── test/             # Unit & integration test suite mirroring src/
├── web/                  # React + Vite frontend
│   ├── src/demo/         # Interactive meeting stage + unified Kaki Wingman dock (/ and /demo)
│   ├── src/screen/       # Shared meeting-room board (/screen)
│   └── src/phone/        # Personal role companion (/phone)
├── scenarios/kopitiam/   # Nanyang Kopi & Toast scenario, seeds, and scripted replay fixtures
├── docker/               # Docker Compose stack & idempotent multi-service seed scripts
├── scripts/              # Local & cloud launchers (live-up.sh, live-down.sh, live-checks.sh, live-preflight.sh, cloud.sh)
└── docs/                 # PRD specification, live demo guide, and human playtest records
```
