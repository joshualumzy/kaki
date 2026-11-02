# Handoff: live demo meeting with AI attendees

Branch: `feature/scripted-replay`.

## What this is

`/demo` is a video-call style meeting. The person talks to AI attendees (the scenario's `npcs`: for
Lah Studios, Arjun and Mei). One LLM, the Director, plays all of them from their profiles and
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

## Done: distinct voices and conflict in the profiles (steps 1 and 2, text side)

`NpcProfile` now takes optional `role` (`host | participant | observer`), `speechStyle`, `hiddenGoal` and
`tensions` (`{ with, about }`). They go into the Director prompt (`describeNpc`), which also tells the
model to keep the characters' voices apart and to let one answer another directly where a tension is
relevant. Arjun and Mei have them in `pixel-kampung`. Not tried with the real model yet: listen for
whether they now sound different and answer each other. **Still open from step 1:** per-line mood tags and
Azure `express-as` styles (the spoken voice is still neutral). There is no host NPC in `pixel-kampung`
(the person is the Producer); a scenario can now declare one with `role: "host"`.

## Done: the cast depends on the role the person picks

Five characters in `pixel-kampung`: Wei Ling (Producer), Arjun, Mei, Daniel (marketing) and Sam (the AI
host, `role: "host"`, never playable). `playable: true` marks the seats a person can take. Sam listens
from the start; the others join when a person arrives, as everyone except the role they picked, and
leave when the person leaves (`syncCast` in `runner.ts`). The Director prompt, parser and voices use only
the cast in the room, and each character has `withRoles` notes on how they treat the person's role.
Each role has a short fact `card` (facts, no script) shown at the top of the right-hand panel
(`web/src/demo/RoleCard.tsx`). The `studio_manager` role is a `facilitator`: never offered to join and never
counted as quiet (a one-line change in the Host's `notetaker.ts`). **Not run:** the LiveKit e2e test was
updated by hand for four AIs (Sam, Arjun, Mei, Daniel with Josh as Producer) but there is no Docker here to
run it, and nothing was tried with the real model. The studio is now called Lah Studios (display name only).
Known data mismatch: Mei's profile says 14 of 20 playtesters quit on level 5, the Mattermost seed says 19 of 29.
The join QR codes and the phone role picker still list Studio Manager (Wingman's files).

## First live run of the five-character room, and what changed

Heard in the live run: the characters' voices and their interplay worked well. Problems: a pause was
wanted between one character and the next; some of what the person said was not heard; interruptions
sometimes did not go through; and Chrome's recognition misheard a lot ("build" as "Bill", "did you ask
Arjun" as "dinner you ask Arjun"). The log showed the person's voice peaking at 0.179 to 0.182 while the
bar to count as talking was 0.185 to 0.197 (the AI's own echo reached 0.10 to 0.15 in the microphone on laptop
speakers). Changed:

- `NPC_SPEAKER_GAP_MS` (default 700): pause when a different character takes over.
- `NPC_VAD_LEAK_MARGIN` (default 2, was a fixed 2.5): the person must be this many times louder than the
  AI's echo while it talks. Lower it to interrupt more easily; raise it if the AI cuts itself off.
- Browser recognition now defaults to Singapore English (`en-SG`); `/demo?lang=en-US` goes back.
- `vocabulary` in `scenario.json` is told to the model, so it can map a misheard word to the likely one.
- The prompt: the host speaks first on greetings, and characters never write the person's name as a speaker.

**Then, server-side recognition** (`azureStt.ts`, `utterance.ts`; the default, `NPC_STT=browser` goes back
to Chrome's). Chrome hears the speakers, not the echo-cancelled track, so it transcribed the AI's own voice
and mishears accents. Now `UtteranceRecorder` gives Azure speech-to-text (same key and region as the
voice, `NPC_STT_LOCALE`, default `en-SG`) only the audio between the voice detector saying the person started
and stopped, with 400 ms from just before so the first syllable is kept, a 25 s cap and a 250 ms minimum.
Phrase hints are the scenario's `vocabulary`, the attendees' names and the organisation. The text then goes through
the same speech gate as before (echo words cut out), so a detector mistake costs a few seconds of Azure
time, not a wrong conversation. The browser's text is ignored while this is on. Log line: `recognised "..."`.
**Not run against Azure** (the Azure part is a thin wrapper, the recorder is unit-tested with a fake). If it
mishears, the first thing to check is the `recognised` lines. Free tier: about 5 audio hours a month.

## Second live run (server-side recognition)

Recognition was accurate ("Sam. Sam, I have a question." came through exactly). Two bugs: addressing Sam got an
answer from Arjun (an untagged reply fell back to the first character in the list), and "I'm addressing this to
Sam" got no answer at all (a quiet sound counted as the person talking, cancelled the answer, and no words followed).
Fixed: `addressedCharacter` (a name at the start of what was said, or "I'm addressing this to X"; several names means the
room) tells the model who answers and is the fallback speaker, then the host; and an answer cancelled before anything was
said is retried after `DEFAULT_RETRY_MS` (1.5 s) if nothing else arrives. **Interruption is still unverified:** that log showed
no failed interruption, only a 12 s stretch of Sam talking with no voice detection. Next run: `NPC_DEBUG_VAD=1`, try to talk
over an AI, and send the `[vad]` lines. With server-side recognition a missed interruption leaves no `ignored` line.
Idea if acoustics stay unreliable: a Stop button or key that interrupts directly.

**Third live run:** interruption now works (four clean barge-ins, `[vad]` margin 2), recognition accurate, the
cancelled-answer retry worked. Remaining: addressing "Hey, Sam." / "Sam." was detected but Arjun or Mei still
answered, because the model treated the hint as optional. The hint now says "Begin your reply with `Sam:`" and what to do
for a bare name. Also logs `speech recognition heard nothing in N s of audio` when Azure returns nothing.

**Fourth report:** interruptions sometimes need "a short tick" and what is said right after an interruption is
sometimes not registered. Not diagnosed. Hypotheses: the start needed 180 ms of loud speech on top of a raised bar
(now 120 ms, `NPC_VAD_GUARDED_START_MS`); and the browser's echo cancellation can distort or partly suppress the
person's voice while the AI is playing (double-talk), so Azure gets chopped audio (at 23:58:28, 3 s of speech after
a barge-in returned nothing). **To find out:** run with `NPC_DEBUG_AUDIO_DIR=npc-audio` and `NPC_DEBUG_VAD=1`; each
stretch sent to Azure is saved as a WAV file named by time like the log lines, so you can listen to what the
server heard, especially for speech that started over an AI. If it is chopped, the fix is headphones or lower speaker
volume, not code.

**Fifth report, with `NPC_DEBUG_VAD=1` and saved audio:** speaking into a silence works; cutting in "is terrible". The
`[vad]` lines showed the real echo in the microphone is tiny (0.003 to 0.04 against an AI level of 0.15 to 0.30) while the
detector's estimate of it was 0.35x, then 1.09x, then 2.00x of the AI's level, so the bar to count as talking was 0.2 to
0.95 and the person's voice peaks at 0.10 to 0.26. Cause: it only learned the echo when the AI had been audible without any gap
for over a second (almost never), stayed on its 0.35x starting guess, and when it did learn it counted the person's own
attempts as echo. Replaced (`vad.ts`): the echo level is now measured directly, as the 90th percentile of the microphone's own level while
the AI plays, from frames not louder than `NPC_VAD_LEAK_CAP` (0.06, so the person is never counted as echo) and only once the
echo of what was played has had time to arrive (`PlaybackReference.settledLevelAt`, 400 ms); it is kept between stretches, never below
0.02, and the bar is that times `NPC_VAD_LEAK_MARGIN` (2). With the numbers in that log the bar is about 0.04 to 0.08.
Not seen yet with the real room. Unexplained in that log: at 11:02 the detector said "started talking" but there was no
"interrupted", "stopped talking" or recognition line. The runner now runs recognition last and guarded (a failure there can no
longer hide a start or stop from the conversation) and logs `ignored the person starting to talk: already marked as talking`
if a stop was missed.

**Sixth report:** cutting in works (five cut-ins at mic peaks of 0.12 to 0.20 against bars of 0.04 to 0.09). Two cut-ins
ended with `heard nothing in 0.9 s / 1.0 s of audio`, the AI went silent and nobody continued for several seconds ("Arjun keeps
getting cut off"). Whether those were the person's short sounds or echo is not known: the saved WAVs at
`npc-audio/00-28-05-924.wav` and `00-28-40-704.wav` would say. Either way, the conversation now carries on: if the person
cuts in over something being said and nothing recognisable follows within `DEFAULT_RESUME_MS` (1.8 s), the AI resumes from where it was cut off
(log: `the person cut in but said nothing recognisable: carrying on`). If the WAVs turn out to be echo, raise `NPC_VAD_LEAK_MARGIN` or
`NPC_VAD_GUARDED_START_MS`.

**Seventh report:** the two empty cut-ins were listened to: not the person, not noise, not the AI, "a computer sound like a
button". Joining shows the same pattern (a start about 0.5 s after `joined`, then `heard nothing`). Hypothesis (unconfirmed):
the page still ran Chrome's speech recognition, redundant once the server recognises speech, and Chrome's start and restart
sounds reached the microphone. The page no longer runs it unless opened as `/demo?stt=browser` (needed with `NPC_STT=browser`).
Also: when recognition reports a stretch held no words, the AI carries on after 0.4 s (`humanNothing`), not 1.8 s. If the sound is still
there with the page's recognition off, look at the OS (a notification or system sound) or the microphone's own processing.

## Next: make the room feel like several people (steps 3 and 4 not started)

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
