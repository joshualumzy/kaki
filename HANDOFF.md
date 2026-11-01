# Handoff Notes: AI Meeting NPC Debugging

## Current Branch
`feature/scripted-replay`

## Context & Goal
We are building a real-time interactive local LiveKit meeting experience featuring AI NPCs (Arjun and Maya) controlled by a single Director LLM. 
The user was experiencing severe issues with **acoustic feedback**: the open microphone was picking up the AI's TTS output from the speakers. This caused the AI's voice to be transcribed as the user's voice, leading the AI to interrupt itself and reply to its own echoed text.

## What Was Implemented (The 3-Layer Fix)
To combat the Azure STT limits and the acoustic feedback loop, the following changes were made:

1. **Replaced Azure STT with Local STT (`web/src/demo/LocalSpeechSTT.tsx`)**
   - We are now using the browser's native Web Speech API to transcribe user speech and emit it to the backend via `/dev/emit`.
   - **Frontend Mitigation:** The component tracks the AI's LiveKit `isSpeaking` state and a 4-second timer after the AI emits a transcript. If the AI is speaking, the frontend silently drops the transcribed chunks so they never reach the server.

2. **Backend Interim Blocker (`scripts/npc-runner.ts`)**
   - The NPC runner listens to the WebSocket for transcripts.
   - It maintains a `lastSynthesizedTexts` array. Before accepting a user transcript, it strips punctuation and checks if the text matches recently synthesized AI speech. If it's an echo, it ignores it.
   - `[INTERIM]` chunks are now strictly validated against this blocker so they don't trigger the "human interrupted" kill-switch prematurely.

3. **Ghost Transcript Expiration (`web/src/demo/MeetingGrid.tsx`)**
   - Fixed a bug where old transcripts (like "Good morning everyone") would get stuck on the screen or reappear when opening a new incognito window.
   - Transcripts now automatically expire and disappear from the UI after 15 seconds.

## Next Steps for the Next Agent
1. **Verify the Fix:** The user was extremely frustrated by the AI constantly interrupting itself. The processes are currently stopped. You will need to start the backend, frontend, and NPC runner to verify if the 3-layer fix completely resolved the acoustic feedback loop.
   - `npm run dev --workspace=server`
   - `npm run dev --workspace=web`
   - `npx tsx scripts/npc-runner.ts`
2. **Fallback Plan:** If the AI *still* interrupts itself (meaning the Web Speech API is somehow bypassing the frontend time-blocks), you may need to implement a hard pause on the `SpeechRecognition` instance while the AI is speaking, or investigate LiveKit's built-in acoustic echo cancellation (AEC) constraints.
3. **Remember the Constraints:** 
   - DO NOT spam macOS TCC permissions (do not kill Chrome, use explicit paths if using Puppeteer).
   - DO NOT expose raw `.env` secrets in your logs.
