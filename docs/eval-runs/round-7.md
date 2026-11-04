# Notetaker eval, round 7

- branch: `feature/scripted-replay`, commit: `abc4852`, 2026-11-04T06:03Z
- prompt file last changed in: `abc4852 tune(notetaker): closing a question needs a quoted answer; questions must be full sentences`
- result: 0 of 3 runs passed
- uncommitted prompt changes: 0 file(s)

## Run 1: FAIL (exit 1)

```text
kaki notetaker: closed question "What is the current state of the build?" as answered
kaki notetaker: closed question "Is there a known cause for the game crashing when serving ten customers in a row without a break?" as answered
kaki notetaker: dropped question "Can the tutorial skip go in before the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Can the tutorial skip go in before the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Can the tutorial skip go in before the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Can the tutorial skip go in before the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Is the timer the problem?"; it repeats one that is already open
kaki notetaker: closed question "Exactly where in level 5 players quit?" as answered
kaki notetaker: dropped question "Is the timer the problem?"; it repeats one that is already open
kaki notetaker: dropped question "Is the timer the problem?"; it repeats one that is already open
kaki notetaker: dropped question "Is the timer the problem?"; it repeats one that is already open
kaki notetaker: kept question q-3 open; its answer is not in the transcript
kaki notetaker: dropped question "Is the timer the problem?"; it repeats one that is already open
kaki notetaker: closed question "When does Starfruit need the final build?" as answered
kaki notetaker: dropped question "Is the timer the problem?"; it repeats one that is already open
kaki notetaker: dropped question "Can we still get the two demo tablets?"; it repeats one that is already open
kaki notetaker: dropped question "Is there any money left in the booth budget?"; it repeats one that is already open
kaki notetaker: dropped question "Can we still get the two demo tablets?"; it repeats one that is already open
kaki notetaker: kept question q-10 open; its answer is not in the transcript
kaki notetaker: dropped question "Is there any money left in the booth budget?"; it repeats one that is already open
kaki notetaker: dropped question "Can we still get the two demo tablets?"; it repeats one that is already open
kaki notetaker: dropped task "Prepare a list of items to give out at the booth"; its evidence is not in the transcript
kaki notetaker: dropped task "Prepare a booth build with the crash fix"; its evidence is not in the transcript
kaki notetaker: kept question q-11 open; its answer is not in the transcript

30 passes in 85.4 s, notetaker ok

Tasks (6):
  - File a ticket for the crash issue → lead_programmer gitea_issue
  - Patience timer back to normal, plus pop-up ready for Friday's playtest → game_designer wiki_page
  - Adjust stall upgrade prices → game_designer gitea_issue
  - Send milestone report to Starfruit → producer email
  - Prepare final build for Starfruit → lead_programmer gitea_issue
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (8):
  - Can the tutorial skip go in before the playtest on Friday? → lead_programmer
  - Is the timer the problem? → lead_programmer
  - Are the stall upgrade prices too high? → game_designer
  - Is the coin balance too high? → game_designer
  - Is there any money left in the booth budget? → marketing_lead
  - Can we still get the two demo tablets? → game_designer
  - Will the final build have the crash fix? → ?
  - Is the release build ready for demo? → ?
Quiet roles: marketing_lead

FAIL
  - missing task: launch-date post
  - unexpected task: Patience timer back to normal, plus pop-up ready for Friday's playtest
  - unexpected task: Adjust stall upgrade prices
  - unexpected task: Prepare final build for Starfruit
  - missing question: where players quit
```

## Run 2: FAIL (exit 1)

