# Notetaker eval, round 3

- branch: `feature/scripted-replay`, commit: `531aba0`, 2026-11-04T05:33Z
- prompt file last changed in: `531aba0 tune(notetaker): assign a task to whoever volunteered or was asked, not the topic's role`
- result: 0 of 3 runs passed
- uncommitted prompt changes: 0 file(s)

## Run 1: FAIL (exit 1)

```text
kaki notetaker: dropped task "Email a target streamer for the live stream"; its evidence is not in the transcript

30 passes in 74.1 s, notetaker ok

Tasks (4):
  - Track ten-customer crash → lead_programmer gitea_issue
  - Milestone report for Starfruit → producer email
  - Post launch date in team channel → marketing_lead mattermost_post
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - missing task: launch-date post
  - unexpected task: Post launch date in team channel
  - missing question: where players quit
  - missing question: final-build date
```

## Run 2: FAIL (exit 1)

```text
kaki notetaker: dropped task "Order hawker uncle stickers"; its evidence is not in the transcript

30 passes in 80.5 s, notetaker ok

Tasks (7):
  - Track ten-customer crash → lead_programmer gitea_issue
  - Adjust soundtrack volume in satay stall level → game_designer gitea_issue
  - Patience timer and pop-up adjustments for playtest → game_designer wiki_page
  - Pop-up tutorial step → lead_programmer gitea_issue
  - Adjust stall upgrade prices in level 5 → game_designer gitea_issue
  - Send milestone report to Starfruit → producer email
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (4):
  - Do they need the store page text from us too? → marketing_lead
  - Can we still get the two demo tablets? → studio_manager
  - How much do we need to save? → marketing_lead
  - When does Starfruit need the final build? → producer
Quiet roles: marketing_lead

FAIL
  - missing task: launch-date post
  - unexpected task: Adjust soundtrack volume in satay stall level
  - unexpected task: Patience timer and pop-up adjustments for playtest
  - unexpected task: Pop-up tutorial step
  - unexpected task: Adjust stall upgrade prices in level 5
  - missing question: where players quit
```

## Run 3: FAIL (exit 1)

```text
kaki notetaker: dropped task "Order stickers for Hawker Heroes booth"; its evidence is not in the transcript

30 passes in 108.2 s, notetaker ok

Tasks (10):
  - Track ten-customer crash → lead_programmer gitea_issue
  - Confirm order queue issue cause → lead_programmer gitea_issue
  - Fix pause menu text overlap and tutorial skip button issue → lead_programmer gitea_issue
  - Adjust soundtrack volume in rush mode → game_designer gitea_issue
  - Patience timer and pop-up for Friday's playtest → game_designer wiki_page
  - Send milestone report to Starfruit → producer email
  - Draft store page text → producer wiki_page
  - Post launch date in team channel → producer mattermost_post
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
  - Confirm booth build is crash-free → lead_programmer gitea_issue
Open questions (3):
  - What's the smallest change that gets people through level 5? → game_designer
  - Can we still get the two demo tablets? → game_designer
  - How much will it cost to borrow tablets from the office? → studio_manager
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (3×)
  - unexpected task: Fix pause menu text overlap and tutorial skip button issue
  - unexpected task: Adjust soundtrack volume in rush mode
  - unexpected task: Patience timer and pop-up for Friday's playtest
  - missing question: final-build date
```

