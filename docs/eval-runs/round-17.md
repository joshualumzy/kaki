# Notetaker eval, round 17

- branch: `feature/scripted-replay`, commit: `16cd853`, 2026-11-04T08:42Z
- model: `x-test-2`
- prompt file last changed in: `16cd853 fix(notetaker): ignore question function words when spotting a repeated question`
- result: 2 of 3 runs passed
- uncommitted prompt changes: 0 file(s)

## Run 1: PASS

```text

30 passes in 205.2 s, notetaker ok

Tasks (5):
  - File bug ticket for ten-customer crash in satay stall level → lead_programmer gitea_issue
  - Send Starfruit the milestone report → producer email
  - Draft store page text with Daniel → producer (manual)
  - Post the launch date in the team channel → producer mattermost_post
  - Email a cozy/cooking streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (6):
  - Are the store screenshots ready? → marketing_lead
  - Is the timer the reason Level 5 feels unfair? → game_designer
  - Where in Level 5 do players quit — the first rush, the second stall, or the end? → game_designer
  - When does Starfruit need the final build? → producer
  - Can we still get the two demo tablets for the booth? → marketing_lead
  - Will the booth build be the release build? → producer
Quiet roles: marketing_lead

PASS
```

## Run 2: PASS

```text

30 passes in 286.8 s, notetaker ok

Tasks (5):
  - File bug ticket for ten-customer crash with repro steps → lead_programmer gitea_issue
  - Send milestone report to publisher Starfruit → producer email
  - Draft store page text with Daniel for publisher review → producer (manual)
  - Post launch date in team channel once final build date is confirmed → producer mattermost_post
  - Email a cozy/cooking streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (6):
  - Are the store screenshots ready for the build? → lead_programmer
  - Is it the timer? → game_designer
  - Do we know exactly where in level 5 players quit — the first rush, the second stall, or the end? → game_designer
  - When does Starfruit need the final build? → producer
  - Can we still get the two demo tablets for the booth? → marketing_lead
  - Will the booth build be the release build? → producer
Quiet roles: marketing_lead

PASS
```

## Run 3: FAIL (exit 1)

```text
kaki notetaker: keeping the last good record; LLM request failed: timed out after 60000 ms
  pass 29 failed: LLM request failed: timed out after 60000 ms

30 passes in 339.5 s, notetaker ok

Tasks (6):
  - File bug ticket for the ten-customer crash in the satay stall level → lead_programmer gitea_issue
  - Take store screenshots from release candidate two → marketing_lead (manual)
  - Send Starfruit the milestone report → producer email
  - Draft the store page text with Daniel for Starfruit's review → producer (manual)
  - Post the launch date in the team channel once the final build date is confirmed → producer mattermost_post
  - Email a cozy/cooking streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (6):
  - Are the store screenshots ready for the build? → marketing_lead
  - Is the customer patience timer the reason Level 5 feels unfair? → game_designer
  - Where in Level 5 do players quit — the first rush, the second stall, or the end? → game_designer
  - When does Starfruit need the final build? → producer
  - Can the team still get the two demo tablets for the booth? → marketing_lead
  - Will the booth build be the release build? → producer
Quiet roles: marketing_lead

FAIL
  - unexpected task: Take store screenshots from release candidate two
```

