# Practice meeting guide (`/practice`)

A practice meeting is a video-call style meeting where one person talks with AI colleagues (NPCs in the code). One LLM, the Director, plays all of them from their scenario profiles and decides who speaks, one at a time. The person can talk over them, and they stop. Every accepted line reaches Kaki as an ordinary transcript line, so Kaki Host, Kaki Wingman and Kaki Action work from the same conversation as in a team meeting.

The vocabulary is in [`CONTEXT.md`](../CONTEXT.md).

## Run a practice meeting

### Start it

```bash
cp .env.example .env    # then fill the required keys
npm start
```

Open http://localhost:5173/practice in Chrome or Edge. `npm stop` stops the server, web app and AI runner; `npm stop -- --stack` also stops Docker. To run the pieces separately, use `npm run stack:up`, `npm run dev` and `npm run npc`.

Each visitor gets their own practice room: a refresh or a second tab returns to the same one. When the practice limit is reached, the page shows a plain message with Retry. On the Azure VM, Kaki runs as systemd services (`deploy/systemd/`) instead of `npm start`.

### A visit, start to finish

1. **Join.** The visitor picks a name, a seat and whether to use the microphone. Kaki picks an agenda for that role: `KAKI_AGENDA_ITEMS` items (default 2), each with its scenario minutes (10 per item in Kopitiam).
2. **Briefing.** The stage shows a two-step briefing: the visitor's role and today's calls, then how to play. The AI colleagues are in the room but silent, and anything said now is ignored. The role card and situation are also in the Kaki Wingman dock.
3. **Start.** The page first gets this visitor's own meeting from `POST /api/practice`; pressing Start then calls that meeting's `/api/meetings/<id>/meeting/start`. The server prepares the cast and marks the meeting started. Only then does Sam, the AI colleague in the facilitator seat, give the welcome: the visitor's role, the first agenda item, and a hand-over by name to that item's owner.
4. **Each item.** If the item is not the visitor's, the AI colleagues talk it through for a newcomer unless the visitor speaks first. If it is, Sam asks for their call. If it is contested, two AI colleagues argue and Sam asks the visitor to decide.
5. **Tasks.** The notetaker spots action items and the host dispatches them. An AI colleague accepts or declines in their own words, or the visitor accepts and approves their own task in the dock. After a short delay (`NPC_APPROVE_DELAY_MS`), accepted drafts are run against Gitea, Mattermost, Mailpit, Wiki.js or Radicale.
6. **Wrap-up.** After the last item, the host closes the meeting and a "Publish meeting minutes to the team wiki" card appears with the full Markdown minutes drafted. It is assigned to the visitor, never to an AI seat, so nothing is written until the visitor reviews the draft, edits it if they like and presses Approve & publish. Only then is the Wiki.js page written and the "Open meeting minutes in Wiki" link shown.

| Step | Code |
| --- | --- |
| Briefing | `web/src/meeting/room/StartPrompt.tsx` |
| Welcome and hand-over | `server/src/host/opening.ts` |
| Item mode (observe, own call, contested) | `itemMode` in `shared/src/practice.ts` |
| AI colleague task replies | `server/src/npc/taskResponder.ts` |
| Minutes card | `server/src/action/wiki.ts` |

### Rehearse without writing to the tools

Set `KAKI_DRAFT_ONLY=1` on both the server and the AI runner, with the same value:

```bash
KAKI_DRAFT_ONLY=1 SCENARIO=kopitiam npm start
# or, when running the pieces separately:
KAKI_DRAFT_ONLY=1 npm run dev
KAKI_DRAFT_ONLY=1 npm run npc
```

Tasks are still drafted and can be reviewed, including the minutes card. An action that reaches `RUNNING` (approved or retried) is refused before anything is sent and marked failed with a clear message, and AI colleagues stop approving or retrying drafts. Unset the key to write for real.

To rehearse with real writes to the local tools, run `npm run playtest:live -- --act` on a stack started without `KAKI_DRAFT_ONLY`; the robot visitor then accepts and approves its own cards.

### Sign-in mode

The same server also runs the signed-in product: Google sign-in, personal workspaces, the read-only Nanyang Kopi sample workspace, and team meetings with any number of people and no AI colleagues. `/practice` keeps working without sign-in. Sign-in mode is on when `KAKI_AUTH=1`; set these keys in `.env` (see `.env.example`):

| Key | What it does |
| --- | --- |
| `KAKI_AUTH` | Turns sign-in mode on. Needs `POSTGRES_URL`. |
| `KAKI_GOOGLE_CLIENT_ID`, `KAKI_GOOGLE_CLIENT_SECRET` | Google sign-in. Without them the sign-in page says Google is not set up. |
| `KAKI_PUBLIC_URL` | The address people open; Google sends them back to it after sign-in. |
| `KAKI_SECRET_KEY` | 32 random bytes, base64-encoded; encrypts the tool logins saved in a workspace. |
| `KAKI_SERVICE_TOKEN` | Shared secret between the server and `npm run npc`; use the same value for both. |
| `KAKI_MAX_OPEN_MEETINGS` | Meetings the server keeps open at once (default 10). |
| `KAKI_MAX_OPEN_MEETINGS_PER_USER` | Meetings one owner keeps open at once (default 2). |
| `KAKI_MAX_MEETINGS_PER_DAY` | Meetings one owner may create per day (default 20). |
| `KAKI_MAX_PRACTICE` | Practice meetings running at once (default 5). They count toward `KAKI_MAX_OPEN_MEETINGS`, so team meetings keep the remaining slots. |
| `KAKI_PRACTICE_UNLOAD_MS` | How long an empty practice meeting stays loaded for its visitor to return (default 5 minutes); an ended one is unloaded at once. |

