# Handoff: live demo meeting with AI attendees

Branch: `feature/scripted-replay`.

## What this is

`/demo` is a video-call style meeting. The person talks to AI attendees (the scenario's `npcs`: for
Pixel Kampung, Arjun and Mei). One LLM, the Director, plays all of them from their profiles and
decides who answers, one at a time. The person can talk over them and they stop. Every line goes to
Kaki as a normal transcript line.

Run it: `npm run stack:up`, `npm run dev`, `npm run npc`, then open http://localhost:5173/demo in
Chrome or Edge. See the README for settings.

## How it is built

| Piece | Where | Tested here? |
|---|---|---|
| Prompt from scenario profiles, streaming `Name: sentence` parser | `server/src/npc/director.ts` | yes |
| Conversation state machine (one abort controller per turn, history = what was heard) | `server/src/npc/conversation.ts` | yes, with fake LLM/TTS/playback |
| Voice activity detection on the person's mic track | `server/src/npc/vad.ts` | yes, synthetic audio |
| Echo / "is this the person?" gate for recognised text | `server/src/npc/speechGate.ts` | yes |
| Instant-stop playback into LiveKit | `server/src/npc/playback.ts` | yes, fake sink |
| Azure text-to-speech, LiveKit rooms, wiring | `server/src/npc/azureTts.ts`, `main.ts` | **no**: needs LiveKit, Azure and a microphone |
| Join form, captions, speech recognition wrapper | `web/src/demo/` | yes (pure parts); the LiveKit components are not rendered in tests |
| Token endpoint | `server/src/livekit.ts`, `app.ts` | yes, and smoke-tested against the real server |

The browser sends recognised text over a LiveKit data channel (`kaki.stt`), and the AI attendees
send their state back on `kaki.npc-state` (`shared/src/demo.ts`). Nothing but accepted transcript
lines goes through `/dev/emit`, so the notetaker never sees interim text, status messages or echo.

How interruption works: the browser publishes the microphone with echo cancellation, so that track
carries the person and little of the AI. `EnergyVad` watches it; when the person starts talking the
conversation aborts the turn (model, synthesis, sound) and clears LiveKit's buffer. While an AI
attendee is talking the detector is stricter (`guarded`) so leaked playback does not count.
Recognised text is only accepted if it is not a near-copy of what the AI just said, and, while the
AI is talking, if the person's mic carried speech since the AI began.

## NOT verified: needs a live run (a microphone, LiveKit, Azure, the real LLM)

Everything above "tested" was tested with fakes. Nobody has yet run the whole thing end to end after
the rewrite. Expect to tune these on a real machine:

- **Voice thresholds** (`NPC_VAD_*` in `.env`). If the AI cuts itself off, raise
  `NPC_VAD_GUARDED_MIN_LEVEL`; if talking over it feels sluggish, lower `NPC_VAD_GUARDED_START_MS`.
  The log prints `<name> started talking` / `stopped talking`, which shows what the detector hears.
- Latency of LLM + Azure; the `LIVEKIT` compose service (`livekit/livekit-server:latest`, ports
  7880, 7881, 7882/udp); whether `--bind 0.0.0.0` is enough for your Docker setup.
- Headphones remove the echo problem entirely; laptop speakers rely on the browser's echo cancellation.

## Constraints

- Do not kill Chrome. Do not print `.env` secrets.
- Shared files (`shared/**`, `app.ts`, `scenario.json`) changed here: the optional `npcs` schema, the
  token route, `/dev/emit` retention. Under `docs/ownership.md` these want a small reviewed PR.

## Later

The AI attendees do not yet read from the company data (Gitea, Mattermost, Postgres, wiki). The
Wingman's knowledge search is the natural thing to give them as a tool.
