# The live demo meeting (`/demo`)

A video-call style meeting where one person talks to AI attendees. One LLM (the **Director**) plays all of them from their
scenario profiles and decides who speaks, one at a time. The person can talk over them and they stop. Every accepted line goes
to Kaki as an ordinary transcript line, so the host, wingman and action agents work from the same conversation.

Quick start: `cp .env.example .env` and fill the required keys, then `npm start`, then open http://localhost:5173/demo in Chrome or Edge.
Each visitor gets their own practice room: a refresh or a second tab returns to the same one, and when
the practice cap is full the page shows a plain message with Retry.
`npm stop` stops the server, web app and AI attendees; `npm stop -- --stack` also stops Docker.
(Or run `npm run stack:up`, `npm run dev`, and `npm run npc` separately.)
The required keys are in `.env.example`. Terms are in `CONTEXT.md`.

The Azure VM runs Kaki as systemd services instead; `npm start` is the laptop path.

Both the primary and the fallback LLM are OpenAI-compatible; the fallback takes over when the primary fails.
`npm run llm:use -- school` (or `direct`) moves the school gateway and the direct DeepSeek API between the
`KAKI_LLM_*` and `KAKI_LLM_FALLBACK_*` slots, so restart the stack afterwards. `KAKI_LLM_REASONING_CONTROL`
(and the fallback and notetaker equivalents) force `reasoning_effort` on or off when a DeepSeek model is
served under a name that does not contain "deepseek"; unset keeps the old name-based rule.
`KAKI_LLM_FIRST_CHUNK_MS` (default 12 s) and `KAKI_LLM_IDLE_MS` (default 10 s) are the streamed reply's
first-chunk and between-chunk deadlines; `KAKI_LLM_TIMEOUT_MS` stays the whole-request timeout for `complete`.

## The live product (sign-in mode)

Besides the practice demo, the same server runs the real product: Google sign-in, personal workspaces, the read-only sample
workspace Nanyang Kopi, and real meetings with any number of people and no AI colleagues. Guests join by invite link without an
account. Real meetings are opened from the workspace page; `/practice` and `/demo` work as above, with no sign-in.

Sign-in mode is on when `KAKI_AUTH=1`. Set these keys in `.env` (names only here; see `.env.example`):

| Key | What it does |
|---|---|
| `KAKI_AUTH` | Turns sign-in mode on. Needs `POSTGRES_URL`. |
| `KAKI_GOOGLE_CLIENT_ID`, `KAKI_GOOGLE_CLIENT_SECRET` | Google sign-in. Without them the sign-in page says Google is not set up. |
| `KAKI_PUBLIC_URL` | The address people open; Google sends them back to it after sign-in. |
| `KAKI_SECRET_KEY` | Encrypts the tool logins saved in a workspace. |
| `KAKI_SERVICE_TOKEN` | Shared secret between the server and `npm run npc`. Use the same value for both. |
| `KAKI_MAX_OPEN_MEETINGS` | How many real meetings the server keeps open at once (default 10). |
| `KAKI_MAX_OPEN_MEETINGS_PER_USER` | How many real meetings one owner keeps open at once (default 2). |
| `KAKI_MAX_MEETINGS_PER_DAY` | How many meetings one owner may create per day (default 20). |
| `KAKI_MAX_PRACTICE` | How many practice meetings may run at once (default 5). They count toward `KAKI_MAX_OPEN_MEETINGS`, and the rest of that cap stays free for real meetings. |
| `KAKI_PRACTICE_UNLOAD_MS` | How long an empty practice meeting stays loaded for its visitor to return (default 5 min); an ended one is unloaded at once. |

Sign-in mode refuses the dev routes. Approved posts are signed "Posted by Kaki for <name>, approved in <meeting title>"
(`server/src/action/footer.ts`). Ended meetings keep their minutes and to-dos in the workspace history.

## A visit, start to finish

1. **Join.** The visitor picks a name, a seat and whether to use the microphone. Kaki selects a crisp 2-item agenda (`KAKI_AGENDA_ITEMS`, default `2`, each item with its scenario minutes, 5 in Kopitiam) tailored to that role.
2. **Briefing.** The stage shows a two-step briefing (`web/src/meeting/room/StartPrompt.tsx`): the visitor's role and today's calls, then
   how to play. The AI attendees are in the room but silent, and anything the visitor says or types is ignored. The role card and situation
   are also in the unified Kaki Wingman dock on the right.
