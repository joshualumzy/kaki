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
| LiveKit wiring: both directions of audio, barge-in, echo gate (`runner.ts`) | `server/test/npc/livekit.e2e.test.ts` | **yes, against a real LiveKit server**, with a fake person, scripted model and tone "speech" |
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

## Verified over real LiveKit (fake model and voice)

`LIVEKIT_E2E=1 npx vitest run server/test/npc/livekit.e2e.test.ts` (needs a LiveKit server, for example
`npm run stack:up`) joins as a fake person and checks the real runner. Six consecutive runs, all green:

- person stops talking -> AI audible: about 950 ms with an instant model and voice (the pipeline's own
  overhead: voice hangover 500 ms + response delay 300 ms). Add the real model's first token and
  Azure's first audio on top.
- person talks over the AI -> AI silent: about 280 ms.
- the AI's own sentence, and text with no voice behind it, are refused while the AI talks.
- **speaker echo**: with a delayed, quieter copy of the AI fed back into the fake microphone (about
  0.25x, 250 ms late), the AI does not cut itself off, and a person talking over it is still heard
  within about 250 ms. The test failed before the playback-reference detector existed.

## What the first live run found, and what changed (see the log format below)

From a real run on laptop speakers: the echo gate worked (about a dozen of the AI's own sentences
refused as `echo` / `no-voice`), but (1) a recognised result that mixed the AI's sentence with the
person's words was refused whole, (2) quiet interruptions while the AI talked were refused as
`no-voice` because the voice detector's fixed bar missed them, (3) names were misheard ("Audrey",
"Archer" for Arjun), and (4) the AI sounded curt. Now:

- `speechGate.ts` cuts the AI's words out of a mixed result and keeps the person's.
- `vad.ts` learns how loudly the AI leaks into the microphone (`reference.ts` records what is played)
  and requires the person to be clearly louder than that, so the bar follows the speakers and room
  instead of a fixed number. The echo tail is covered for 1.4 s after the AI stops. Start-of-speech uses
  "enough loud time in the last window", so syllable valleys do not stall it.
- the prompt tells the model about the situation (`situation` in `scenario.json`), that the person's
  words come from imperfect recognition (`soundsLike` per character), to answer direct questions
  first, and to sound like a warm colleague (contractions, short reactions).

## Reading the runner's log

- `heard "..."`: accepted as the person. `ignored "..." (echo|no-voice; mic peak X in the last 3 s, bar to
  count as talking Y)`: refused; if the peak is below the bar, the voice detector missed a real person.
- `Josh started talking (mic peak X, bar Y[, AI was talking: its level L, leaks into the mic at Rx])`.
- `Arjun: ...` lines are what the AI said; `speaking N ms after the model was asked` is the latency.
- `NPC_DEBUG_VAD=1` adds a `[vad]` line twice a second while the AI talks.

## NOT verified: needs a live run (a microphone, Azure, the real LLM, a browser)

The e2e test does not cover Azure, the real model, real acoustics (its echo is an idealised delayed,
scaled copy; a real room adds filtering and reverb), or a browser's echo cancellation. Expect to
tune these on a real machine:

- **Voice thresholds** (`NPC_VAD_*` in `.env`). If the AI cuts itself off, raise
  `NPC_VAD_GUARDED_MIN_LEVEL`; if talking over it feels sluggish, lower `NPC_VAD_GUARDED_START_MS`.
  The log prints `<name> started talking` / `stopped talking`, which shows what the detector hears.
- Latency of the real LLM + Azure on top of the ~950 ms above; the `LIVEKIT` compose service (`livekit/livekit-server:latest`, ports
  7880, 7881, 7882/udp); whether `--bind 0.0.0.0` is enough for your Docker setup.
- Headphones remove the echo problem entirely; laptop speakers rely on the browser's echo cancellation.

## Constraints

- Do not kill Chrome. Do not print `.env` secrets.
- Shared files (`shared/**`, `app.ts`, `scenario.json`) changed here: the optional `npcs` schema, the
  token route, `/dev/emit` retention. Under `docs/ownership.md` these want a small reviewed PR.

## Next: make the room feel like several people (planned, not started)

Feedback after the second live run: it can feel like talking to one AI. Why, from the design: one
model (the Director) writes every character, so they share a writing style; "if somebody is addressed
by name, only they answer" means often one speaks; and the characters only ever speak after the
person does, so they never answer each other or fill a silence. Proposed order:

1. **Distinct voices.** Add an optional `speechStyle` to `NpcProfile` (sentence length, verbal habits,
   how they hedge or push back) and put it in the prompt. Pick Azure speaking styles per character
   (SSML `express-as`; the Director could tag a mood per line, for example `Arjun (worried): ...`,
   stripped from captions). Check Azure's per-voice style list; plain text is spoken neutrally today.
2. **Conflict in the profiles.** Standing disagreements and hidden goals between pairs of characters,
   in `scenario.json`, so they have a reason to answer each other. "Disagree when your aims
   conflict" is weak without specifics.
3. **AI-to-AI follow-ups.** After a reply, a character may respond to the other even when the person
   is silent: at most two extra turns, and an idle nudge after about 8 s of silence ("speak only if
   you really have something to add, otherwise NONE"). The person talking over them must still win
   instantly, so reuse the existing turn and abort machinery in `conversation.ts`. Cost: more model
   calls and latency, and the risk of a chatty room, hence the hard limits.
4. **Three or more characters.** One Director prompt gets long and favours whoever is listed first.
   Add a cheap "who speaks next" step by rules first (who was addressed, who owns the current agenda
   item, whose concerns were triggered), then write only those one or two characters.

Also pending from earlier: an optional server-side speech-to-text path (Azure, fed only while the voice
detector says the person is talking, to stay within the free hours) as an alternative to Chrome's
recognition, which hears the speakers and mishears names; it could use `soundsLike` as phrase hints.

## Later

The AI attendees do not yet read from the company data (Gitea, Mattermost, Postgres, wiki). The
Wingman's knowledge search is the natural thing to give them as a tool.
