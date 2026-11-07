# Complete Archive of Product, Scenario & UI/UX Discussions and Findings (Nov 7, 2026)

> **Purpose of this Document:**
> This file preserves the **entire design reasoning, user critiques, product philosophy, root-cause bug findings, and "10x better" ideas** from our November 7, 2026 design and playtesting session (`e1fdfa3c-dd5a-4bac-b433-6fabc0f5e0cf`).
> Any future developer or AI agent starting a new session in this repo can read this file alongside `docs/live-demo.md` to immediately understand every decision made.

---

## 1. Core Product & Design Philosophy Established in Our Discussions

### Discussion 1: Realistic, Relatable, Open-Ended Scenarios That Cannot Be "One-Shotted"
- **User Critique:**
  - The original `hawker` game-dev scenario felt dry/jargony, and earlier Kopitiam drafts either had too many random numbers or allowed a visitor to "one-shot" the problem with a single obvious answer, which makes having a live meeting pointless.
- **What We Agreed & Built:**
  - Every agenda item must feel **immediately relatable to anyone in Singapore** on the surface (zero domain jargon needed to join in), yet contain **real second-order operational, technical, or human catches** underneath so no visitor can one-shot it in Turn 1:
    - **Turn 1 (Colleagues Brief the Room):** Two colleagues explain what is happening on the shop floor and why their initial instincts clash, ending with an open-ended question to the visitor — while holding back at least one second-order catch.
    - **Turn 2 (The "Yes, But..." Second-Order Catch):** When the visitor offers their first idea (`humanProposalsOnCurrentItem === 1`), colleagues acknowledge what works in that idea, and then the colleague whose constraint isn't solved yet raises the concrete second-order catch from their facts (e.g., POS thermal printer coupling, Auntie Mary refusing to play seat police, NEA glove-change hygiene rules, or wholesale Anchor butter margin + hot-toast takeaway condensation) and asks how to adapt the plan.
    - **Turn 3 (Lock-In & Actionable Deliverable):** Once the visitor addresses the trade-off (including any creative Option C of their own), the team locks in the combined call and Kaki dispatches the follow-up deliverable (`mattermost_post`, `gitea_issue`, `email`, `wiki_page`, or `calendar_event`).

---

### Discussion 2: Eliminating "AI-Speak" & Parallel Reskinned Scenarios
- **User Critique:**
  - Looking at the earlier 4 Kopitiam topics:
    1. *"40 peak GrabFood orders and 12 riders are jamming our single toaster"* sounded like robotic AI-speak rather than how a real kopitiam manager talks.
    2. Worse, *"GrabFood jamming the toaster"* and *"28-seat tissue-packet chope-ing & laptop campers"* were structurally parallel bottleneck scenarios just reskinned!
    3. Similarly, the old *"1-for-1 Kaya Toast queue blocking the mall escalator"* was another physical bottleneck reskin.
- **What We Agreed & Built (4 Genuinely Distinct Conflict Archetypes):**
  1. **UX / Cultural Identity vs. Legacy Kitchen Hardware (`Kiosk Kopi lingo vs English menu`, 4 min):**
     - First-time expats/tourists freeze at `'Kopi O Kosong'` on the kiosk, but renaming POS buttons to `'Black Coffee No Sugar'` prints long English strings directly onto the kitchen thermal docket (`ticket_label`), slowing down our 65-year-old kopi uncles by 15s/cup, and 2-line subtitles overflow the 15-inch 12-button grid.
  2. **Social Etiquette & Floor Space vs. Staff Safety (`28-seat chope-ing & laptop table-hogging`, 4 min):**
     - Office workers chope tables with tissue packets before joining the 15-minute queue while freelancers camp at 4-seater booths for 2 hours on one $2.20 Kopi O using wall sockets and Wi-Fi. Catch: 62-year-old Auntie Mary got yelled at by a man in a suit last week and refuses to play seat police, while 60% of morning customers dine solo carrying wobbly trays of hot soft-boiled eggs.
  3. **Digital Exclusion & PR Backlash vs. NEA Hygiene Rules (`Cashless-only kiosks vs. elderly uncles with cash`, 4 min):**
     - 14 retired morning regulars walked out angry over our `'NO CASH'` kiosk sign and a TikTok clip of a 74-year-old uncle hit 40,000 views. Catch: We removed the counter cash drawer because under NEA food-hygiene rules, our 2 toast counter staff cannot touch dirty coins/notes and slice ready-to-eat kaya toast without changing gloves every order (+40s delay & $380/mo coin-counting overtime), and kiosk cash bill-acceptors cost $1,400 and take 3 weeks.
  4. **Viral Food Critic Crisis vs. Raw Ingredient Margin & Kitchen Physics (`Viral TikTok roasting our 'shrinking butter slice'`, 4 min):**
     - Food TikToker `@MakanWithZack` (85k followers, 90k views) roasted our Kaya Butter Toast as having "half as much cold butter as Ya Kun" and offered a live re-taste tomorrow at 8:30 AM ($600 cash or $450 + 20 Kaya Toast plushies out of $750 budget). Catch: Wholesale Anchor salted butter jumped 35% (doubling butter wipes out $1,100/mo margin), AND kitchen CCTV proved our butter slice didn't shrink — a part-timer put cold butter onto piping-hot toast straight off the grill inside an unvented takeaway box, melting half the slab into the bread before Zack opened it.

