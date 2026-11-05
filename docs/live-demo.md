# The live demo meeting (`/demo`)

A video-call style meeting where one person talks to AI attendees. One LLM (the **Director**) plays all of them from their
scenario profiles and decides who speaks, one at a time. The person can talk over them and they stop. Every accepted line goes
to Kaki as an ordinary transcript line, so the host, wingman and action agents work from the same conversation.

Run it: `npm run stack:up`, `npm run dev`, `npm run npc`, then open http://localhost:5173/demo in Chrome or Edge.
Settings are in `.env.example`. Terms are in `CONTEXT.md`.

## A visit, start to finish

1. **Join.** The visitor picks a name and a role (any role no AI plays) and whether to use the microphone.
2. **Briefing.** The stage shows "Read your briefing first" (`web/src/demo/StartPrompt.tsx`). The AI attendees are in the room but
   silent, and anything the visitor says or types is ignored. The role card and situation are in the Kaki Wingman panel.
   A visitor in the facilitator's seat skips this: they open the meeting themselves.
3. **Start.** Pressing the button sends `{ kind: 'start' }` on the `kaki.control` data topic. Only then does Sam speak the welcome, which
   names the visitor's role and responsibility, the first agenda item, and hands over by name to that item's owner
   (`server/src/host/opening.ts`).
4. **The item.** If the item is not the visitor's, the characters talk it through for a newcomer unless the visitor speaks first.
   If it is, Sam asks them for their call. If it is contested, two characters argue and Sam asks the visitor to decide (`itemMode` in
   `shared/src/demo.ts`).
5. **Tasks.** The notetaker spots action items; Sam dispatches them on the Host tab, the AI colleague accepts or declines in their own words,
   and accepted drafts are approved after a short pause (`taskResponder.ts`, `NPC_APPROVE_DELAY_MS`).

## How it is built

| Piece | Where |
|---|---|
| Prompt from scenario profiles, streaming `Name: sentence` parser | `server/src/npc/director.ts` |
| Conversation state machine (one abort controller per turn; history = what was actually heard) | `server/src/npc/conversation.ts` |
| Voice activity detection on the visitor's echo-cancelled mic track | `server/src/npc/vad.ts`, `reference.ts` |
| "Is this the visitor or an AI's own voice coming back?" gate | `server/src/npc/speechGate.ts` |
| Server-side speech recognition (Azure) of only the stretches the detector marks as the visitor talking | `azureStt.ts`, `utterance.ts` |
| Instant-stop playback into LiveKit; Azure text-to-speech | `playback.ts`, `azureTts.ts` |
| LiveKit wiring, who is in the room, the start gate | `server/src/npc/runner.ts`, `main.ts` |
| Join form, start prompt, stage, captions, type bar | `web/src/demo/` |

Data topics (`shared/src/demo.ts`): `kaki.stt` (browser-recognised text, only with `NPC_STT=browser`), `kaki.npc-state` (what the AI attendees
are doing), `kaki.control` (typed text, "typing", Stop, Start).

## How interruption works

The browser publishes the microphone with echo cancellation, so that track carries the visitor and little of the AI. `EnergyVad` watches
it; when the visitor starts talking the conversation aborts the turn (model, synthesis and sound) and clears LiveKit's buffer. While an AI
attendee speaks the detector is stricter: it measures how loud the AI's echo is in the microphone (the AI's own playback is recorded in
`PlaybackReference`) and requires the visitor to be `NPC_VAD_LEAK_MARGIN` times louder. Recognised text is only accepted if it is not a
near-copy of what the AI just said. If a cut-in turns out to hold no words, the AI carries on after 0.4 s. Typing sets a short guard so a key
press is not mistaken for a cut-in.

## Reading the NPC log (`npm run npc`)

- `recognised "..."`: accepted as the visitor. `ignored "..." (echo|no-voice; ...)`: refused. If the mic peak is below the bar, the
  detector missed a real person.
- `<name> started talking (mic peak X, bar Y ...)` / `stopped talking`: what the detector hears.
- `Arjun: ...`: what an AI said. `speaking N ms after the model was asked`: latency.
- `dropped <speaker>'s cue ...: the room stayed busy`: a host cue gave up waiting for a quiet moment.
- `ignored "...": the meeting has not started`: speech before Start.
- `NPC_DEBUG_VAD=1` adds a `[vad]` line twice a second while an AI talks. `NPC_DEBUG_AUDIO_DIR=npc-audio` saves what was sent to Azure
  (these files contain a person's voice; the folder is gitignored).

## Tuning

If an AI cuts itself off, raise `NPC_VAD_LEAK_MARGIN` or `NPC_VAD_GUARDED_MIN_LEVEL`. If cutting in feels sluggish, lower
`NPC_VAD_GUARDED_START_MS`. Headphones remove the echo problem entirely; laptop speakers rely on the browser's echo cancellation.

## Verified and not verified

- Unit tests cover the conversation, director, detector, gate, recorder and playback with fakes.
- `LIVEKIT_E2E=1 npx vitest run server/test/npc/livekit.e2e.test.ts` (needs `npm run stack:up`) runs the real runner against a real LiveKit
  server with a fake person, a scripted model and a fake voice, including echo and barge-in.
- Not covered by any test: Azure itself, the real model, real room acoustics, a browser's echo cancellation, the orbs on real LiveKit tiles.
  Those need a live run with a microphone.
