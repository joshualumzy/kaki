# Notetaker eval, round 4

- branch: `feature/scripted-replay`, commit: `32f5179`, 2026-11-04T05:39Z
- prompt file last changed in: `32f5179 tune(notetaker): a reply that does not give the answer leaves the question open`
- result: 0 of 3 runs passed
- uncommitted prompt changes: 0 file(s)

## Run 1: FAIL (exit 1)

```text

30 passes in 97.0 s, notetaker ok

Tasks (4):
  - File a bug ticket for the ten-customer crash → lead_programmer gitea_issue
  - Skip tutorial for playtest → lead_programmer gitea_issue
  - Post launch date in team channel → marketing_lead mattermost_post
  - Confirm final build date with Starfruit → producer email
Open questions (2):
  - Can we still get the two demo tablets? → marketing_lead
  - What is the final build date? → producer
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (2×)
  - missing task: launch-date post
  - missing task: streamer email
  - unexpected task: Post launch date in team channel
  - unexpected task: Confirm final build date with Starfruit
  - missing question: where players quit
```

## Run 2: FAIL (exit 1)

```text
kaki notetaker: dropped task "Confirm tutorial skip change"; its evidence is not in the transcript
kaki notetaker: dropped task "Confirm booth budget with Indie Arcade SG"; its evidence is not in the transcript
kaki notetaker: dropped task "Email store page text to publisher"; its evidence is not in the transcript

30 passes in 90.8 s, notetaker ok

Tasks (6):
  - File a bug ticket for the ten-customer crash → lead_programmer gitea_issue
  - Confirm crash issue cause → lead_programmer gitea_issue
  - Adjust soundtrack volume → lead_programmer gitea_issue
  - Confirm milestone payment report is fine → producer wiki_page
  - Confirm demo tablet availability → studio_manager mattermost_post
  - Confirm sticker budget → marketing_lead wiki_page
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (2×)
  - missing task: launch-date post
  - missing task: streamer email
  - unexpected task: Adjust soundtrack volume
  - unexpected task: Confirm demo tablet availability
  - unexpected task: Confirm sticker budget
  - missing question: where players quit
  - missing question: final-build date
```

## Run 3: FAIL (exit 1)

```text

30 passes in 107.5 s, notetaker ok

Tasks (4):
  - File bug ticket for ten-customer crash → lead_programmer gitea_issue
  - Adjust stall upgrade prices for level 5 → game_designer gitea_issue
  - Post launch date in team channel → marketing_lead mattermost_post
  - Email streamer about playing Hawker Heroes on launch day → marketing_lead email
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - missing task: launch-date post
  - unexpected task: Adjust stall upgrade prices for level 5
  - unexpected task: Post launch date in team channel
  - missing question: where players quit
  - missing question: final-build date
```