---

### Discussion 3: ADHD-Friendly Onboarding, Story-First Intro, and No Pre-Meeting Wall of Text
- **User Critique:**
  - Before the visitor even said a single word, there was way too much text on screen spelling out all 4 situations (when only 2 are tackled in a meeting), and Step 1 (`1. Story & Your Role`) dumped spreadsheet numbers (*"28 seats, 1 floor auntie, $750 budget, 35% butter spike"*) before even introducing what Nanyang Kopi & Toast is!
  - Also, putting `Start the meeting` as the giant primary button on Step 1 meant visitors clicked it immediately and skipped Step 2 (`Today's 2 Crises`) and Step 3 (`Room & Wingman Guide`).
- **What We Agreed & Built:**
  - **Warm Story Introduction First (`web/src/demo/StartPrompt.tsx`):** Step 1 now opens with a human story introducing **Nanyang Kopi & Toast** (our heritage Singapore kopitiam famous for charcoal-grilled kaya butter toast, soft-boiled eggs, and sock-pulled Nanyang kopi, reopening our refurbished Raffles Place flagship tomorrow at 8:00 AM) and who you are in plain words — **zero random numbers on Step 1**.
  - **Only Today's 2 Active Crises Shown on Step 2:** Filtered `scenario.agenda` so the visitor only sees the 2 crises actually scheduled for this session.
  - **Guided Primary Button + `Skip tutorial →` Link:** Primary CTA advances through the 3 steps (`Next: See Today's 2 Crises →` → `Next: Live Room Spotlight →` → `Next: Spotlight Kaki Wingman →` → `Start the meeting`), with a secondary `Skip tutorial →` link for returning users.

---

### Discussion 4: "10x Better" Interactive Ideas & Motion Graphics
- **User Question:**
  - *"You literally said a real spotlight tour on the actual website is 10x better than a static image. Aside from this, what else do you think we can do 10x better? And what if the colleagues are able to give emoji-like reactions?"*
