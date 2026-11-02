# Replay check results

- Date and time: 2026-11-02 18:35
- Commit tested (`git rev-parse --short HEAD`): f10de3d
- Machine and browser: Mac OS, Headless Chrome (via Puppeteer)

## Before facts
- Mailpit emails before: 5
- Gitea issues before: 9
- Mattermost #launch newest post before: 18 threads

## Results

### 1. Tasks
FAIL

| Title | Suggested Assignee |
|---|---|
| File bug ticket for ten-customer crash | lead_programmer |
| File bug ticket for timer issue | lead_programmer |

### 2. Open questions
FAIL (Missed final-build date)

- "Can the tutorial skip go in before the playtest on Friday?" (`q-1`, `q-2` for `game_designer`)
- "Do the screenshots need the new UI?" (`q-3` for `marketing_lead`)
- "Is it the timer?" (`q-4` for `lead_programmer`)
- "Do we know exactly where in level 5 players quit?" (`q-5` for `lead_programmer`)

### 3. Answers
FAIL (Duplicates and misallocations)

- Question: "Can the tutorial skip go in before the playtest on Friday?" (Received by `game_designer`)
  - "We ran out of time in the playtest review and have not decided whether to tune the boss or move the checkpoint." (Source: Gitea: hawker-heroes #5 (10 Nov), Date: 2026-11-10)
  - "Mei says the wall is intentional; Daniel says streamers will bounce." (Source: Gitea: hawker-heroes #5 (10 Nov), Date: 2026-11-10)
  - "The milestone payment stays the same once the build is accepted. I know this is tight - call me if the team needs to talk through what can move." (Source: Starfruit email (16 Nov), Date: 2026-11-16)
  *Note: Answered twice with the exact same facts.*

- Question: "Is it the timer?" (Received by `game_designer` and `lead_programmer`)
  - "The difficulty spike on level 5 is deliberate to make players feel the game tighten before the finale." (Source: Wiki / Wiki: Hawker Heroes - Game Design Doc, Date: 2026-10-28)
  - "14 out of 20 testers quit before level 6, which Mei says is not a difficulty curve but a leak in the design." / "14 out of 20 testers quit on level 5 during playtest round 3..." (Source: Mattermost / Mattermost: #playtest-feedback thread)
  - "The newer discussion in Mattermost (10 Nov) says the difficulty spike is meant to be hard and teach combo timing, but the wiki contract summary (28 Oct) still says it's a tuning issue." (Source: Both Mattermost and Wiki)

- Question: "Do we know exactly where in level 5 players quit?" (Received by `lead_programmer` multiple times)
  - "Most quits happen on the third queue, which is at the boss order in level 5." (Source: postgres ref=playtest_quit_stats/level-5, Date: 2026-11-10)
  - "The newer Mattermost email (16 Nov) says most of them quit at the boss order, not on the level itself. The wiki contract summary (10 Nov) still says the 20th." (Source: mattermost, Date: 2026-11-10)
  - "14 out of 20 testers quit on level 5, most of them at the boss order." (Source: mattermost, Date: 2026-11-10)

- Question: "Do the screenshots need the new UI?" (Received by `marketing_lead`)
  - "The new chicken rice stall front is in build 0.9.7, but it's over budget." (Source: Mattermost #art (9 Nov))
  - "The trailer capture build needs the save fix and the night market frame rate fix, but the frame rate fix is not in yet." (Source: Mattermost #launch (11 Nov))
  - "The old logo is still on the splash screen, but it was updated to the new logo in build 0.6.1." (Source: Gitea #2 (4 Aug))

### 4. Nudges
FAIL (Missed quiet nudge for marketing_lead)

- `lead_programmer`: "Build and bugs has 8 min left. The trailer capture build needs the save fix and the night market frame rate fix, but only the save fix is in. Tap the fact card to read the details." (approx ~120s)
- `game_designer`: "Level 5 difficulty and playtest feedback has 8 min left. 19 of the 29 playtesters who reached level 5 quit there. Mei says the wall is intentional; Daniel says streamers will bounce. Tap the fact card to read the details." (approx ~120s)

### 5. Host speech
FAIL (Only 1 speech triggered)

- `OPENING`: "Next up: Level 5 difficulty and playtest feedback."

### 6. Quiet flag
PASS

- `marketing_lead` flagged quiet starting at elapsed time 140s through the end of the meeting.

### 7. Errors
PASS

- No `kaki host:` or `kaki wingman:` error lines found in `replay.log`.

## Manual actions
NOT RUN / FAIL
Attempted to use an automated browser (Puppeteer) to press "Dispatch to Lead Programmer" on the "File bug ticket for ten-customer crash" task. The UI failed to fully process the automated dispatch/click, making it impossible to claim or approve drafts through the agent script. Could not verify artifact links.
