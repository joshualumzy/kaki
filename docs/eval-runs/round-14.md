# Notetaker eval, round 14

- branch: `feature/scripted-replay`, commit: `60f8167`, 2026-11-04T07:18Z
- model: `llama3.1:8b`
- prompt file last changed in: `18062dd feat(notetaker): tell the notetaker the scenario's situation and vocabulary`
- result: 1 of 3 runs passed
- uncommitted prompt changes: 0 file(s)

## Run 1: FAIL (exit 1)

```text

30 passes in 184.9 s, notetaker ok

Tasks (6):
  - File bug ticket for ten-customer crash with repro steps → lead_programmer gitea_issue
  - Take store screenshots from release candidate two → marketing_lead (manual)
  - Send Starfruit the milestone report → producer email
  - Draft store page text with Daniel → producer wiki_page
  - Post launch date in team channel → producer mattermost_post
  - Email a cozy/cooking streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (6):
  - Are the store screenshots ready? → marketing_lead
  - Is the customer patience timer the reason level 5 feels unfair? → game_designer
  - Where in level 5 do players quit — the first rush, the second stall, or the end? → game_designer
  - When does Starfruit need the final build? → producer
  - Can we still get the two demo tablets for the booth so visitors can play the satay level? → marketing_lead
  - Will the booth build be the release build? → producer
Quiet roles: marketing_lead

FAIL
  - unexpected task: Take store screenshots from release candidate two
```

## Run 2: PASS

```text
kaki notetaker: closed question "Is it the timer?" as answered

30 passes in 205.1 s, notetaker ok

Tasks (5):
  - File bug ticket for ten-customer crash with repro steps → lead_programmer gitea_issue
  - Send milestone report to Starfruit → producer email
  - Draft store page text with Daniel → producer (manual)
  - Post launch date in team channel once final build date is confirmed → producer mattermost_post
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (5):
  - Are the store screenshots ready? → marketing_lead
  - Do we know exactly where in level 5 players quit — the first rush, the second stall, or the end? → game_designer
  - When does Starfruit need the final build? → producer
  - Can we still get the two demo tablets for the booth? → marketing_lead
  - Will the booth build be the release build? → producer
Quiet roles: marketing_lead

PASS
```

## Run 3: FAIL (exit 1)

```text

30 passes in 200.5 s, notetaker ok

Tasks (6):
  - File bug ticket for ten-customer crash with repro steps → lead_programmer gitea_issue
  - Take store screenshots from release candidate two → marketing_lead (manual)
  - Send Starfruit the milestone report → producer email
  - Draft store page text with Daniel → producer (manual)
  - Post launch date in team channel → producer mattermost_post
  - Email a cozy/cooking streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (6):
  - Are the store screenshots ready? → marketing_lead
  - Is the level 5 difficulty caused by the customer patience timer? → game_designer
  - Where exactly in level 5 do players quit — the first rush, the second stall, or the end? → game_designer
  - When does Starfruit need the final build? → producer
  - Can we still get the two demo tablets for the booth? → marketing_lead
  - Will the booth build be the release build? → producer
Quiet roles: marketing_lead

FAIL
  - unexpected task: Take store screenshots from release candidate two
```

