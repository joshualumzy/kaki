# Notetaker eval, round 16

- branch: `feature/scripted-replay`, commit: `4832b6f`, 2026-11-04T07:56Z
- model: `x-test-2`
- prompt file last changed in: `4832b6f tune(notetaker): shorter prompt, same principles (experiment, keep only if 3 of 3 and no slower)`
- result: 2 of 3 runs passed
- uncommitted prompt changes: 0 file(s)

## Run 1: PASS

```text

30 passes in 203.0 s, notetaker ok

Tasks (5):
  - File bug ticket for the ten-customer crash with repro steps → lead_programmer gitea_issue
  - Send milestone report to Starfruit → producer email
  - Draft store page text with Daniel → producer wiki_page
  - Post launch date in team channel once final build date is confirmed → producer mattermost_post
  - Email a cozy/cooking streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (7):
  - Can the tutorial skip go in before the playtest on Friday? → lead_programmer
  - What is the status of the store screenshots? → marketing_lead
  - Is it the timer? → game_designer
  - Where in level 5 do players quit — the first rush, the second stall, or the end? → game_designer
  - When does Starfruit need the final build? → producer
  - Can we still get the two demo tablets? → marketing_lead
  - Will the booth build be the release build? → producer
Quiet roles: marketing_lead

PASS
```

## Run 2: PASS

```text

30 passes in 187.8 s, notetaker ok

Tasks (5):
  - File bug ticket for ten-customer crash with repro steps → lead_programmer gitea_issue
  - Send milestone report to Starfruit → producer email
  - Draft store page text with Daniel → producer wiki_page
  - Post launch date in team channel once final build date is confirmed → producer mattermost_post
  - Email a cozy/cooking streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (6):
  - Can the tutorial skip go in before the playtest on Friday? → lead_programmer
  - Is the timer the reason Level 5 feels unfair? → game_designer
  - Where in Level 5 do players quit — the first rush, the second stall, or the end? → game_designer
  - When does Starfruit need the final build? → producer
  - Can we still get the two demo tablets? → marketing_lead
  - Will the booth build be the release build? → producer
Quiet roles: marketing_lead

PASS
```

## Run 3: FAIL (exit 1)

```text
kaki notetaker: dropped question "Do we know exactly where in level 5 players quit — is it the first rush, the second stall, or the end?"; it repeats one that is already open
kaki notetaker: closed question "Is it the timer?" as answered

30 passes in 158.7 s, notetaker ok

Tasks (5):
  - File bug ticket for the ten-customer crash with repro steps → lead_programmer gitea_issue
  - Send milestone report to Starfruit → producer email
  - Draft store page text with Daniel for publisher review → producer wiki_page
  - Post launch date in team channel once final build date is confirmed → producer mattermost_post
  - Email a cozy/cooking streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (4):
  - Can the tutorial skip go in before the playtest on Friday? → lead_programmer
  - When does Starfruit need the final build? → producer
  - Can we still get the two demo tablets? → marketing_lead
  - Will the booth build be the release build? → producer
Quiet roles: marketing_lead

FAIL
  - missing question: where players quit
```