3. **Start.** The practice page first gets this visitor's own meeting from `POST /api/practice`, then pressing the button posts that meeting's `/api/meetings/<id>/meeting/start`. The server prepares the cast and marks the meeting started; only then does Sam,
   the facilitator-seat AI attendee, speak the welcome, which names the visitor's role and responsibility, the first agenda item, and hands
   over by name to that item's owner (`server/src/host/opening.ts`).
4. **The item.** If the item is not the visitor's, the characters talk it through for a newcomer unless the visitor speaks first.
   If it is, Sam asks them for their call. If it is contested, two characters argue and Sam asks the visitor to decide (`itemMode` in
   `shared/src/demo.ts`).
5. **Tasks.** The notetaker spots action items; the host dispatches them, an AI colleague accepts or declines in their own words (or the visitor accepts/approves their own task in the Wingman dock),
   and accepted drafts are executed against Gitea, Mattermost, Mailpit, Wiki.js, or Radicale CalDAV (`taskResponder.ts`, `NPC_APPROVE_DELAY_MS`).
6. **Wrap-up & Wiki minutes for approval.** After the final agenda item is settled, the host concludes the meeting and `server/src/action/wiki.ts` creates a **Publish meeting minutes to the team wiki** card with the full Markdown minutes already drafted. It is assigned to the visitor, never an AI seat, so the draft waits for their approval. Nothing is written yet: the person reviews and can edit the draft, then taps **Approve & publish**. Only then does Wiki.js get the page, surfacing the **Open meeting minutes in Wiki ↗** link in the dock.

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
| Join form, start prompt, stage, captions, type bar | `web/src/meeting/room/` |

Data topics (`shared/src/demo.ts`): `kaki.npc-state` (what the AI attendees are doing) and `kaki.control` (typed text, "typing", Stop, Resume and Lock). Start is a server call.

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

## Safe playtesting (draft-only)

To rehearse the whole meeting without touching Gitea, Mattermost, Mailpit, Wiki.js or the calendar, set
`KAKI_DRAFT_ONLY=1` on **both** the API/dev server and the NPC process, with the same value. For example:

```
KAKI_DRAFT_ONLY=1 SCENARIO=kopitiam npm start
# or, when running the pieces separately:
KAKI_DRAFT_ONLY=1 npm run dev
KAKI_DRAFT_ONLY=1 npm run npc
```

Tasks are still drafted and can be reviewed, including the end-of-meeting minutes card. An action that reaches `RUNNING`
(approved or retried) is refused before anything is sent and marked failed with a clear message, and AI attendees stop
auto-approving or retrying drafts. Unset it to run for real.

To rehearse with real writes to the local mock tools, run `npm run playtest:live -- --act` on a stack started **without** `KAKI_DRAFT_ONLY`; the robot then accepts and approves its own cards.

## Tuning

If an AI cuts itself off, raise `NPC_VAD_LEAK_MARGIN` or `NPC_VAD_GUARDED_MIN_LEVEL`. If cutting in feels sluggish, lower
`NPC_VAD_GUARDED_START_MS`. Headphones remove the echo problem entirely; laptop speakers rely on the browser's echo cancellation.

`KAKI_FAULT=control-garbled|slow-first|stall-mid|tts-fail` shows one failure on purpose during a live check: a garbled
control line, a 15 s delay before the first chunk, a stream that stops mid-reply, or every voice clip failing. Unset it
for a normal run; an unknown value stops the NPC at startup.

## Verified and not verified

- Unit tests cover the conversation, director, detector, gate, recorder and playback with fakes.
- `LIVEKIT_E2E=1 npx vitest run server/test/npc/livekit.e2e.test.ts` (needs `npm run stack:up`) runs the real runner against a real LiveKit
  server with a fake person, a scripted model and a fake voice, including echo and barge-in.
- Not covered by any test: Azure itself, the real model, real room acoustics, a browser's echo cancellation, the orbs on real LiveKit tiles.
  Those need a live run with a microphone.
