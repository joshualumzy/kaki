# Kaki — Multi-Agent AI Meeting Assistant

**Kaki** is a real-time, multi-agent meeting assistant that pairs a shared room display with private participant wingmen and automated post-meeting actions. See the [Product Requirements Document](docs/spec/PRD-kaki-meeting-assistant.md), the [Live Demo Architecture](docs/live-demo.md), and the [Domain Glossary](CONTEXT.md).

---

## Architecture Overview

Kaki splits meeting assistance across three specialized agents and an optional AI attendee engine:

1. **Kaki Host (`server/src/host/`):** Tracks the agenda clock, detects open questions and action items via a grounded LLM Notetaker, auto-dispatches follow-ups to the right role, and triggers closing summaries.
2. **Kaki Wingman (`server/src/wingman/`):** Delivers private, role-filtered nudges when a participant has unshared domain facts, and answers open questions automatically from company records using PostgreSQL + `pgvector` semantic RAG (`bge-m3`).
3. **Kaki Action (`server/src/action/`):** Drafts concrete external artifacts for claimed tasks and executes them upon human approval across 5 live systems—plus automatically publishes full Markdown meeting minutes to the team wiki when a meeting concludes.
4. **LiveKit NPC Director (`server/src/npc/`):** Powers the interactive `/demo` voice booth where a visitor speaks or types with AI colleagues over WebRTC (LiveKit + Azure Speech STT/TTS + voice-activity barge-in).

---

## Quickstart (One-Command Live Stack)

Requires **Node 22** and **Docker Desktop**. Copy `.env.example` to `.env` and fill in your OpenAI-compatible LLM gateway (`KAKI_LLM_BASE_URL`, `KAKI_LLM_API_KEY`) and optional Azure Speech keys (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`).

```bash
npm install

# Start the full stack (Docker services, scenario seeding, pgvector indexing, web + server + NPC runner)
SCENARIO=kopitiam npm run live:up

# Stop background processes cleanly
npm run live:down
```

Switch between the two built-in scenarios using `SCENARIO=kopitiam` (**Nanyang Kopitiam Co.**) or `SCENARIO=pixel-kampung` (**Lah Studios**, default). See [scenarios/README.md](scenarios/README.md).

### Application Views

Once running, open in Chrome or Edge:
- **Interactive Voice Booth (`/demo`):** `http://localhost:5173/demo?mode=live` — Unified LiveKit stage on the left + private Kaki Wingman dock on the right.
- **Shared Room Screen (`/screen`):** `http://localhost:5173/screen` — Shared agenda clock, live activity feed, and Kanban task board (`Suggested`, `In progress`, `Done`).
- **Personal Phone Wingman (`/phone`):** `http://localhost:5173/phone?role=lead_programmer` — Role-filtered mobile companion for private nudges, company record lookups, and action draft approvals.

---

## Active External Integrations (7 Services)

All backing services run locally via [`docker/docker-compose.yml`](docker/docker-compose.yml) (see [docker/README.md](docker/README.md)):

| Integration | Purpose | Local Endpoint | Module |
| --- | --- | --- | --- |
| **Gitea** | Creates engineering / ops issues from approved drafts | `http://127.0.0.1:8082` | `server/src/action/gitea.ts` |
| **Mattermost** | Posts announcements & updates to team channels | `http://127.0.0.1:8083` | `server/src/action/mattermost.ts` |
| **Mailpit (SMTP / REST)** | Sends drafted external/internal emails & links to web viewer | `http://127.0.0.1:8084` | `server/src/action/email.ts` |
| **Wiki.js (GraphQL)** | Publishes team wiki pages + automatic end-of-meeting minutes | `http://127.0.0.1:8081` | `server/src/action/wiki.ts` |
| **Radicale (CalDAV)** | Books `.ics` calendar events & serves human-readable viewer | `http://127.0.0.1:5232` | `server/src/action/calendar.ts` |
| **PostgreSQL + `pgvector`** | Stores company records & 1024-dim `bge-m3` RAG embeddings | `127.0.0.1:5433` | `server/src/wingman/knowledge/` |
| **LiveKit + Azure Speech** | Real-time WebRTC audio room, server VAD, STT & multi-voice TTS | `ws://127.0.0.1:7880` | `server/src/npc/` |

---

## Manual / Step-by-Step Commands

```bash
npm run stack:up          # Start Docker services (Postgres, Wiki.js, Gitea, Mattermost, Mailpit, Radicale, LiveKit)
npm run seed              # Seed the active scenario's company data into all Docker services
npm run index:knowledge   # Embed and index seeded company records into pgvector
npm run dev               # Start Kaki server (:3001) and Vite web app (:5173)
npm run npc               # Start AI attendees in the LiveKit room
npm run emit-demo         # Emit sample events and tasks in-memory (dev mode)
npm run typecheck         # Type-check all workspaces (@kaki/shared, @kaki/server, @kaki/web)
npm test                  # Run the full Vitest unit & integration suite
```

---

## Repository Structure

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
│   ├── src/demo/         # /demo interactive booth stage + unified Kaki Wingman dock
│   ├── src/screen/       # /screen shared meeting-room board
│   └── src/phone/        # /phone personal role companion
├── scenarios/            # Pluggable scenarios (kopitiam, pixel-kampung) with seeds & replays
├── docker/               # Docker Compose stack & idempotent multi-service seed scripts
├── scripts/              # One-command stack launchers (live-up.sh, live-down.sh, live-preflight.sh)
└── docs/                 # PRD specification and live demo architecture guide
```
