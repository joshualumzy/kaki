# Master Playtest Findings, Legacy Cleanups & Action Plan

- **Playtest Source:** [`.local-backup/playtests/feifei-li-transcript.md`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/.local-backup/playtests/feifei-li-transcript.md) (Raw logs: [`.local-backup/playtests/feifei-li-npc.log`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/.local-backup/playtests/feifei-li-npc.log) & [`.local-backup/playtests/feifei-li-dev.log`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/.local-backup/playtests/feifei-li-dev.log))
- **Model Upgrade Completed:** `.env` upgraded to `KAKI_LLM_MODEL=qwen3.6:35b` (live NPC Director, ~0.5–1.2s TTFT) and `KAKI_NOTETAKER_LLM_MODEL=qwen3.6:35b` (fast, accurate JSON Notetaker; `x-test-2` timed out at >20s on large JSON prompts).

---

## Part A: All 9 Legacy Code & Prompt Artefacts Found in the Codebase

1. - [x] **`"Accept or decline it on your phone"` spoken aloud ([`server/src/npc/runner.ts:487-490`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/runner.ts#L487-L490)):**
   - Rewritten in the `/demo` room runner to `"You can click Let Kaki do it in the Kaki Wingman panel on the right."` (while keeping `autoDispatch.ts` intact for `/screen` + `/phone` unit tests).
2. - [x] **Old video-game scenario examples in NPC Director prompt ([`server/src/npc/director.ts:183,188`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/director.ts#L183-L188)):**
   - Replaced `"the game freezes for the player after about ten orders"` and `"what the game is"` with scenario-agnostic phrasing.
3. - [x] **Robotic `"<Visitor>, as <Role>, can you..."` ending in a period `.` ([`server/src/npc/director.ts:48,62`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/director.ts#L48-L62) & [`server/src/host/notetaker.ts:187-245`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/host/notetaker.ts#L187-L245)):**
   - Removed `"as ${humanRoleLabel}"` and `"end with a period, NOT a question mark"` from `director.ts` so NPCs ask natural spoken questions (`"Feifei Li, could you post that decision in the team channel today so everyone has it?"`), and upgraded `addressedRole()` + `groundingLine()` in `notetaker.ts` so second-person requests route to the human visitor's role even when `zoomDisplayName` has no parentheses `(`.
4. - [x] **Hidden `[asking a clarifying question on X: answer with the facts on X only]` injection ([`server/src/npc/conversation.ts:1407-1413`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/conversation.ts#L1407-L1413)):**
   - Replaced with a natural context hint that allows in-character banter/greetings/compliment-checks before bridging back to the item.
5. - [x] **Naive `humanDecidedOnCurrentItem` detector ([`server/src/npc/conversation.ts:665-680`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/conversation.ts#L665-L680)):**
   - Updated `addAskCue()` so pure greetings, mic checks, and `"wait / hold on"` remarks do not flip `humanDecidedOnCurrentItem = true`.
6. - [x] **Old game-studio example in AI colleague task-acceptance prompt ([`server/src/npc/taskResponder.ts:68`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/taskResponder.ts#L68)):**
   - Replaced `"it's the order queue filling up"` with general operational phrasing.
7. - [x] **Old scenario examples in Notetaker & Wingman search prompts ([`server/src/host/notetaker.ts:402-403`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/host/notetaker.ts#L402-L403), [`server/src/wingman/knowledge/search.ts:69`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/wingman/knowledge/search.ts#L69)):**
   - Updated to scenario-agnostic examples (`"Sam (General Manager)"`, `"Wiki: Launch Operations Guide"`).
8. - [x] **Incomplete `withRoles` maps & catchphrase checklists in [`scenarios/kopitiam/scenario.json`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/scenarios/kopitiam/scenario.json#L152-L315):**
   - Added complete `withRoles` entries across all roles (`producer`, `lead_programmer`, `game_designer`, `marketing_lead`, `studio_manager`) and refined `speechStyle` so Singlish is used naturally (at most one light expression per turn when the emotion fits, never forced slang like `"very paiseh to ask"`).
9. - [x] **Mobile-era wording in Wingman / Demo UI:**
   - Preserved `nudges/module.ts` for `/phone` unit test compatibility while upgrading `/demo` stage toasts and right-dock cards to reference the right panel directly.

---

## Part B: All 12 Technical Bugs from Feifei's Playtest Logs

1. - [x] **Premature Meeting Advance on Mid-Discussion Side-Task ([`conversation.ts:214,724`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/conversation.ts#L724)):** Fixed via `decisionWrappedUpOnItem` guard.
2. - [x] **Post-Meeting Auto-Reset / Silence Timer Desync ([`conversation.ts:203,489`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/conversation.ts#L489)):** Fixed via `this.concluded = true` on `announceClosing` so no trailing speech or timer can emit a `TRANSCRIPT_CHUNK` after the meeting concludes.
3. - [x] **Self-Harm / Canned Guardrail Refusal Loop ([`conversation.ts:1300-1480`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/conversation.ts#L1300-L1480)):** Fixed by intercepting `SAFETY_REFUSAL_RE`, scrubbing the triggering turn from `this.history`, and using a dynamic 1-sentence LLM colleague care check-in once the static fallback lines have been used so repeated probing never sounds repetitive.
4. - [x] **"Wei Ling" Default Seat Name Leaked in Task Dispatch ([`runner.ts:484-486`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/runner.ts#L484-L486)):** Fixed by replacing `visitor.seat` (`Wei Ling`) with `visitor.name` (`Feifei Li`) in spoken dispatch cues.
5. - [x] **Double Speaker Prefix Leak (`Sam: Wei Ling: Absolutely!`) ([`director.ts:245,361`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/director.ts#L245)):** Fixed by passing `seatNames` (`extraNamesToStrip`) to `TurnParser`.
6. - [x] **Prompt Instruction Echoed Aloud (`"You are now speaking directly to..."`) ([`director.ts:242-243`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/director.ts#L242-L243)):** Fixed by expanding `META_LEAK`.
7. - [x] **Third-Person Self-Address Confusion (`"address Ms. Li's question"`) ([`director.ts:191`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/director.ts#L191)):** Fixed in `buildSystemPrompt`.
8. - [x] **Notetaker Duplicate Open-Question Console Spam ([`notetaker.ts:490`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/host/notetaker.ts#L490)):** Fixed by silencing the duplicate warning and upgrading Notetaker to `qwen3.6:35b`.
9. - [x] **Repetitive Stage-1 Silence Script Line ([`conversation.ts:1017-1055`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/conversation.ts#L1017-L1055)):** Fixed so `silencePromptStage` does not reset to 0 on every visitor remark and Stage 1 uses a contextual LLM check-in once the visitor has spoken.
10. - [x] **Voice Fix A — Multi-Word Confirmation Confidence Rescue ([`server/src/npc/sttFilter.ts`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/sttFilter.ts)):**
    - Kept `minConfidence = 0.60` for 1–2 word noises, and lowered threshold to `0.40` (`MULTI_WORD_MIN_CONFIDENCE`) for 3–4 word utterances (`"You hear me?"`, `"Can you hear me?"`) and explicit confirmation phrases (`CONFIRMATION_PHRASE_RE`). Zero changes to `vad.ts` or `echoGate.ts`.
11. - [x] **Voice Fix B — Clear Stale `unanswered = true` & `cutOff = true` When Visitor Speaks Again ([`server/src/npc/conversation.ts:268,440`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/conversation.ts#L440)):**
    - Cleared `this.unanswered = false; this.cutOff = false;` in `humanText()` and `humanTyped()` so a trailing `humanNothing()` after a barge-in can never fire a stale `[made a sound]` resume.
12. - [x] **Right-Panel `CLAIMED` Auto-Advance Collision ([`server/src/npc/main.ts:218-235`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/main.ts#L218-L235) & [`conversation.ts:703-728`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/conversation.ts#L703-L728)):**
    - Added `holdForHumanTask(25_000)`: when the visitor actively clicks **"Let Kaki do it"** (`CLAIMED` + `ACTION_AGENT` on a human-assigned task), the advance and silence timers are held for 25s while Kaki generates the draft, and `taskAccepted()` fires as soon as the task reaches `RUNNING`, `COMPLETED`, or `DECLINED` (or immediately when an AI colleague claims a task).

---

## Part C: All 12 Conversational, Personality, Role & UI/UX Improvements We Discussed

### Conversational Realism & Personality (`director.ts`, `conversation.ts`, `scenario.json`)
1. - [x] **Never Break Character as an AI ([`director.ts:186`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/director.ts#L186)):**
   - Verified in live `qwen3.6:35b` simulation (`"Parameters? Are you sure you had your morning kopi yet?"`).
2. - [x] **Evidence-Based Banter & Reactions (No Hollow Flattery) ([`director.ts:191`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/director.ts#L191)):**
   - Verified in live `qwen3.6:35b` simulation (`"Haha, Feifei Li, we are still on item one, make this call first and then we'll give you the trophy!"`).
3. - [x] **Local Time-of-Day Awareness ([`director.ts:133-138,157`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/director.ts#L133-L138)):**
   - Injects `morning` / `afternoon` / `evening` from the local system clock into `buildSystemPrompt`.
4. - [x] **Natural First-Turn Self-Introductions ([`director.ts:157`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/director.ts#L157)):**
   - Characters naturally weave in their name and domain on their first turn in the meeting.
5. - [x] **Organic Constraint Pushback & Discussion Depth (Without Rigid Turn Counters) ([`director.ts:65,193`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/director.ts#L65)):**
   - Verified in live `qwen3.6:35b` simulation: when the visitor proposed a 3D animated virtual barista overnight, Arjun and Mei pushed back with concrete touchscreen and 4-hour engineering constraints; once the visitor proposed the practical 20-minute `'Usual Set A'` shortcut + next-week toggle, Mei locked it in and asked for the Mattermost team channel post.
6. - [x] **Creative "Option C" Pivot to Kaki Actions ([`director.ts:61-65,175`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/director.ts#L61-L65)):**
   - Verified with Notetaker extracting `mattermost_post` (`suggestedAssignee: "producer"`) from Mei's natural `?` question.
7. - [x] **Natural Singlish & Sharper Character Archetypes ([`scenarios/kopitiam/scenario.json`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/scenarios/kopitiam/scenario.json#L152-L315)):**
   - Completed across all 5 NPC profiles.
8. - [x] **Human Playing as Host (`General Manager`) — Option 2 with NPC Co-Host + Kaki Host Cues ([`conversation.ts:634-644`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/conversation.ts#L634-L644), [`runner.ts:292-300`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/runner.ts#L292-L300), [`MeetingPanel.tsx:361-387`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/web/src/demo/MeetingPanel.tsx#L361-L387)):**
   - Added `facilitatorOrCoHost()` in `conversation.ts`, automatic item-1 briefing trigger in `runner.ts` when `hostIsHuman()` is true, role guidance in `JoinForm.tsx`, and `HostCueCard` in `MeetingPanel.tsx`.
9. - [x] **Natural Overrun Time-Check (`TIMEOUT`) ([`runner.ts:491-498`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/npc/runner.ts#L491-L498)):**
   - Rewrites the robotic `"Time is up on X. Keep going, or move on to Y?"` cue into a warm, natural check-in from Sam (`"Feifei Li, we're a bit past time on X — do you want another minute on this, or should we lock in a call so we can get to Y?"`).

### UI/UX & Onboarding (`web/src/demo/`)
10. - [x] **Floating Kaki Action / Wingman Toast on the Main Video Stage ([`web/src/demo/MeetingGrid.tsx:100-149`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/web/src/demo/MeetingGrid.tsx#L100-L149)):**
    - Displays a sleek, dismissible floating toast at the top of the video stage whenever a task is assigned to the visitor (`DISPATCHED`), a draft is ready (`DRAFT_READY`), or a company record (`FACT_FOUND`) is surfaced.
11. - [x] **Right Panel Redesign into 3 Scannable Zones ([`web/src/demo/MeetingPanel.tsx:177-278`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/web/src/demo/MeetingPanel.tsx#L177-L278)):**
    - **Zone 1 (Top):** Agenda clock + `CurrentTopicCard` with scannable `.kd-fact-chip` cards (and `HostCueCard` when hosting).
    - **Zone 2 (Middle Hero):** **Live Kaki Actions** moved *above* the transcript with status badges and owner labels.
    - **Zone 3 (Bottom Collapsible):** Collapsible `Live transcript (N)` drawer showing a 1-line preview of the latest utterance when collapsed so the transcript never pushes Kaki Actions off-screen.
12. - [x] **3-Step Interactive Pre-Meeting Tutorial ([`web/src/demo/StartPrompt.tsx:11-76`](file:///Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/web/src/demo/StartPrompt.tsx#L11-L76)):**
    - Interactive 3-tab tour (`1. Briefing`, `2. Wingman`, `3. Actions`) with a `Next tip →` button and `Start the meeting` CTA.
