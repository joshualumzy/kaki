# Notetaker eval, round 2

- branch: `feature/scripted-replay`, commit: `85a5195`, 2026-11-04T05:26Z
- prompt file last changed in: `85a5195 tune(notetaker): stop inventing tickets and investigate/confirm tasks for discussed product work`
- result: 0 of 3 runs passed
- uncommitted prompt changes: 0 file(s)

## Run 1: FAIL (exit 1)

```text
kaki notetaker: dropped task "Clarify launch date for team"; its evidence is not in the transcript
kaki notetaker: dropped task "Update launch marketing budget"; its evidence is not in the transcript
kaki notetaker: dropped task "Email a target streamer for the live stream"; its evidence is not in the transcript

30 passes in 86.6 s, notetaker ok

Tasks (9):
  - File a bug ticket for the ten-customer crash → lead_programmer gitea_issue
  - Confirm crash cause with debug build → lead_programmer gitea_issue
  - Adjust soundtrack volume for rush → game_designer gitea_issue
  - Adjust level 5 difficulty → game_designer wiki_page
  - Prepare playtest materials for Friday → game_designer wiki_page
  - Add new tutorial step to pop-up → lead_programmer gitea_issue
  - Prepare demo tablets for launch → game_designer wiki_page
  - Prepare demo tablet budget → marketing_lead wiki_page
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (2×)
  - missing task: launch-date post
  - unexpected task: Adjust soundtrack volume for rush
  - unexpected task: Adjust level 5 difficulty
  - unexpected task: Prepare playtest materials for Friday
  - unexpected task: Add new tutorial step to pop-up
  - unexpected task: Prepare demo tablets for launch
  - unexpected task: Prepare demo tablet budget
  - missing question: where players quit
  - missing question: final-build date
```

## Run 2: FAIL (exit 1)

```text

30 passes in 65.9 s, notetaker ok

Tasks (4):
  - File a bug ticket for the ten-customer crash → lead_programmer gitea_issue
  - Confirm order queue clearing issue cause → lead_programmer gitea_issue
  - Post launch date in team channel → marketing_lead mattermost_post
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (1):
  - How much will it cost to borrow tablets? → marketing_lead
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (2×)
  - missing task: launch-date post
  - unexpected task: Post launch date in team channel
  - missing question: where players quit
  - missing question: final-build date
```

## Run 3: FAIL (exit 1)

```text
kaki notetaker: dropped task "Confirm final build for booth demo"; its evidence is not in the transcript

30 passes in 80.8 s, notetaker ok

Tasks (7):
  - File a bug ticket for the ten-customer crash → lead_programmer gitea_issue
  - Confirm crash cause with debug build → lead_programmer gitea_issue
  - Review and adjust stall upgrade prices for level 5 → game_designer wiki_page
  - Send milestone report to Starfruit → producer email
  - Post launch date in team channel → marketing_lead mattermost_post
  - Email a streamer about playing Hawker Heroes on launch day → marketing_lead email
  - Order stickers for the booth → marketing_lead gitea_issue
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (2×)
  - missing task: launch-date post
  - unexpected task: Review and adjust stall upgrade prices for level 5
  - unexpected task: Post launch date in team channel
  - unexpected task: Order stickers for the booth
  - missing question: where players quit
  - missing question: final-build date
```

