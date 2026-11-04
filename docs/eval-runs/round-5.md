# Notetaker eval, round 5

- branch: `feature/scripted-replay`, commit: `c69e75c`, 2026-11-04T05:46Z
- prompt file last changed in: `c69e75c tune(notetaker): log when a question is closed as answered or dropped`
- result: 0 of 3 runs passed
- uncommitted prompt changes: 0 file(s)

## Run 1: FAIL (exit 1)

```text
kaki notetaker: dropped question "What's the current status of the crash issue?"; it repeats one that is already open
kaki notetaker: closed question "What's the current status of the crash issue?" as answered
kaki notetaker: closed question "Can the tutorial skip go in before the playtest on Friday?" as answered
kaki notetaker: closed question "Can the tutorial skip go in before the playtest on Friday?" as answered
kaki notetaker: dropped question "Do the screenshots need the new UI?"; it repeats one that is already open
kaki notetaker: closed question "Do the screenshots need the new UI?" as answered
kaki notetaker: dropped question "Is it the timer?"; it repeats one that is already open
kaki notetaker: dropped question "Is it the timer?"; it repeats one that is already open
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: closed question "Is the timer a config value?" as answered
kaki notetaker: closed question "Is the timer a config value?" as answered
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5"; it is not phrased as a question
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: closed question "What are the current stall upgrade prices in level 5?" as answered
kaki notetaker: closed question "When does Starfruit need the final build?" as answered
kaki notetaker: closed question "Do they need the store page text from us too, or do they write it?" as answered
kaki notetaker: dropped question "Do they need the store page text from us too?"; it repeats one that is already open
kaki notetaker: dropped question "Do they need the store page text from us too?"; it repeats one that is already open
kaki notetaker: dropped question "Do they need the store page text from us too?"; it repeats one that is already open
kaki notetaker: dropped question "Someone who does cozy and cooking games"; it is not phrased as a question
kaki notetaker: closed question "Do they need the store page text from us too?" as answered

30 passes in 64.1 s, notetaker ok

Tasks (6):
  - File bug ticket for ten-customer crash → lead_programmer gitea_issue
  - Skip tutorial for launch build → lead_programmer gitea_issue
  - Send milestone report to Starfruit → producer email
  - Post launch date in team channel → marketing_lead mattermost_post
  - Email streamer to play Hawker Heroes on launch day → marketing_lead email
  - File bug ticket for booth build → lead_programmer gitea_issue
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (2×)
  - missing task: launch-date post
  - unexpected task: Skip tutorial for launch build
  - unexpected task: Post launch date in team channel
  - missing question: where players quit
  - missing question: final-build date
```

## Run 2: FAIL (exit 1)

```text
kaki notetaker: dropped question "What's the current status of the crash issue?"; it repeats one that is already open
kaki notetaker: closed question "What's the current status of the crash issue?" as answered
kaki notetaker: closed question "Can the tutorial skip go in before the playtest on Friday?" as answered
kaki notetaker: closed question "Can the tutorial skip go in before the playtest on Friday?" as answered
kaki notetaker: dropped question "Do the screenshots need the new UI?"; it repeats one that is already open
kaki notetaker: closed question "Do the screenshots need the new UI?" as answered
kaki notetaker: dropped question "Is it the timer?"; it repeats one that is already open
kaki notetaker: dropped question "Is it the timer?"; it repeats one that is already open
kaki notetaker: dropped question "Is it the timer?"; it repeats one that is already open
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5"; it is not phrased as a question
kaki notetaker: closed question "What are the current stall upgrade prices in level 5?" as answered
kaki notetaker: dropped question "What is the date in the email that Starfruit mentioned as an alternative?"; it repeats one that is already open
kaki notetaker: closed question "What are the current stall upgrade prices in level 5?" as answered
kaki notetaker: dropped question "What is the date in the email that Starfruit mentioned as an alternative?"; it repeats one that is already open
kaki notetaker: closed question "What is the date in the email that Starfruit mentioned as an alternative?" as answered
kaki notetaker: closed question "What are the current stall upgrade prices in level 5?" as answered
kaki notetaker: closed question "What is the date in the email that Starfruit mentioned as an alternative?" as answered
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "What is the final build date?"; it repeats one that is already open
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "What is the final build date?"; it repeats one that is already open
kaki notetaker: closed question "What are the current stall upgrade prices in level 5?" as answered
kaki notetaker: dropped question "What is the final build date?"; it repeats one that is already open
kaki notetaker: dropped question "What is the final build date?"; it repeats one that is already open
kaki notetaker: closed question "What is the final build date?" as answered
kaki notetaker: closed question "Will the booth build be the release build?" as answered

30 passes in 73.5 s, notetaker ok

Tasks (5):
  - File bug ticket for ten-customer crash → lead_programmer gitea_issue
  - Skip tutorial change → lead_programmer gitea_issue
  - Post launch date in team channel → marketing_lead mattermost_post
  - Email streamer to play Hawker Heroes on launch day → marketing_lead email
  - File bug ticket for booth build → lead_programmer gitea_issue
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (3×)
  - missing task: launch-date post
  - unexpected task: Post launch date in team channel
  - missing question: where players quit
  - missing question: final-build date
```

