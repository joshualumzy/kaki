# Notetaker eval, round 1

- branch: `feature/scripted-replay`, commit: `92618ae`, 2026-11-04T05:17Z
- prompt file last changed in: `fc855dc fix(host): ignore notetaker 'questions' that are not phrased as questions`
- result: 0 of 3 runs passed
- uncommitted prompt changes: 0 file(s)

## Run 1: FAIL (exit 1)

```text
kaki notetaker: dropped task "Confirm booth activities"; its evidence is not in the transcript
kaki notetaker: dropped task "Update the release build for the booth"; its evidence is not in the transcript

30 passes in 105.4 s, notetaker ok

Tasks (10):
  - File a bug ticket for the ten-customer crash → lead_programmer gitea_issue
  - File a bug ticket for the timer change → lead_programmer gitea_issue
  - Patience and Tutorial Pop-up → game_designer wiki_page
  - Adjust soundtrack volume during rush → lead_programmer gitea_issue
  - Update the timer config value → lead_programmer gitea_issue
  - Adjust stall upgrade prices → game_designer gitea_issue
  - Draft store page text → producer wiki_page
  - Confirm demo tablet availability → game_designer mattermost_post
  - Email a streamer about playing Hawker Heroes → marketing_lead email
  - Email the launch marketing and booth budget → marketing_lead email
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - missing task: launch-date post
  - unexpected task: File a bug ticket for the timer change
  - unexpected task: Patience and Tutorial Pop-up
  - unexpected task: Adjust soundtrack volume during rush
  - unexpected task: Update the timer config value
  - unexpected task: Adjust stall upgrade prices
  - unexpected task: Confirm demo tablet availability
  - unexpected task: Email the launch marketing and booth budget
  - missing question: where players quit
  - missing question: final-build date
```

## Run 2: FAIL (exit 1)

```text

30 passes in 106.7 s, notetaker ok

Tasks (6):
  - File bug ticket for ten-customer crash → lead_programmer gitea_issue
  - Update patience timer and pop-up for Friday's playtest → game_designer wiki_page
  - Adjust stall upgrade prices for level 5 → game_designer gitea_issue
  - Draft store page text with Daniel → producer wiki_page
  - File bug ticket for demo tablet status → lead_programmer gitea_issue
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (3):
  - Who is the streamer that will play Hawker Heroes? → marketing_lead
  - How will we know if there is budget left for stickers? → marketing_lead
  - What is the status of the demo tablets? → lead_programmer
Quiet roles: marketing_lead

FAIL
  - missing task: launch-date post
  - unexpected task: Update patience timer and pop-up for Friday's playtest
  - unexpected task: Adjust stall upgrade prices for level 5
  - unexpected task: File bug ticket for demo tablet status
  - missing question: where players quit
  - missing question: final-build date
```

## Run 3: FAIL (exit 1)

```text
kaki notetaker: dropped task "Confirm patience timer config value"; its evidence is not in the transcript

30 passes in 124.0 s, notetaker ok

Tasks (10):
  - File a bug ticket for the ten-customer crash → lead_programmer gitea_issue
  - Confirm crash cause with debug build → lead_programmer gitea_issue
  - Confirm tutorial skip change → lead_programmer gitea_issue
  - Confirm new tutorial step for pop-up → lead_programmer gitea_issue
  - Confirm milestone payment status → producer wiki_page
  - Draft store page text with Daniel → marketing_lead wiki_page
  - Post launch date in team channel → marketing_lead mattermost_post
  - Confirm final build date → producer wiki_page
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
  - File a budget request for stickers → studio_manager gitea_issue
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (2×)
  - missing task: launch-date post
  - unexpected task: Confirm tutorial skip change
  - unexpected task: Confirm new tutorial step for pop-up
  - unexpected task: Draft store page text with Daniel
  - unexpected task: Post launch date in team channel
  - unexpected task: Confirm final build date
  - unexpected task: File a budget request for stickers
  - missing question: where players quit
  - missing question: final-build date
```