Sign-in mode refuses the dev routes. Ended meetings keep their minutes and to-dos in the workspace history.

## Operating notes

### How it is built

| Piece | Code |
| --- | --- |
| Prompt from scenario profiles, streaming `Name: sentence` parser | `server/src/npc/director.ts` |
| Conversation state machine (one abort controller per turn; history is what was actually heard) | `server/src/npc/conversation.ts` |
| Voice activity detection (VAD) on the visitor's echo-cancelled microphone | `server/src/npc/vad.ts`, `server/src/npc/reference.ts` |
| Gate that tells the visitor from an AI colleague's own voice coming back | `server/src/npc/speechGate.ts` |
| Azure speech-to-text of only the stretches VAD marks as the visitor talking | `server/src/npc/azureStt.ts`, `server/src/npc/utterance.ts` |
| Instant-stop playback into LiveKit; Azure text-to-speech | `server/src/npc/playback.ts`, `server/src/npc/azureTts.ts` |
| LiveKit wiring, who is in the room, the start gate | `server/src/npc/runner.ts`, `server/src/npc/main.ts` |
| Join form, briefing, stage, captions, meeting controls | `web/src/meeting/room/` |

The AI colleagues' current activity travels on the `kaki.npc-state` data topic (`shared/src/practice.ts`); Start is a server call.

### How interruption works

The browser publishes the microphone with echo cancellation, so that track carries the visitor and little of the AI. `EnergyVad` watches it, and when the visitor starts talking the conversation aborts the turn (model, synthesis and sound) and clears LiveKit's buffer. While an AI colleague speaks, the detector is stricter: it measures how loud the AI's echo is in the microphone (the AI's own playback is recorded in `PlaybackReference`) and requires the visitor to be `NPC_VAD_LEAK_MARGIN` times louder. Recognised text is accepted only if it is not a near-copy of what the AI just said. If a cut-in holds no words, the AI carries on after 0.4 seconds.

### Reading the runner log (`npm run npc`)

| Line | Meaning |
| --- | --- |
| `recognised "..."` | Accepted as the visitor. |
| `ignored "..." (echo\|no-voice; ...)` | Refused. If the mic peak is below the bar, the detector missed a real person. |
| `<name> started talking (mic peak X, bar Y ...)` / `stopped talking` | What the detector hears. |
| `Arjun: ...` | What an AI colleague said. |
| `speaking N ms after the model was asked` | Latency. |
| `dropped <speaker>'s cue ...: the room stayed busy` | A host cue gave up waiting for a quiet moment. |
| `ignored "...": the meeting has not started` | Speech before Start. |

`NPC_DEBUG_VAD=1` adds a `[vad]` line twice a second while an AI colleague talks. `NPC_DEBUG_AUDIO_DIR=npc-audio` saves what was sent to Azure; these files contain a person's voice, and the folder is git-ignored.

### Tuning

If an AI colleague cuts itself off, raise `NPC_VAD_LEAK_MARGIN` or `NPC_VAD_GUARDED_MIN_LEVEL`. If cutting in feels sluggish, lower `NPC_VAD_GUARDED_START_MS`. Headphones remove the echo problem; laptop speakers rely on the browser's echo cancellation.

### LLM settings

The primary and fallback LLMs are both OpenAI-compatible, and the fallback takes over when the primary fails. `npm run llm:use -- school` (or `direct`) moves the school gateway and the direct DeepSeek API between the `KAKI_LLM_*` and `KAKI_LLM_FALLBACK_*` slots; restart the stack afterwards.

- `KAKI_LLM_REASONING_CONTROL`, `KAKI_LLM_FALLBACK_REASONING_CONTROL` and `KAKI_NOTETAKER_LLM_REASONING_CONTROL` force `reasoning_effort` on or off. Set them when a DeepSeek model is served under a name without "deepseek"; when unset, Kaki sends it only for model names containing "deepseek".
- `KAKI_LLM_FIRST_CHUNK_MS` (default 12 seconds) and `KAKI_LLM_IDLE_MS` (default 10 seconds) are a streamed reply's first-chunk and between-chunk deadlines. `KAKI_LLM_TIMEOUT_MS` is the whole-request timeout for a non-streamed `complete` call.

### Fault drills (`KAKI_FAULT`)

`KAKI_FAULT` on the AI runner shows one failure on purpose during a live check:

| Value | Failure |
| --- | --- |
| `control-garbled` | A garbled control line |
| `slow-first` | A 15-second delay before the first chunk |
| `stall-mid` | A stream that stops mid-reply |
| `tts-fail` | Every voice clip fails |

Unset it for a normal run; an unknown value stops the runner at startup (`server/src/npc/fault.ts`).

### What the tests cover

- Unit tests cover the conversation, Director, detector, gate, recorder and playback with fakes.
- `LIVEKIT_E2E=1 npx vitest run server/test/npc/livekit.e2e.test.ts` (needs `npm run stack:up`) runs the real runner against a real LiveKit server with a fake person, a scripted model and a fake voice, including echo and barge-in.
- No test covers Azure itself, the real model, real room acoustics, a browser's echo cancellation or the orbs on real LiveKit tiles. Those need a live run with a microphone.