## Run 3: FAIL (exit 1)

```text
kaki notetaker: dropped question "What's the current status of the crash issue?"; it repeats one that is already open
kaki notetaker: closed question "What's the current status of the crash issue?" as answered
kaki notetaker: closed question "What's the current status of the crash issue?" as answered
kaki notetaker: closed question "What's the current status of the crash issue?" as answered
kaki notetaker: closed question "What's the current status of the crash issue?" as answered
kaki notetaker: dropped question "What's the current status of the crash issue?"; it repeats one that is already open
kaki notetaker: closed question "What's the current status of the crash issue?" as answered
kaki notetaker: closed question "Is it the timer?" as answered
kaki notetaker: closed question "where exactly do players quit in level 5?" as answered
kaki notetaker: closed question "where exactly do players quit in level 5?" as answered
kaki notetaker: closed question "where exactly do players quit in level 5?" as answered
kaki notetaker: closed question "where exactly do players quit in level 5?" as answered
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: closed question "What are the current stall upgrade prices in level 5?" as answered
kaki notetaker: dropped question "What is the date mentioned in the email that Starfruit needs the final build?"; it repeats one that is already open
kaki notetaker: closed question "What is the date mentioned in the email that Starfruit needs the final build?" as answered
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: closed question "What are the current stall upgrade prices in level 5?" as answered
kaki notetaker: dropped question "What is the date mentioned in the email that Starfruit needs the final build?"; it repeats one that is already open
kaki notetaker: closed question "What is the date mentioned in the email that Starfruit needs the final build?" as answered
kaki notetaker: dropped question "What is the final build date?"; it repeats one that is already open
kaki notetaker: closed question "What is the date mentioned in the email that Starfruit needs the final build?" as answered
kaki notetaker: dropped question "What is the final booth budget?"; it repeats one that is already open
kaki notetaker: dropped question "Someone who does cozy and cooking games"; it is not phrased as a question
kaki notetaker: closed question "What is the final booth budget?" as answered
kaki notetaker: dropped question "How much is a tablet?"; it repeats one that is already open

30 passes in 82.6 s, notetaker ok

Tasks (6):
  - File bug ticket for ten-customer crash → lead_programmer gitea_issue
  - Adjust stall upgrade prices for level 5 → game_designer gitea_issue
  - Draft store page text → producer wiki_page
  - Post launch date in team channel → marketing_lead mattermost_post
  - Email Starfruit with final booth budget → marketing_lead email
  - Email streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (1):
  - How much is a tablet? → marketing_lead
Quiet roles: marketing_lead

FAIL
  - missing task: launch-date post
  - unexpected task: Adjust stall upgrade prices for level 5
  - unexpected task: Post launch date in team channel
  - unexpected task: Email Starfruit with final booth budget
  - missing question: where players quit
  - missing question: final-build date
```