```text
kaki notetaker: closed question "What is the current status of the build?" as answered
kaki notetaker: closed question "Is there a known cause for the game crashing when serving ten customers in a row without a break?" as answered
kaki notetaker: dropped task "Confirm tutorial skip change"; its evidence is not in the transcript
kaki notetaker: dropped question "When is the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "When is the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "When is the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Do the screenshots need the new UI?"; it repeats one that is already open
kaki notetaker: dropped question "When is the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Do the screenshots need the new UI?"; it repeats one that is already open
kaki notetaker: closed question "Do the screenshots need the new UI?" as answered
kaki notetaker: dropped question "Exactly where in level 5 players quit?"; it repeats one that is already open
kaki notetaker: dropped question "Exactly where in level 5 players quit?"; it repeats one that is already open
kaki notetaker: dropped question "Is the timer the problem?"; it repeats one that is already open
kaki notetaker: dropped question "When is the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Exactly where in level 5 players quit?"; it repeats one that is already open
kaki notetaker: dropped question "Is the timer the problem?"; it repeats one that is already open
kaki notetaker: dropped question "Exactly where in level 5 players quit?"; it repeats one that is already open
kaki notetaker: dropped question "What are the stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: dropped question "What are the stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: dropped question "Can we still get the two demo tablets?"; it repeats one that is already open
kaki notetaker: dropped question "Do they need the store page text from us too, or do they write it?"; it repeats one that is already open
kaki notetaker: kept question q-11 open; its answer is not in the transcript
kaki notetaker: dropped question "Are we still getting the two demo tablets?"; it repeats one that is already open
kaki notetaker: dropped question "What is the budget for stickers?"; it repeats one that is already open
kaki notetaker: kept question q-8 open; its answer is not in the transcript

30 passes in 93.0 s, notetaker ok

Tasks (6):
  - File a ticket for the crash issue → lead_programmer gitea_issue
  - Confirm cause of game crash → lead_programmer gitea_issue
  - Adjust stall upgrade prices in level 5 → game_designer gitea_issue
  - Send milestone report to Starfruit → producer email
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
  - Purchase stickers for the booth → marketing_lead gitea_issue
Open questions (9):
  - When is the playtest on Friday? → game_designer
  - Is the timer the problem? → lead_programmer
  - Exactly where in level 5 players quit? → game_designer
  - What are the stall upgrade prices in level 5? → game_designer
  - When is the final build? → lead_programmer
  - Do they need the store page text from us too, or do they write it? → producer
  - Can we still get the two demo tablets? → producer
  - Who is the streamer that will play Hawker Heroes on launch day? → marketing_lead
  - What is the budget for stickers? → marketing_lead
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (2×)
  - missing task: launch-date post
  - unexpected task: Adjust stall upgrade prices in level 5
  - unexpected task: Purchase stickers for the booth
```

## Run 3: FAIL (exit 1)

```text
kaki notetaker: closed question "What is the current state of the build?" as answered
kaki notetaker: closed question "Is there a known cause for the game crashing when serving ten customers in a row without a break?" as answered
kaki notetaker: dropped question "Can the tutorial skip go in before the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Can the tutorial skip go in before the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Can the tutorial skip go in before the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Is the timer the problem?"; it repeats one that is already open
kaki notetaker: closed question "Exactly where in level 5 players quit?" as answered
kaki notetaker: dropped question "Can the tutorial skip go in before the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Is the timer the problem?"; it repeats one that is already open
kaki notetaker: dropped question "Is the timer the problem?"; it repeats one that is already open
kaki notetaker: closed question "Is the timer the problem?" as answered
kaki notetaker: kept question q-3 open; its answer is not in the transcript
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "When will the final build be ready for Starfruit?"; it repeats one that is already open
kaki notetaker: closed question "Can the tutorial skip go in before the playtest on Friday?" as answered
kaki notetaker: dropped question "When will the final build be ready for Starfruit?"; it repeats one that is already open
kaki notetaker: dropped question "When will the final build be ready for Starfruit?"; it repeats one that is already open
kaki notetaker: dropped question "What is the remaining budget for the booth?"; it repeats one that is already open
kaki notetaker: dropped question "What is the remaining budget for the booth?"; it repeats one that is already open
kaki notetaker: dropped question "Who is the streamer that will be playing Hawker Heroes on launch day?"; it repeats one that is already open
kaki notetaker: dropped question "What is the remaining budget for the booth?"; it repeats one that is already open
kaki notetaker: dropped question "Who is the streamer that will be playing Hawker Heroes on launch day?"; it repeats one that is already open
kaki notetaker: dropped question "What is the remaining budget for the booth?"; it repeats one that is already open
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "Who is the streamer that will be playing Hawker Heroes on launch day?"; it repeats one that is already open

30 passes in 84.9 s, notetaker ok

Tasks (4):
  - File a ticket for the crash issue → lead_programmer gitea_issue
  - Timer fix and pop-up ready for Friday's playtest → game_designer gitea_issue
  - Adjust stall upgrade prices for level 5 → game_designer gitea_issue
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (4):
  - What are the current stall upgrade prices in level 5? → game_designer
  - When will the final build be ready for Starfruit? → lead_programmer
  - What is the remaining budget for the booth? → marketing_lead
  - Who is the streamer that will be playing Hawker Heroes on launch day? → marketing_lead
Quiet roles: marketing_lead

FAIL
  - missing task: launch-date post
  - unexpected task: Timer fix and pop-up ready for Friday's playtest
  - unexpected task: Adjust stall upgrade prices for level 5
```

