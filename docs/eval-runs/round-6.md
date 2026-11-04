# Notetaker eval, round 6

- branch: `feature/scripted-replay`, commit: `e46a450`, 2026-11-04T05:53Z
- prompt file last changed in: `e46a450 tune(notetaker): keep a question open when its only answer is missing or doubted`
- result: 0 of 3 runs passed
- uncommitted prompt changes: 0 file(s)

## Run 1: FAIL (exit 1)

```text
kaki notetaker: dropped question "What is the current status of the crash issue?"; it repeats one that is already open
kaki notetaker: closed question "What is the current status of the crash issue?" as answered
kaki notetaker: closed question "When is the launch build?" as answered
kaki notetaker: dropped question "Is the new UI needed for the screenshots?"; it repeats one that is already open
kaki notetaker: closed question "What caused the drop-off in level 5?" as answered
kaki notetaker: closed question "Do people think it's too hard or just unfair?" as answered
kaki notetaker: dropped question "When is the launch build?"; it repeats one that is already open
kaki notetaker: dropped question "Do the screenshots need the new UI?"; it repeats one that is already open
kaki notetaker: closed question "When is the launch build?" as answered
kaki notetaker: closed question "When is the launch build?" as answered
kaki notetaker: dropped question "Do the screenshots need the new UI?"; it repeats one that is already open
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: dropped question "Do we know exactly where in level 5 players quit?"; it repeats one that is already open
kaki notetaker: dropped question "When is the launch build?"; it repeats one that is already open
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: closed question "When is the launch build?" as answered
kaki notetaker: closed question "Do the screenshots need the new UI?" as answered
kaki notetaker: closed question "Do people think it's too hard or just unfair?" as answered
kaki notetaker: dropped question "When is the launch build?"; it repeats one that is already open
kaki notetaker: closed question "Do we know exactly where in level 5 players quit?" as answered
kaki notetaker: closed question "Is the patience timer a config value?" as answered
kaki notetaker: dropped question "When is the launch build?"; it repeats one that is already open
kaki notetaker: dropped question "What are the stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: closed question "When is the launch build?" as answered
kaki notetaker: dropped question "What are the stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: closed question "When is the launch build?" as answered
kaki notetaker: closed question "What are the stall upgrade prices in level 5?" as answered
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: closed question "When is the final build?" as answered
kaki notetaker: closed question "Who is the target streamer for the live stream?" as answered
kaki notetaker: dropped task "Email a target streamer for the live stream"; its evidence is not in the transcript
kaki notetaker: dropped question "How much will it cost to rent the booth?"; it repeats one that is already open
kaki notetaker: dropped task "File a budget ticket for booth rental"; its evidence is not in the transcript
kaki notetaker: dropped question "How much will it cost to rent the booth?"; it repeats one that is already open
kaki notetaker: closed question "How much will it cost to rent the booth?" as answered

30 passes in 90.3 s, notetaker ok

Tasks (8):
  - File a bug ticket for the ten-customer crash → lead_programmer gitea_issue
  - Confirm order queue issue cause → lead_programmer gitea_issue
  - Skip tutorial in launch build → lead_programmer gitea_issue
  - Patience timer back to normal, plus pop-up → game_designer wiki_page
  - Draft store page text → producer wiki_page
  - Post launch date in team channel → marketing_lead mattermost_post
  - Confirm final build date → producer calendar_event
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (2×)
  - missing task: launch-date post
  - unexpected task: Skip tutorial in launch build
  - unexpected task: Patience timer back to normal, plus pop-up
  - unexpected task: Post launch date in team channel
  - unexpected task: Confirm final build date
  - missing question: where players quit
  - missing question: final-build date
```

## Run 2: FAIL (exit 1)

