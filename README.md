# Kaki

A meeting assistant that gives every seat a private wingman.

[Live demo](https://green-sky-0c9a41800.4.azurestaticapps.net) · [Screenshots](#screenshots) · [Architecture](#how-it-works) · [Run locally](#run-locally) · [Poster](docs/poster/kaki-a1-poster.pdf)

![Kaki meeting room](docs/images/meeting-room.png)
*A practice meeting. Kaki Wingman has just handed the Operations Director a private fact for the question on the table.*

Kaki (Singlish for "buddy" or "one of us") helps a small team run a meeting and finish the work it creates. The owner sets an agenda and opens a room, and people join from a laptop or phone, by speaking or typing. A seat is one role in the meeting, and each person gets private facts and prompts for the seat they hold, while a neutral host keeps the clock and watches the conversation. Follow-ups then become a ticket, post, email, wiki page or calendar event, and the minutes go to the team wiki, each as a draft for a person to approve.

## Highlights

- Each seat has a private wingman that answers from company records and sends its cards only to that person's screen.
- AI colleagues fill the other seats in a practice meeting, take turns and stop when interrupted.
- Approved follow-ups become a Gitea issue, Mattermost post, email, wiki page or calendar event.
- Minutes arrive as an editable card, and the wiki page is written after a person approves it.
- The meeting works on a phone, with the stage above the dock on narrow screens.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="docs/images/landing.png" alt="Kaki landing page" width="420"><br><sub>Choose a team meeting or a practice meeting.</sub></td>
    <td align="center"><img src="docs/images/setup.png" alt="Kaki setup editor" width="420"><br><sub>Edit the plan, with validation before anyone joins.</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/owner-lobby.png" alt="Kaki owner lobby" width="420"><br><sub>The owner lobby shares the link, code and QR code.</sub></td>
    <td align="center"><img src="docs/images/phone-join.png" alt="Kaki join screen on a phone" width="260"><br><sub>The join screen on a phone.</sub></td>
  </tr>
</table>

## Team

| Name | Matriculation number | Area |
| --- | --- | --- |
| Xiao Xiao | A0332142W | Kaki Host |
| Joshua Lum Zi Yuan | A0108499N | Kaki Wingman |

## Contents

- [Highlights](#highlights)
- [Screenshots](#screenshots)
- [Team](#team)
- [Try it](#try-it)
- [Why Kaki](#why-kaki)
- [How it works](#how-it-works)
- [What's new](#whats-new)
- [Front-end features](#front-end-features)
- [Back-end features](#back-end-features)
- [Built with React](#built-with-react)
- [Technology choices](#technology-choices)
- [Engineering quality](#engineering-quality)
- [Run locally](#run-locally)
- [Integrations](#integrations)
- [Commands](#commands)
- [Project management](#project-management)
- [Competitor analysis](#competitor-analysis)
- [Legal and open source](#legal-and-open-source)
- [Business model](#business-model)
- [Credits](#credits)
- [Repository structure](#repository-structure)
- [Sources](#sources)

## Try it

Start at **[green-sky-0c9a41800.4.azurestaticapps.net](https://green-sky-0c9a41800.4.azurestaticapps.net)**. That page is always on. The demo itself runs on an Azure VM (HTTPS, so browsers and phones allow the microphone) that switches itself off when nobody is using it; if it is off, choosing an option on the start page wakes it, which takes a minute or two, and then takes you where you chose. The other links below work once it is awake.

| What | Where | Sign-in |
| --- | --- | --- |
| Team meeting, owner view | [kaki.southeastasia.cloudapp.azure.com](https://kaki.southeastasia.cloudapp.azure.com) | `demo@kaki.demo` / `demo` (cloud deployment only) |
| Practice meeting with AI colleagues | [/practice](https://kaki.southeastasia.cloudapp.azure.com/practice) or [/demo](https://kaki.southeastasia.cloudapp.azure.com/demo) | No sign-in |
| Wiki.js | [Port 8081](http://kaki.southeastasia.cloudapp.azure.com:8081) | `demo` / `demo` |
| Gitea | [Port 8082](http://kaki.southeastasia.cloudapp.azure.com:8082) | `demo` / `demo` (or `wei-ling`, `arjun`, `mei`, `daniel` / `demo`) |
| Mattermost | [Port 8443](https://kaki.southeastasia.cloudapp.azure.com:8443) | `demo` / `demo` (or `weiling`, `arjun`, `mei`, `daniel` / `demo`) |
| Mailpit inbox | [Port 8084](http://kaki.southeastasia.cloudapp.azure.com:8084) | No login |
| Radicale calendar | [Port 5232](http://kaki.southeastasia.cloudapp.azure.com:5232) | `demo` / `demo` |

In a team meeting, sign in as the owner, set the agenda, open the room and share the invite code. Everyone else joins with the code and picks a seat. In a practice meeting, the AI colleagues take the other seats and the visitor can speak or type.

The VM switches itself off after 60 minutes with nobody connected, or after 2 hours with nobody speaking, typing or clicking (a forgotten open tab). A meeting cut off this way is saved and comes back when the VM wakes. The waking page is in `wake/` and the switch-off check in `deploy/idle/`. You can also run Kaki locally with `npm start` (see [Run locally](#run-locally)).

```bash
npm run cloud:status   # Check the VM and the live HTTPS health endpoint
npm run cloud:up       # Start kaki-vm and wait until the site and integrations are ready
npm run cloud:down     # Deallocate kaki-vm ($0/hr compute billing)
```

## Why Kaki

A meeting host has to present, watch the clock, keep the agenda and record who agreed to do what, and in a hybrid meeting much of that is harder. When the person who knows the answer stays quiet, the question can sit open for the rest of the call.

Zoom AI Companion 3.0 drafts tasks and emails inside Zoom, and Otter.ai Live Assist gives private coaching tips while the call runs. The harder part is deciding when to stay silent, who needs which fact, and how to write into another system without surprising anyone. Kaki splits those jobs between a neutral host, a private wingman for each participant and an action agent that writes into the team's own tools.

Several parts were hard to get right. In a live meeting several people can talk at once, and each person's microphone is transcribed on its own, so the transcript has to keep their lines apart. A follow-up should not be sent until its agenda item is settled, a private card must reach only one seat, and the AI colleagues have to take turns and stop when someone interrupts.

In two years, personal help during a live meeting should feel as ordinary as the recap does today. In five, a team should expect the meeting to leave finished work behind, such as an issue opened and an email sent. In ten, the assistant should be part of how the team runs, with the open questions being trust and permission.

## How it works

```mermaid
flowchart LR
  Owner["Owner browser"] --> Web["Web app (React + Vite)"]
  People["Participant and phone browsers"] --> Web
  Web -->|"HTTP + WebSocket /ws"| Server["Kaki server (Node + TypeScript)"]
  Server --> Host["Kaki Host: agenda clock, notetaker, auto-dispatch"]
  Server --> Wingman["Kaki Wingman: nudges, company search"]
  Server --> Action["Kaki Action: drafts, approval, connectors"]
  Host --> PG[("Postgres + pgvector<br/>vector search inside Postgres")]
  Wingman --> PG
  Host --> LLM["OpenAI-compatible LLM gateway"]
  Wingman --> LLM
  Action --> LLM
  Action --> Tools["Gitea, Mattermost, Wiki.js, Mailpit, Radicale"]
  Web -->|"WebRTC audio"| LiveKit["LiveKit room"]
  NPC["NPC runner: Director, Azure STT/TTS (AI colleagues)"] --> LiveKit
  NPC -->|"service channel"| Server
```

The browser holds no API keys. It talks to the Kaki server and to LiveKit with a room token from the server. Every LLM call, Azure Speech call and company-tool write is made by the server or by the NPC runner.

Meeting state lives in one server process and is saved to Postgres, so a restart restores the meeting where it was. When a phone joins with the meeting code and picks a seat, the server decides which messages that seat receives. A private card for one role never reaches another role's screen.

Company records sit in the same Postgres database, so a question can match a record by meaning as well as by its words.

| Agent | What it does | Code |
| --- | --- | --- |
| Kaki Host | Runs the agenda clock, keeps the meeting record, finds open questions and follow-ups, dispatches work to the right role and triggers the closing summary. | `server/src/host/` |
| Kaki Wingman | Sends private, role-aware nudges when an item is about to start or a role has been quiet. Answers questions from company records with a source and date. | `server/src/wingman/` |
| Kaki Action | Drafts a concrete issue, post, email, wiki page or calendar event, then runs it after the assignee approves. It also drafts the minutes for a person to approve before the wiki write. | `server/src/action/` |
| NPC Director and runner | Plays the AI colleagues (NPCs in the code) over LiveKit. One Director speaks for every AI colleague, one at a time. The runner uses Azure Speech, voice-activity detection and barge-in (stops talking when someone talks over it). | `server/src/npc/` |

Here is the path of one follow-up. Someone in the meeting says, "I'll email the supplier." The notetaker proposes a follow-up from that transcript line and keeps the evidence (`server/src/host/notetakerTasks.ts`). The host dispatches it to that person's role (`server/src/host/autoDispatch.ts`). The task store publishes the card only to their seat (`server/src/meeting/tasks.ts`), and the dock shows it privately (`web/src/meeting/room/ActiveRoleCards.tsx`). They edit the draft and press Approve. The action runner checks the draft against its source and runs it (`server/src/action/runner.ts`, `server/src/action/draftGrounding.ts`). Mailpit receives the email (`server/src/action/email.ts`).

## What's new

Every seat has a role card with the facts that role holds, and Kaki Wingman knows which role owns the current agenda item. When that item comes up, or its owner has gone quiet, the nudge goes to that one person's screen. Answers come from the team's own wiki, issues, chat and email, and each fact carries its source and date. The owner sets the nudge pace before the meeting.

Kaki Host has no voice of its own. It keeps the agenda clock, flags an item that runs over and hands out follow-ups on screen. When an AI colleague chairs the meeting, that colleague speaks the host's welcome, hand-overs and close in their own words. When a person chairs, the same cues reach them as on-screen suggestions, and any AI colleague stops when someone talks over it.

Kaki can open a Gitea issue, post to Mattermost, send an email, book a calendar slot or publish minutes to the wiki. Each one starts as a draft for the person who owns the task, and the draft is checked against what was actually said. Nothing is written until that person approves it.

Questions and follow-ups are proposed only from transcript lines, and a second model pass judges whether the meaning matches. A doubtful case is left unresolved.

In a practice meeting, one person sits with four AI colleagues who speak in their own voices, take turns, react to what is said and stop when interrupted, using the same room and flow as a team meeting.

## Front-end features

The web app is one React and Vite application. It serves these paths (`web/src/App.tsx`): `/` (landing), `/practice` and `/demo` (the same practice meeting page), `/join` (participant join), `/meeting` (owner meeting), `/login` (host sign-in) and `/setup` (meeting setup). Any other path redirects to `/`.

The design uses shared colour and type tokens in `web/src/ui/tokens.css` and shared components in `web/src/ui` (`Button`, `Card`, `StatusPill`). The meeting stage takes the most space, private cards sit in the dock beside it, and on a narrow screen the stage stacks above the dock.

Screen map:

- `/` leads to `/setup` for the owner, to `/practice` for a practice meeting, and to `/join?code=...` when someone enters an invite code. When sign-in is on, the owner goes through `/login?return=/setup` first.
- `/setup` opens the meeting and goes to `/meeting` when the owner presses Open the meeting room.
- `/meeting` shows the owner room. When sign-in is on and the visitor is not the owner, it redirects to `/login?return=/meeting`.
- `/login` returns to the page in `return`, or to `/meeting`.
- `/join` holds the participant join form and then the participant room on the same page.
- `/demo` opens the same page as `/practice`.
- Any other path redirects to `/`.

### Plan the meeting (front end)

- When sign-in is on, hosts sign in first, then edit the title, organisation, agenda items, roles, seats and nudge pace. Field errors appear next to the input, and the page can import the Kopitiam demo (a Singapore coffee shop, the setting of the practice meeting) or start a blank plan. `web/src/setup/SetupPage.tsx`, `web/src/setup/SetupEditor.tsx`, `web/src/setup/SetupDraft.tsx`, `shared/src/setupParse.ts`
- The setup page lists each connected tool and offers a connection test. `web/src/setup/ToolsSection.tsx`

### Invite and join (front end)

- The owner lobby shows the invite link, the six-character code and a QR code, lists who has joined, and starts or closes the room. `web/src/meeting/MeetingOverlays.tsx`
- People join with a name and a seat, choose a microphone and camera, and enter the meeting code when the room is already running. The join button stays disabled until the required fields are valid. `web/src/meeting/room/JoinForm.tsx`, `web/src/meeting/TeamJoinForm.tsx`
- A participant sees a waiting card until the owner starts. A reload or a dropped connection restores the same name and seat while the grace window is open, with a countdown. `web/src/meeting/MeetingOverlays.tsx`, `web/src/meeting/room/rejoinSession.ts`

### During the meeting (front end)

- The stage shows each person's LiveKit tile, who is speaking, live captions and reaction badges. AI colleagues appear as animated orbs. `web/src/meeting/room/MeetingGrid.tsx`, `web/src/meeting/room/CaptionedTile.tsx`, `web/src/meeting/room/Orb.tsx`, `web/src/meeting/room/stageModel.ts`
- A briefing covers the stage until the visitor presses Start. The AI colleagues stay silent before that. `web/src/meeting/room/StartPrompt.tsx`
- The dock carries the role card, the situation, the agenda clock, a topic cheat sheet, the transcript, the task board and any private task card. `web/src/meeting/room/Dock.tsx`, `web/src/meeting/room/RoleCard.tsx`, `web/src/meeting/room/SituationCard.tsx`, `web/src/meeting/room/ActiveRoleCards.tsx`, `web/src/meeting/room/MeetingPanel.tsx`
- People can type to the room instead of speaking, and pause or resume the meeting clock. `web/src/meeting/room/TypeBar.tsx`
- Microphone and speaker controls show a live level. A phone can tap to start playback when the browser blocks it. `web/src/meeting/room/MediaPreview.tsx`, `web/src/meeting/room/AudioUnlock.tsx`
- Narrow screens put the stage above the dock and keep the type bar at the bottom. `web/src/meeting/room/demo.css`
- One hook holds the WebSocket connection, the event window, the task list and the send function. `web/src/kaki/useKaki.ts`

### After the meeting (front end)

- Each follow-up arrives as a card for one person. They can accept or decline, edit the draft and press Approve, or retry a failed write. `web/src/meeting/room/ActiveRoleCards.tsx`, `web/src/meeting/room/TaskControls.tsx`
- The minutes arrive as an editable card assigned to a person in the room. The wiki link appears only after that person approves the page. `web/src/meeting/room/ActiveRoleCards.tsx`

### Practise alone

- `/practice` and `/demo` open a meeting where AI colleagues fill the other seats. The visitor can speak or type, and the AI stops when interrupted. `web/src/meeting/room/Meeting.tsx`, `web/src/meeting/room/TypeBar.tsx`

## Back-end features

### Platform

- One route table declares every HTTP path and its access level: public, session, host, host-or-practice, service or dev. An unlisted path returns 404. `server/src/app.ts`, `server/src/http/routes/`
- One WebSocket hub carries the typed protocol. Each event names its audience, and the server delivers it only to the connections that audience covers. `server/src/core/hub.ts`, `server/src/core/audience.ts`, `shared/src/events.ts`, `shared/src/commands.ts`
- A meeting moves through lobby, starting, running and ended. An empty room keeps the same seats for a grace period, and a restored meeting keeps its code and start time. `server/src/meeting/session.ts`, `server/src/meeting/rejoin.ts`, `server/src/persist/`
- Scenario packs supply roles, attendees, AI profiles, agenda, seed data and a replay transcript. `SCENARIO` names the folder to load. `server/src/core/loadScenario.ts`, `scenarios/README.md`
- Idempotent seed scripts load the Kopitiam company records into Gitea, Mattermost, Wiki.js, Mailpit, Radicale and Postgres. `docker/seed/index.ts`, `docker/seed/gitea.ts`, `docker/seed/mattermost.ts`, `docker/seed/wiki.ts`, `docker/seed/mail.ts`, `docker/seed/calendar.ts`, `docker/seed/postgres.ts`
- `npm start` checks Docker and `.env`, starts the seven containers, seeds the company, indexes knowledge, starts the server, web app and AI runner, then runs a preflight. `scripts/live-up.sh`
- `npm run cloud:up`, `cloud:down` and `cloud:status` manage the Azure VM. `scripts/cloud.sh`

### Authentication

- Host sign-in is off unless `KAKI_AUTH=1`. When it is on, host accounts use scrypt password hashes and 12-hour sessions, and `npm run host:create` adds an account. `server/src/auth/`, `server/src/index.ts`

### Plan the meeting (back end)

- The setup parser runs in the browser and again on the server. It checks role ids, unique labels, agenda owners, seat kinds, nudge pace and required fields. `shared/src/setupParse.ts`, `shared/src/setupScenario.ts`, `server/src/http/routes/setup.ts`
- The setup page can import the demo calendar invite and turn its agenda into a draft. `server/src/http/routes/setup.ts`

### Invite and join (back end)

- Meeting-code admission and LiveKit tokens take a seat through the same meeting record. `server/src/auth/module.ts`, `server/src/services/livekit.ts`, `server/src/http/routes/meeting.ts`, `server/src/meeting/session.ts`
- Meeting codes use six characters from an alphabet without look-alikes, with five attempts per address per minute. `server/src/meeting/meetingCode.ts`

### During the meeting (back end)

- The agenda clock tracks the current item, elapsed time, overrun, pause and resume, with a replay speed for scripted runs. `server/src/host/clock.ts`
- The notetaker turns new transcript lines into the meeting record. Separate passes handle questions and tasks, and a verifier judges meaning rather than word overlap. `server/src/host/notetaker.ts`, `server/src/host/notetakerQuestions.ts`, `server/src/host/notetakerTasks.ts`, `server/src/host/notetakerVerifier.ts`, `server/src/host/notetakerPrompt.ts`
- The host dispatches suggested tasks to their role. A held card waits until its agenda item settles. If a person holds the host seat, the card waits for that person. `server/src/host/autoDispatch.ts`
- The wingman sends a coming-up nudge before the next item and a quiet-owner nudge during the current item. Each goes only to that role. `server/src/wingman/nudges/module.ts`
- Company search merges pgvector cosine search with Postgres full-text search using reciprocal rank fusion, then writes a role-aware answer with a source and date for each fact. `server/src/wingman/knowledge/search.ts`, `server/src/wingman/knowledge/gateway.ts`
- The NPC Director plays every AI colleague from the scenario profiles. The runner joins LiveKit, publishes audio, recognises each person's speech with Azure STT, synthesises with Azure TTS, and stops on barge-in. `server/src/npc/director.ts`, `server/src/npc/conversation.ts`, `server/src/npc/runner.ts`, `server/src/npc/vad.ts`, `server/src/npc/speechGate.ts`

### After the meeting (back end)

- The task store is the only code that changes task state. It enforces `SUGGESTED`, `DISPATCHED`, `CLAIMED`, `DRAFT_READY`, `RUNNING`, `COMPLETED`, `FAILED` and `SYNCED`, and only the assignee can approve. `server/src/meeting/tasks.ts`
- Kaki Action drafts the artifact for an accepted task and checks the draft against its source before it runs. `server/src/action/runner.ts`, `server/src/action/draft.ts`, `server/src/action/draftGrounding.ts`
- Five connectors write to Gitea issues, Mattermost posts, Mailpit email, Wiki.js pages and Radicale calendar events. `server/src/action/gitea.ts`, `server/src/action/mattermost.ts`, `server/src/action/email.ts`, `server/src/action/wiki.ts`, `server/src/action/calendar.ts`
- On the closing signal, Kaki builds Markdown minutes from the record, tasks and transcript, assigns the card to a person in the room, and writes to Wiki.js only after that person approves. `server/src/action/wiki.ts`
- The knowledge indexer reads Wiki.js, Gitea, Mattermost, Mailpit and Postgres, chunks the records and writes 1024-dimension `bge-m3` embeddings. `server/src/wingman/knowledge/indexer.ts`, `server/src/wingman/knowledge/cli.ts`

## Built with React

| React idea | Where Kaki uses it | Why |
| --- | --- | --- |
| Components and typed props | `MeetingGrid`, `CaptionedTile`, `RoleCard`, `Dock` in `web/src/meeting/room/` | Stage tiles and dock cards take explicit props, so the same card renders for an owner, a participant or a practice visitor. |
| Side effects with `useEffect` | `web/src/kaki/useKaki.ts`, `web/src/meeting/room/Meeting.tsx` | The WebSocket reconnects and the LiveKit connection and rejoin flow start and stop with the page. |
| Refs with `useRef` | `web/src/kaki/useKaki.ts`, `web/src/kaki/ScenarioContext.tsx` | Socket handles, pending typed lines and load ordering must survive renders without causing another render. |
| Custom hooks | `useKaki` (`web/src/kaki/useKaki.ts`), `useScenario` and `useRefreshScenario` (`web/src/kaki/ScenarioContext.tsx`), `useMe` (`web/src/auth/useMe.ts`) | Each hook packages one piece of shared behaviour: live events, the active scenario and the sign-in check. |
| Context with `createContext` | `web/src/kaki/ScenarioContext.tsx` | Every page reads the same scenario without passing it through each component. |
| Routing with React Router 7 | `web/src/App.tsx`, `useNavigate` in `LandingPage`, `LoginPage` and `SetupPage`, `useSearchParams` in `LoginPage` and `ParticipantJoinPage` | The routes cover the landing, join, setup, sign-in and meeting flows, and the invite code travels in the URL. |
| Controlled forms and validation | `web/src/meeting/room/JoinForm.tsx`, `web/src/setup/SetupEditor.tsx` | Submit stays disabled until required fields are valid, and the server's refusal appears next to the form. |
| Error boundary | `web/src/meeting/room/ErrorBoundary.tsx`, used in `Dock` | A broken card shows an error instead of taking down the meeting page. |
| LiveKit React components | `LiveKitRoom`, `useTracks`, `ParticipantTile`, `RoomAudioRenderer`, `useRoomContext` from `@livekit/components-react` | The room, tiles and audio renderer come from the LiveKit React package. |
| Vite dev server with proxy | `web/vite.config.ts` | `/api`, `/health`, `/ws` and `/dev` reach the Kaki server during development, and only this machine may call `/dev`. |

Kaki uses React 19, React Router 7 and Vite 8.

## Technology choices

The IT5007 stack pairs React with GraphQL and MongoDB. Kaki keeps React and chooses a different API and database, because a live meeting has different needs from a page of records.

| Choice | What Kaki uses | Why |
| --- | --- | --- |
| Live API | REST routes plus a WebSocket hub | Setup, sign-in, meeting codes and approvals are request/response calls, so REST keeps each one small and direct. The meeting also needs live pushes to one seat, so one WebSocket stream carries events with an audience and the server routes each one. GraphQL subscriptions would add a query layer over the same push path. |
| Database | PostgreSQL with pgvector | Company records, meeting state, sessions and 1024-dimension embeddings live in one transactional database. Hybrid vector and full-text search runs in the same place, so a search sees the same records the meeting uses. A self-hosted MongoDB would need a separate vector index for that search (MongoDB Atlas has vector search built in). |
| Language | TypeScript end to end with a shared protocol package | `shared/` holds events, commands, task states and parsers that both the server and the web app compile against. |
| Real-time audio | LiveKit | The meeting room, room tokens and WebRTC audio come from one self-hosted server. |
| Speech | Azure Speech | Recognition and multi-voice synthesis run server-side for the AI colleagues. |
| Local stack | Docker Compose | Seven services start together and seed from the same scenario data. |

## Engineering quality

The repository is a TypeScript workspace with three packages: `shared/`, `server/` and `web/`. `shared/` holds the protocol and the rules both sides must agree on, including events, commands, task states, scenario parsing and setup parsing. The server is split by responsibility (`core`, `http`, `meeting`, `host`, `wingman`, `action`, `npc`, `auth`, `persist`, `services`). The web app is split by page and feature (`landing`, `auth`, `setup`, `meeting`, `kaki`, `ui`, `net`), with shared buttons, cards, labels and artifact links in `web/src/ui/`. Every exported function, component and type carries a short comment.

Input is checked on both sides. The setup parser checks the plan before it is saved, and the server re-checks every setup write. Commands from a socket are validated against the scenario before the hub accepts them. The action connectors reject a draft that adds details its source does not support.

Web tests sit next to their components. The server, shared and seed tests live in their own test folders (`server/test/`, `shared/test/`, `docker/seed/`), and the playtest helpers are tested in `scripts/`. `npm test` runs the Vitest suite for all of them, including unit tests and integration tests that drive the HTTP and WebSocket API. `npm run typecheck` checks the whole workspace.

Playwright drives the real app in installed Google Chrome:

- `npm run playtest:team` runs a typed three-person meeting, including the lobby, meeting code, private cards, follow-up approval and minutes published to the wiki.
- `npm run playtest:team -- --voice` runs the same meeting with generated speech through a fake microphone.
- `npm run playtest:live` runs one visitor through the practice meeting with the AI colleagues.
- `npm run playtest:ai` lets a language model play the visitor in one of nine styles, then a second model judges the meeting.

See [How we tested Kaki](docs/testing.md) for the full test map.

## Run locally

Requires Node 22+ and Docker Desktop.

Copy `.env.example` to `.env` and fill the five required keys: an OpenAI-compatible LLM gateway (`KAKI_LLM_BASE_URL`, `KAKI_LLM_API_KEY`, `KAKI_LLM_MODEL`) and Azure Speech (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`).

```bash
cp .env.example .env
npm start
```

`npm start` installs dependencies if `node_modules` is missing, starts the seven Docker containers, seeds the **Nanyang Kopi & Toast (`kopitiam`)** scenario into Postgres, Wiki.js, Gitea, Mattermost, Mailpit and Radicale Calendar, indexes the knowledge chunks into pgvector, starts the Kaki server on port 3001, the Vite web app on port 5173 and the AI runner, then runs the preflight. It stops with the exact fix if Docker is not running, `.env` is missing or a required key is empty. The seed generates the Gitea and Mattermost tokens in `docker/.env`, and `npm start` passes them to Kaki.

Open `http://localhost:5173` or `http://localhost:5173/demo` in Chrome.

Host sign-in is off by default. To try it locally, set `KAKI_AUTH=1`, `KAKI_HOST_EMAIL` and `KAKI_HOST_PASSWORD` in `.env` (see `.env.example` lines 68 to 74), and set `KAKI_SERVICE_TOKEN` so the AI runner can open the meeting (`npm start` wires `POSTGRES_URL` from `docker/.env`). You can also add an account with `npm run host:create -- you@example.com` (`server/src/auth/cli.ts`), which reads a password and needs `POSTGRES_URL` set in the shell. Without `KAKI_AUTH=1`, sign-in is off and the owner screens open directly (`server/src/index.ts:25`).

```bash
npm stop              # Stop the Kaki server, web app and AI runner
npm stop -- --stack   # Also stop the Docker containers
```

### Integrations

All backing services run through [`docker/docker-compose.yml`](docker/docker-compose.yml). Wiki.js, Gitea, Mattermost and Radicale use `demo` / `demo`; the table below gives the Postgres and LiveKit credentials. See [docker/README.md](docker/README.md).

| Integration | Purpose | Local endpoint | Login | Module |
| --- | --- | --- | --- | --- |
| Gitea | Creates engineering and ops issues from approved drafts | `http://127.0.0.1:8082` | `demo` / `demo` (or `wei-ling`, `arjun`, `mei`, `daniel` / `demo`) | `server/src/action/gitea.ts` |
| Mattermost | Posts announcements and updates to team channels | `http://127.0.0.1:8083` | `demo` / `demo` (or `weiling`, `arjun`, `mei`, `daniel` / `demo`) | `server/src/action/mattermost.ts` |
| Wiki.js | Publishes team wiki pages and approved minutes | `http://127.0.0.1:8081` | `demo` / `demo` | `server/src/action/wiki.ts` |
| Mailpit | Sends drafted emails over SMTP and serves a web inbox | `http://127.0.0.1:8084` | No login | `server/src/action/email.ts` |
| Radicale (CalDAV) | Books `.ics` calendar events and serves the seeded calendar | `http://127.0.0.1:5232` | `demo` / `demo` | `server/src/action/calendar.ts` |
| PostgreSQL + pgvector | Stores company records and 1024-dimension `bge-m3` embeddings | `127.0.0.1:5433` | `kaki` / `kaki_dev_password` | `server/src/wingman/knowledge/` |
| LiveKit + Azure Speech | WebRTC audio room, server VAD, STT and multi-voice TTS | `ws://127.0.0.1:7880` | `devkey` / `secret` | `server/src/npc/` |

When a person joins with their name, Kaki updates the `demo` profile display name in Gitea and Mattermost to match, or posts from the person's own account when it exists. Tasks completed by an AI colleague are posted from that colleague's account (`arjun`, `mei`, `daniel`, `weiling` or `wei-ling`).

### Commands

```bash
npm start                 # One-command local demo: checks, Docker, seed, index, server + web + AI, preflight
npm stop                  # Stop local server, web app and AI runner (add -- --stack for Docker)
npm run cloud:up          # Start the Azure VM and wait for the live site
npm run cloud:down        # Deallocate the Azure VM ($0/hr compute billing)
npm run cloud:status      # Check the VM state and live HTTPS health
npm run stack:up          # Start the seven Docker containers
npm run stack:down        # Stop the Docker containers
npm run seed              # Idempotently seed all Docker services with the Kopitiam scenario
npm run seed:verify       # Run the automated health and content checks against the Docker stack
npm run index:knowledge   # Embed and index seeded company records into pgvector
npm run knowledge:check   # Verify live pgvector search and role-filtered facts
npm run npc               # Run the AI runner against a local stack
npm run playtest:team     # Typed three-person Playwright meeting
npm run playtest:live     # One visitor through the practice meeting
npm run typecheck         # Type-check all workspaces
npm test                  # Run the full Vitest suite
```

See [The live demo meeting](docs/live-demo.md) for the practice meeting flow and [Domain glossary](CONTEXT.md) for the project vocabulary.

## Project management

Work was tracked in GitHub issues for `IT5007-2610/it5007-courseproject-group-14`, read and updated with the `gh` CLI. The labels follow five triage roles: `ready-for-agent`, `needs-triage`, `needs-info`, `ready-for-human` and `wontfix`.

The repository has 493 commits from 21 October to 21 November 2026 (`git rev-list --count HEAD`).

The plan ran in phases: the core stack and protocol first, then the three agents, then the live meeting and demo, then the submission clean-up. Each phase closed with review rounds on architecture, security and how real people use the demo; their findings became issues and fix commits. Notes from people testing the demo became issues and then automated playtests, described in [How we tested Kaki](docs/testing.md).

| Issue | Title |
| --- | --- |
| [#2](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/2) | [Core] Docker Compose Stack & Mock Multi-Source Knowledge Bases |
| [#6](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/6) | [Wingman] Multi-Role Participant Client & Role-Based Private Nudge Engine |
| [#7](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/7) | [Wingman] Private Fact Retrieval Interface via pgvector |
| [#8](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/8) | [Action] Background Worker Runtime & Gitea Issue Creation Tool |
| [#9](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/9) | [Action] Mattermost Notification Tool & Async Lifecycle Reporting |
| [#10](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/10) | [Integration] Human-in-the-Loop Task Dispatch to Sync-Back Flow |
| [#11](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/11) | [Demo] Scripted Replay, Demo Video & Demo Day |
| [#12](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/12) | [Core] Shared skeleton & message contract |
| [#13](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/13) | [Action] Email tool (Mailpit) |
| [#14](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/14) | [Core] Live meeting: LiveKit room, speech recognition and Kaki's voice (was: Zoom) |
| [#16](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/16) | [Core] Sign-in & sessions |
| [#18](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/18) | [Core] One-command start |
| [#39](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/39) | [Host] Keep meeting state across a server restart |
| [#44](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/44) | [Wingman] Upgrade Knowledge Search to Hybrid RAG (Vector + Full-Text) |
| [#63](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/63) | [Docs] Repo clean-up before submission |
| [#64](https://github.com/IT5007-2610/it5007-courseproject-group-14/issues/64) | [Core] Code organisation before submission |

Commit messages carry the issue number, for example `docs(code): a plain-language comment on every exported function, component and type (#64)` and `fix(meeting): review follow-ups: echo after barge-in, settle without an id, Kopitiam copy as scenario data, moves follow the agenda clock (#62)`.

## Competitor analysis

Checked on 1 November 2026. Every source below is vendor-authored, either a press release, product page or help article. Dates are the page's own publication or update date where shown, or "live page" where the page carries no date.

| Product | What its own source describes | Actions and approval | Source |
| --- | --- | --- | --- |
| Kaki | A host, a private wingman per seat and an action module in one meeting; live agenda clock, private fact cards, grounded notetaker and minutes | Drafts a Gitea issue, Mattermost post, Wiki.js page, email or calendar event. The assignee reviews and approves each draft before it runs; minutes wait for a person's approval before the wiki write | This repository |
| Zoom AI Companion 3.0 | Agentic retrieval across Zoom and connected apps; a follow-up template that drafts tasks and emails; personal workflows (beta) that auto-execute follow-ups; My Notes transcription | Follow-ups are drafted inside Zoom, and personal workflows can execute them automatically | [Zoom newsroom](https://news.zoom.com/zoom-launches-ai-companion-3-0/) |
| Microsoft Copilot in Teams | Real-time summary and suggested action items in a private per-person chat; catch-up for late joiners; intelligent recap needs Teams Premium or a Copilot licence | Suggested action items and recaps live inside Microsoft 365 | [Microsoft Support](https://support.microsoft.com/en-us/office/get-started-with-copilot-in-microsoft-teams-meetings-0bf9dd3c-96f7-44e2-8bb8-790bedf066b1) |
| Otter.ai | Live Assist gives private real-time coaching tips; Work Mode produces pre-meeting briefs and follow-ups such as CRM updates and emails, ready to review and send; a Jira connector auto-creates issues and can query Jira through AI Chat | Prepared inside Otter for a person to review and send; the Jira connector creates issues from detected action items | [Otter press release](https://otter.ai/blog/otter-rethinks-the-meeting-new-ai-preps-you-coaches-you-and-follows-through), [Otter Jira connector](https://help.otter.ai/hc/en-us/articles/40485786582551-Connect-Jira-to-Otter-ai) |
| Fireflies.ai | Transcription and summaries; Live Assist for real-time suggestions, coaching and answers; speaker talk-time analytics; AI Skills for follow-up work; Voice Agents | Follow-up work runs through AI Skills and integrations | [fireflies.ai](https://fireflies.ai/) |
| Read.ai | Ask Read actions: update a CRM deal, send email, create calendar events, scheduled email updates | A draft email is reviewed and then sent on the user's command; other actions run from Ask Read | [Read Help Center](https://support.read.ai/hc/en-us/articles/48863788829971-Using-Ask-Read-actions) |

Several competitors offer private in-meeting tips and write-back to connected tools. Kaki nudges one role without being asked, attaches a source and date to each fact card, and asks the task owner to approve a draft before anything is written. Competitors are stronger in meeting-platform coverage, transcription at scale, ready-made integrations and enterprise security certification. Kaki aims at small teams that already self-host their issue tracker, chat and wiki.

## Legal and open source

The main libraries are permissive. React, React DOM, React Router, Vite, `qrcode`, `ws`, `pg`, `tsx` and Vitest are MIT. `nodemailer` is MIT-0. The LiveKit client, React components, server SDK and Node SDK are Apache-2.0. The Microsoft Cognitive Services Speech SDK is MIT. TypeScript and Playwright are Apache-2.0. These licences were read from `node_modules/<package>/package.json`.

The Docker services run as unmodified images next to the code, not inside it.

| Service | Licence |
| --- | --- |
| PostgreSQL with pgvector | PostgreSQL Licence |
| Wiki.js | AGPL-3.0 |
| Gitea | MIT |
| Mattermost Team Edition | Source is AGPL-3.0; compiled binaries are released under MIT |
| Radicale | GPL-3.0 |
| Mailpit | MIT |
| LiveKit server | Apache-2.0 |

The copyleft terms do not reach Kaki's own code because each service runs as a separate process and talks to Kaki over HTTP or its own protocol. A change made inside one of those projects would be covered by that project's licence; calling the service does not relicense the caller. This is our reading, not legal advice.

Meeting audio and transcripts are personal data. A real deployment would need every attendee's consent, a retention limit and a decision on where transcripts are kept. In the demo, the live meeting carries audio through LiveKit and sends speech to Azure Speech for recognition; transcript text goes to the LLM gateway set in `.env`. With `KAKI_REPLAY=1` the host reads a scripted transcript instead of live audio. Debug audio capture is off unless `NPC_DEBUG_AUDIO_DIR` is set, and that folder is gitignored.

Nanyang Kopi & Toast, its people, records, email addresses and credentials are fictional and exist only for the demo. The `demo` / `demo` logins on Wiki.js, Gitea, Mattermost and Radicale are local development values.

No keys are committed. `.env` is gitignored, `.env.example` lists the required key names with empty values, and the seed writes generated Gitea and Mattermost tokens to the gitignored `docker/.env`. The browser never receives an LLM, Azure or service token.

## Business model

The recommended model is open core.

- Publish the meeting protocol, host, wingman and web client under AGPL-3.0. Keep the hosted service, support and enterprise connectors commercial. AGPL requires anyone who offers a modified Kaki over a network to publish its source, so a closed hosted fork would need the commercial licence. Apache-2.0 is easier for adoption but allows a closed fork.
- Customers are small teams that already self-host or pay for Gitea, Mattermost or similar tools, and lose follow-ups after meetings.
- Charge a per-host monthly subscription with a free tier for a few meetings a month. The self-hosted version is free; the managed service, support and team features are paid.
- Cost drivers are speech recognition and synthesis minutes, LLM calls for the notetaker, verifier, search and conversation, and hosting for the meeting server and NPC runner.
- Register the Kaki name and logo as trademarks. Require a contributor licence agreement so all code can be relicensed commercially. Keep proprietary features such as SSO, audit logs and an admin console out of the open repository.

## Credits

External services and APIs:

| What | Used for |
| --- | --- |
| OpenAI-compatible LLM gateway | Notetaker, verifier, action drafts, the NPC Director and conversation, and the final company-search answer |
| `bge-m3` embeddings through the same gateway | 1024-dimension company-record vectors for pgvector |
| Azure Speech | Server-side speech recognition and multi-voice text-to-speech for the AI colleagues |
| LiveKit | WebRTC audio room for the meeting and the NPC runner |
| Wiki.js, Gitea, Mattermost, Mailpit, Radicale | Self-hosted company systems used as search sources and action targets |

The reciprocal rank fusion in `server/src/wingman/knowledge/search.ts` implements the published RRF formula with `k = 60`.

Kaki was built for IT5007 at the National University of Singapore.

No code was copied from other projects, tutorials or repositories. We wrote the code with the help of AI coding assistants (Claude Code and others), and all design decisions and final code are our own responsibility. Kaki uses the open-source libraries and services listed in [Legal and open source](#legal-and-open-source) under their licences.

## Repository structure

```text
├── shared/                 # Typed protocol: events, commands, tasks, scenarios and setup
│   └── src/
├── server/
│   ├── src/action/         # Kaki Action connectors (Gitea, Mattermost, email, Wiki.js, calendar)
│   ├── src/auth/           # Host sign-in, sessions and meeting-code admission
│   ├── src/core/           # Hub, audience routing, event projection, scenario loading
│   ├── src/host/           # Kaki Host (agenda clock, grounded notetaker, auto-dispatch, replay)
│   ├── src/http/           # Access levels, HTTP helpers and one route file per area
│   ├── src/meeting/        # Meeting state: codes, sessions, rejoin, tasks, projections
│   ├── src/npc/            # LiveKit runner, NPC Director, VAD, barge-in, Azure STT/TTS
│   ├── src/persist/        # Meeting persistence and reset
│   ├── src/services/       # Shared LiveKit and LLM clients
│   ├── src/wingman/        # Kaki Wingman (nudges, pgvector search, knowledge indexer)
│   └── test/               # Integration tests and fixtures
├── web/
│   ├── src/auth/           # Host sign-in page and session API
│   ├── src/kaki/           # Scenario context, WebSocket hook and topic speech
│   ├── src/landing/        # Public landing page
│   ├── src/meeting/        # Owner, participant and team meeting routes
│   ├── src/meeting/room/   # Meeting stage, dock, captions, task cards and phone layout
│   ├── src/net/            # Fetch timeout helper
│   ├── src/setup/          # Pre-meeting setup editor and tool checks
│   └── src/ui/             # Shared buttons, cards, labels and artifact links
├── scenarios/kopitiam/     # Nanyang Kopi & Toast scenario, seed data and replay fixtures
├── docker/                 # Docker Compose stack and idempotent multi-service seed scripts
├── scripts/                # Local and cloud launchers, preflight and Playwright playtests
├── wake/                   # Always-on waking page and its start/status API (Azure Static Web Apps)
├── deploy/idle/            # VM idle check that switches the cloud VM off when nobody uses it
└── docs/                   # Live demo guide, testing guide, screenshots and STePS poster
```

## Sources

Competitor rows (all vendor-authored; see the table for dates and status):

- [Zoom AI Companion 3.0 press release](https://news.zoom.com/zoom-launches-ai-companion-3-0/) (15 Dec 2025)
- [Copilot in Microsoft Teams meetings](https://support.microsoft.com/en-us/office/get-started-with-copilot-in-microsoft-teams-meetings-0bf9dd3c-96f7-44e2-8bb8-790bedf066b1) (live page)
- [Otter Work Mode and Live Assist press release](https://otter.ai/blog/otter-rethinks-the-meeting-new-ai-preps-you-coaches-you-and-follows-through) (27 Oct 2026)
- [Connect Jira to Otter.ai](https://help.otter.ai/hc/en-us/articles/40485786582551-Connect-Jira-to-Otter-ai) (updated 15 May 2026)
- [fireflies.ai homepage](https://fireflies.ai/) (live page)
- [Using Ask Read actions](https://support.read.ai/hc/en-us/articles/48863788829971-Using-Ask-Read-actions) (updated 26 Oct 2026)

Other sources:

- [Mattermost licence FAQ](https://docs.mattermost.com/product-overview/faq-license.html)
- [Wiki.js repository](https://github.com/requarks/wiki)