- **The "10x Better" Features We Discussed & Shipped:**
  1. **Real Live Interactive Spotlight Tour on Step 3 (`web/src/demo/StartPrompt.tsx`, `web/src/demo/demo.css`):**
     - Instead of a static diagram of the UI, Step 3 unblurs the actual live room behind a glowing spotlight cutout (`.kd-spotlight-frame`) that highlights the **Left Stage (AI Colleagues + Mic/Type Controls)** first and then slides over to spotlight the **Right Kaki Wingman Dock**.
  2. **Live Colleague Emoji & Mood Reaction Pills (`web/src/demo/MeetingGrid.tsx`, `web/src/demo/demo.css`):**
     - Each colleague's tile shows a floating animated reaction badge (`💭 Thinking…`, `😬 Hold on — there's a catch!`, `👍 Backs this call`, `🙌 Locked in!`, `🎤 Over to you!`, `👀 Listening to you`) that reacts dynamically to the conversation state.
  3. **Colleague Role & Stance Subtitles on Every Tile (`web/src/demo/MeetingGrid.tsx`):**
     - Under each colleague's name pill (`Wei Ling · Operations Director`), a subtle stance tag shows what they guard (`Guards staff, hygiene & margins`, `Keeps POS & kiosks simple`, `Protects Kopi & Toast craft`, `Watches TikTok & PR buzz`, `Chairs the meeting`).
  4. **Visual Interactive Role Seat Cards on Join Screen (`web/src/demo/JoinForm.tsx`) & Step 1 (`web/src/demo/StartPrompt.tsx`):**
     - Replaced the plain `<select>` dropdown feel with clickable visual role cards showing an icon, role title, character name, and 4-word superpower, plus instant role-switching on Step 1.
  5. **Visual Source Badges on Company Record Cards (`web/src/demo/MeetingPanel.tsx`):**
     - Replaced raw file paths with scannable pills (`📖 Wiki SOP`, `🐛 Gitea Ticket`, `💬 Team Chat`, `📧 Email`, `📊 Store DB`).
  6. **Animated SVG Motion Graphics (`web/public/scenario/*.svg`):**
     - Added CSS keyframe animations inside `kopitiam-hero.svg` (rising kopi steam, swinging warm pendant lamps, pulsing 8:00 AM badge) and all 4 crisis illustrations (`crisis-kiosk-lingo.svg`, `crisis-seat-chope.svg`, `crisis-cashless-uncles.svg`, `crisis-butter-slice.svg`), and widened all speech bubbles so quotation marks never overflow.

---

### Discussion 5: Live Meeting Pacing, Self-Introductions, Short Caption Bursts & Anti-Spoon-Feeding
- **User Critique from Live Playtesting:**
  1. `"🎙️ The meeting server is listening"` was floating in an awkward spot right over the `⏸ Pause` button; why not a small green online indicator button instead?
  2. Sam's `SPEAKING` badge overlapped `Sam · General Manager` (`PEAKING`).
  3. Every agenda item should be **4 minutes**, and **every character (starting with Sam) should introduce themselves** the first time they speak.
  4. Before Sam even finished his first two sentences (`0:12`), `Kaki Wingman · From the company records` and `Wingman` cards popped up in the right dock — and worse, showed a `cashless-only kiosk` card from an earlier session during the `shrinking butter slice` item!
  5. Pressing `⏸ Pause` (or waiting during Sam's intro) immediately popped up `🟢 Your turn — speak or click a question` with pre-written questions, and both the starter chips and company records felt like they were handing solutions directly to the visitor.
  6. Live captions on the video tiles appeared as a long paragraph instead of short, readable bursts.
- **Root Causes Found & How We Fixed Each One:**
  1. **Compact Green Voice Status Indicator (`web/src/demo/TypeBar.tsx`, `web/src/demo/LocalSpeechSTT.tsx`, `web/src/demo/demo.css`):**
     - Removed the floating overlay pill from `LocalSpeechSTT.tsx` and added a compact `.kd-mic-online-pill` (`● VOICE ACTIVE` with a pulsing green dot when unmuted / `● MIC MUTED` when muted) docked cleanly to the left of the bottom input bar.
  2. **Fixed Tile Header Overlap (`web/src/demo/demo.css`):**
     - Added `max-width: calc(100% - 102px); overflow: hidden; text-overflow: ellipsis;` to `.kd-who` so the left name/role pill never touches `.kd-state` (`SPEAKING` / `IDLE`).
  3. **Every Character Introduces Themselves on Their First Turn (`server/src/host/opening.ts`, `server/src/npc/conversation.ts`):**
     - Updated `liveOpeningLine()` in `server/src/host/opening.ts` so Sam introduces himself (*"Welcome to our Nanyang Kopi & Toast huddle, [Name] — I'm Sam, your General Manager, and we're glad you're here as [Role]..."*) and removed the duplicated *"two launch problems, and we've got 2 quick issues"* clause.
     - Added `this.introduced = new Set<string>()` in `NpcConversation` (`server/src/npc/conversation.ts`) and updated `briefCue()` + turn notes so every colleague (`Arjun`, `Mei`, `Wei Ling`, `Daniel`) explicitly opens their very first turn in the meeting by introducing their name and role (*"Hey [Name], I'm Arjun, Tech & POS Lead —"*).
  4. **Cleared Stale `fact:*` Events & Gated Right-Dock Cards (`server/src/host/meeting.ts`, `server/src/wingman/knowledge/module.ts`, `server/src/wingman/nudges/module.ts`, `server/src/app.ts`, `web/src/demo/MeetingPanel.tsx`, `web/src/phone/PhonePage.tsx`):**
     - Added `hub.clearRetained('fact:')` and `hub.clearRetained('nudge:')` on `resetMeeting()` and when a fresh visitor joins an empty room, and cleared `QuestionLog` in `knowledgeModule` on `MEETING_RESET`.
     - Removed the duplicate `FactCard` from `ActiveRoleCards` in `PhonePage.tsx`.
     - Gated `CurrentTopicCard` and `From the company records` in `MeetingPanel.tsx` behind `topicBriefingStarted` so they never appear while Sam is still introducing himself.
  5. **Tightened `"Your turn"` Trigger & Removed Spoon-Fed Solutions (`web/src/demo/MeetingGrid.tsx`, `scenarios/kopitiam/seed/gitea/issues.json`, `scenarios/kopitiam/seed/wiki/*.md`):**
     - Changed `waitingForHuman` to require `npcState.kind === 'idle' && npcState.yourTurn !== undefined && hasColleagueBriefed` (so pressing `⏸ Pause` or listening to Sam's opening never triggers it).
     - Made starter prompts an optional collapsed button (`💡 Need a question idea?`) with neutral diagnostic questions rather than pre-packaged solutions.
     - Rewrote seeded Gitea issues and Wiki SOPs to present **constraints, costs, NEA rules, CCTV findings, and POS specs** instead of pre-written *"Fix options: This solution uses..."* answers, and re-indexed the 38 knowledge chunks in `pgvector`.
  6. **Short-Burst Live Captions (`web/src/demo/captions.ts`, `web/src/demo/captions.test.ts`):**
     - Added `splitCaptionBursts(text, 11)` in `web/src/demo/captions.ts` so long spoken sentences are split at natural clause boundaries into bursts of **at most 11 words** and paced at ~2.8 words/sec as the character speaks.

---

## 2. Automated Verification & Restart Commands

```bash
# Run unit & integration tests (507 tests across 50 suites):
npm run typecheck && npm test

# Start the live Kopitiam stack:
npm run stack:up
SCENARIO=kopitiam npm run dev
SCENARIO=kopitiam npm run npc
```