```text
kaki notetaker: dropped question "What is the current status of the crash issue?"; it repeats one that is already open
kaki notetaker: closed question "What is the current status of the crash issue?" as answered
kaki notetaker: closed question "When is the launch build?" as answered
kaki notetaker: closed question "When is the launch build?" as answered
kaki notetaker: dropped question "Do the screenshots need the new UI?"; it repeats one that is already open
kaki notetaker: closed question "Do the screenshots need the new UI?" as answered
kaki notetaker: dropped question "What causes the drop-off at level 5?"; it repeats one that is already open
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: dropped question "where in level 5 players quit"; it is not phrased as a question
kaki notetaker: dropped question "what causes the drop-off at level 5"; it is not phrased as a question
kaki notetaker: dropped question "What causes the drop-off at level 5?"; it repeats one that is already open
kaki notetaker: dropped question "Do the screenshots need the new UI?"; it repeats one that is already open
kaki notetaker: closed question "Do the screenshots need the new UI?" as answered
kaki notetaker: dropped question "What causes the drop-off at level 5?"; it repeats one that is already open
kaki notetaker: closed question "Do the screenshots need the new UI?" as answered
kaki notetaker: dropped question "What causes the drop-off at level 5?"; it repeats one that is already open
kaki notetaker: closed question "How long does it take to implement a new tutorial step?" as answered
kaki notetaker: dropped task "Confirm tutorial step implementation time"; its evidence is not in the transcript
kaki notetaker: closed question "Do the screenshots need the new UI?" as answered
kaki notetaker: closed question "What are the stall upgrade prices in level 5?" as answered
kaki notetaker: closed question "When does Starfruit need the final build?" as answered
kaki notetaker: dropped question "What causes the drop-off at level 5?"; it repeats one that is already open
kaki notetaker: closed question "When does Starfruit need the final build?" as answered
kaki notetaker: dropped task "Draft store page text for Starfruit"; its evidence is not in the transcript
kaki notetaker: closed question "What causes the drop-off at level 5?" as answered
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: closed question "Can we still get the two demo tablets?" as answered
kaki notetaker: dropped question "Someone who does cozy and cooking games"; it is not phrased as a question
kaki notetaker: closed question "Can we still get the two demo tablets?" as answered
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: dropped task "Confirm release build for booth demo"; its evidence is not in the transcript
kaki notetaker: closed question "When is the final build?" as answered

30 passes in 84.9 s, notetaker ok

Tasks (7):
  - File a bug ticket for the ten-customer crash → lead_programmer gitea_issue
  - Confirm order queue issue cause → lead_programmer gitea_issue
  - Skip tutorial in launch build → lead_programmer gitea_issue
  - Milestone report for Starfruit → producer email
  - Post launch date in team channel → marketing_lead mattermost_post
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
  - Confirm budget for launch day stickers → marketing_lead wiki_page
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (3×)
  - missing task: launch-date post
  - unexpected task: Post launch date in team channel
  - unexpected task: Confirm budget for launch day stickers
  - missing question: where players quit
  - missing question: final-build date
```

## Run 3: FAIL (exit 1)

```text
kaki notetaker: dropped question "What is the current status of the crash issue?"; it repeats one that is already open
kaki notetaker: closed question "What is the current status of the crash issue?" as answered
kaki notetaker: closed question "When is the playtest on Friday?" as answered
kaki notetaker: closed question "When will we see real numbers from the testers?" as answered
kaki notetaker: closed question "When will we see real numbers from the testers?" as answered
kaki notetaker: closed question "When will we see real numbers from the testers?" as answered
kaki notetaker: dropped question "Is it the timer?"; it repeats one that is already open
kaki notetaker: dropped question "where in level 5 players quit"; it is not phrased as a question
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: dropped question "What are the stall upgrade prices in level 5"; it is not phrased as a question
kaki notetaker: closed question "When does Starfruit need the final build?" as answered
kaki notetaker: dropped question "What are the stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: closed question "What are the stall upgrade prices in level 5?" as answered
kaki notetaker: dropped task "Draft store page text"; its evidence is not in the transcript
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: closed question "When does Starfruit need the final build?" as answered
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: closed question "Who is the target streamer?" as answered
kaki notetaker: closed question "When does Starfruit need the final build?" as answered
kaki notetaker: closed question "Will the booth build be the release build?" as answered

30 passes in 76.4 s, notetaker ok

Tasks (6):
  - File a bug ticket for the ten-customer crash → lead_programmer gitea_issue
  - Confirm order queue issue cause → lead_programmer gitea_issue
  - Confirm tutorial skip change → lead_programmer gitea_issue
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
  - Confirm Hawker Uncle stickers → marketing_lead wiki_page
  - Confirm booth build is release build → lead_programmer wiki_page
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (4×)
  - missing task: launch-date post
  - unexpected task: Confirm Hawker Uncle stickers
  - missing question: where players quit
  - missing question: final-build date
```

