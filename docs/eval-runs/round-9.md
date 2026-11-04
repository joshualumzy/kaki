# Notetaker eval, round 9

- branch: `feature/scripted-replay`, commit: `f595bdc`, 2026-11-04T06:12Z
- model: `llama3.1:8b`
- prompt file last changed in: `f595bdc tune(notetaker): volunteering to do product work, or raising then parking it, is not a task`
- result: 0 of 3 runs passed
- uncommitted prompt changes: 0 file(s)

## Run 1: FAIL (exit 1)

```text
kaki notetaker: closed question "What is the current state of the build?" as answered
kaki notetaker: closed question "Is there a known cause for the game crashing when serving ten customers in a row without a break?" as answered
kaki notetaker: dropped task "Implement the one-line change for the tutorial skip"; its evidence is not in the transcript
kaki notetaker: dropped question "When is the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped task "Store screenshots"; its evidence is not in the transcript
kaki notetaker: dropped question "When is the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "When is the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "When is the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "When is the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Is it the first rush, or the second stall, or the end of level 5 that players quit?"; it repeats one that is already open
kaki notetaker: kept question q-3 open; its answer is not in the transcript
kaki notetaker: dropped question "Is the pop-up that helps players through level 5 ready for Friday's playtest?"; it repeats one that is already open
kaki notetaker: dropped question "What is the current state of the patience timer in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "When is the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Where exactly do players quit in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "What is the current state of the patience timer in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: closed question "When is the playtest on Friday?" as answered
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: kept question q-7 open; its answer is not in the transcript
kaki notetaker: dropped question "What are the current stall upgrade prices in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "When is the final build?"; it repeats one that is already open
kaki notetaker: kept question q-7 open; its answer is not in the transcript
kaki notetaker: closed question "When is the final build?" as answered
kaki notetaker: kept question q-6 open; its answer is not in the transcript
kaki notetaker: closed question "Where exactly do players quit in level 5?" as answered
kaki notetaker: closed question "What is the current state of the patience timer in level 5?" as answered
kaki notetaker: closed question "What are the current stall upgrade prices in level 5?" as answered
kaki notetaker: dropped task "File a ticket for the booth build"; its evidence is not in the transcript

30 passes in 79.9 s, notetaker ok

Tasks (8):
  - File a ticket for the crash issue → lead_programmer gitea_issue
  - Update screenshots with new UI → lead_programmer gitea_issue
  - Add analytics events per wave → lead_programmer gitea_issue
  - Update patience timer and add pop-up in level 5 → game_designer gitea_issue
  - Adjust stall upgrade prices in level 5 → game_designer gitea_issue
  - Post launch date in team channel → marketing_lead mattermost_post
  - Email a streamer about playing Hawker Heroes on launch day → marketing_lead email
  - File a ticket for booth activities → producer gitea_issue
Open questions (0):
Quiet roles: marketing_lead

FAIL
  - missing task: launch-date post
  - unexpected task: Update screenshots with new UI
  - unexpected task: Add analytics events per wave
  - unexpected task: Update patience timer and add pop-up in level 5
  - unexpected task: Adjust stall upgrade prices in level 5
  - unexpected task: Post launch date in team channel
  - unexpected task: File a ticket for booth activities
  - missing question: where players quit
  - missing question: final-build date
```

## Run 2: FAIL (exit 1)

```text
kaki notetaker: dropped question "What are the repro steps for the game crashing when serving ten customers in a row without a break?"; it repeats one that is already open
kaki notetaker: kept question q-1 open; its answer is not in the transcript
kaki notetaker: kept question q-1 open; its answer is not in the transcript
kaki notetaker: dropped question "What is the current state of the build?"; it repeats one that is already open
kaki notetaker: dropped question "Is there a known cause for the game crashing when serving ten customers in a row without a break?"; it repeats one that is already open
kaki notetaker: kept question q-1 open; its answer is not in the transcript
kaki notetaker: closed question "What caused the drop-off in playtesters at level 5?" as answered
kaki notetaker: dropped question "What is the current state of the build?"; it repeats one that is already open
kaki notetaker: dropped question "Is there a known cause for the game crashing when serving ten customers in a row without a break?"; it repeats one that is already open
kaki notetaker: kept question q-2 open; its answer is not in the transcript
kaki notetaker: kept question q-2 open; its answer is not in the transcript
kaki notetaker: dropped question "What is the current state of the build?"; it repeats one that is already open
kaki notetaker: dropped question "Is there a known cause for the game crashing when serving ten customers in a row without a break?"; it repeats one that is already open
kaki notetaker: dropped question "What is the breakdown of player quit points in level 5?"; it repeats one that is already open
kaki notetaker: dropped task "Change patience timer config value to normal"; its evidence is not in the transcript
kaki notetaker: kept question q-3 open; its answer is not in the transcript
kaki notetaker: dropped question "What is the breakdown of player quit points in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "What is the breakdown of player quit points in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "What is the current state of the build?"; it repeats one that is already open
kaki notetaker: dropped question "Is there a known cause for the game crashing when serving ten customers in a row without a break?"; it repeats one that is already open
kaki notetaker: dropped question "What is the current state of the build?"; it repeats one that is already open
kaki notetaker: dropped question "Is there a known cause for the game crashing when serving ten customers in a row without a break?"; it repeats one that is already open
kaki notetaker: dropped question "What is the breakdown of player quit points in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "What is the current state of the build?"; it repeats one that is already open
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: dropped question "What is the current state of the build?"; it repeats one that is already open
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: dropped task "Confirm the final build date with Starfruit"; its evidence is not in the transcript
kaki notetaker: dropped question "What is the breakdown of player quit points in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: kept question q-1 open; its answer is not in the transcript
kaki notetaker: dropped question "Who is the target streamer for the live stream?"; it repeats one that is already open
kaki notetaker: dropped question "What is the breakdown of player quit points in level 5?"; it repeats one that is already open
kaki notetaker: dropped question "How much will it cost to set up the demo?"; it repeats one that is already open
kaki notetaker: kept question q-5 open; its answer is not in the transcript
kaki notetaker: dropped question "What is the current state of the build?"; it repeats one that is already open
kaki notetaker: dropped question "Is there a known cause for the game crashing when serving ten customers in a row without a break?"; it repeats one that is already open
kaki notetaker: dropped question "What is the current state of the build?"; it repeats one that is already open
kaki notetaker: dropped question "Who is the target streamer for the live stream?"; it repeats one that is already open

30 passes in 92.7 s, notetaker ok

Tasks (11):
  - File a ticket for the crash issue → lead_programmer gitea_issue
  - Confirm the cause of the game crashing when serving ten customers in a row without a break → lead_programmer gitea_issue
  - Patience timer back to normal, plus pop-up ready for Friday's playtest → game_designer wiki_page
  - Update pop-up with new tutorial step → lead_programmer gitea_issue
  - Update stall upgrade prices in level 5 → game_designer gitea_issue
  - Send milestone report to Starfruit → producer email
  - Post launch date in team channel → marketing_lead mattermost_post
  - Confirm demo tablet setup for Hawker Heroes launch readiness → game_designer mattermost_post
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
  - Confirm budget for stickers and tablets → producer wiki_page
  - Confirm final build for demo → lead_programmer gitea_issue
Open questions (6):
  - What is the current state of the build? → lead_programmer
  - Is there a known cause for the game crashing when serving ten customers in a row without a break? → lead_programmer
  - What is the breakdown of player quit points in level 5? → game_designer
  - When does Starfruit need the final build? → producer
  - How much will it cost to set up the demo? → marketing_lead
  - Who is the target streamer for the live stream? → marketing_lead
Quiet roles: marketing_lead

FAIL
  - duplicate task: crash bug (3×)
  - missing task: launch-date post
  - unexpected task: Patience timer back to normal, plus pop-up ready for Friday's playtest
  - unexpected task: Update pop-up with new tutorial step
  - unexpected task: Update stall upgrade prices in level 5
  - unexpected task: Post launch date in team channel
  - unexpected task: Confirm demo tablet setup for Hawker Heroes launch readiness
  - unexpected task: Confirm budget for stickers and tablets
```

## Run 3: FAIL (exit 1)

```text
kaki notetaker: closed question "What is the current state of the build?" as answered
kaki notetaker: closed question "Is there a known cause for the game crashing when serving ten customers in a row without a break?" as answered
kaki notetaker: kept question q-3 open; its answer is not in the transcript
kaki notetaker: dropped question "Do the screenshots need the new UI?"; it repeats one that is already open
kaki notetaker: dropped question "Can the tutorial skip go in before the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Do the screenshots need the new UI?"; it repeats one that is already open
kaki notetaker: dropped question "Is it the first rush, or the second stall, or the end?"; it repeats one that is already open
kaki notetaker: dropped question "Can the tutorial skip go in before the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Do the screenshots need the new UI?"; it repeats one that is already open
kaki notetaker: dropped question "Is it the timer?"; it repeats one that is already open
kaki notetaker: dropped question "Do we know exactly where in level 5 players quit?"; it repeats one that is already open
kaki notetaker: dropped question "Is the timer a config value?"; it repeats one that is already open
kaki notetaker: dropped question "Is it the timer?"; it repeats one that is already open
kaki notetaker: kept question q-3 open; its answer is not in the transcript
kaki notetaker: dropped question "Do we know exactly where in level 5 players quit?"; it repeats one that is already open
kaki notetaker: dropped question "Is the timer the issue?"; it repeats one that is already open
kaki notetaker: dropped question "Is the tutorial skip ready for the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: dropped question "Is it the timer?"; it repeats one that is already open
kaki notetaker: dropped question "Can the tutorial skip go in before the playtest on Friday?"; it repeats one that is already open
kaki notetaker: dropped question "Do we know exactly where in level 5 players quit?"; it repeats one that is already open
kaki notetaker: dropped question "Can we still get the two demo tablets?"; it repeats one that is already open
kaki notetaker: dropped question "When does Starfruit need the final build?"; it repeats one that is already open
kaki notetaker: kept question q-11 open; its answer is not in the transcript
kaki notetaker: dropped question "Can we still get the two demo tablets?"; it repeats one that is already open
kaki notetaker: dropped question "Should visitors play the satay level or watch a trailer?"; it repeats one that is already open
kaki notetaker: kept question q-8 open; its answer is not in the transcript

30 passes in 77.5 s, notetaker ok

Tasks (6):
  - File a ticket for the crash issue → lead_programmer gitea_issue
  - File a ticket for the tutorial skip → lead_programmer gitea_issue
  - Update playtest materials → lead_programmer wiki_page
  - Adjust stall upgrade prices → game_designer gitea_issue
  - Update launch marketing and booth budget notes → producer wiki_page
  - Email a streamer to play Hawker Heroes on launch day → marketing_lead email
Open questions (10):
  - Can the tutorial skip go in before the playtest on Friday? → lead_programmer
  - Do the screenshots need the new UI? → marketing_lead
  - Is it the timer? → lead_programmer
  - Do we know exactly where in level 5 players quit? → game_designer
  - Do the stall upgrade prices need to be adjusted? → game_designer
  - When does Starfruit need the final build? → producer
  - Can we still get the two demo tablets? → studio_manager
  - Should visitors play the satay level or watch a trailer? → game_designer
  - Who is the streamer that will play Hawker Heroes on launch day? → marketing_lead
  - Will the booth build be the release build? → lead_programmer
Quiet roles: marketing_lead

FAIL
  - unexpected task: File a ticket for the tutorial skip
  - unexpected task: Update playtest materials
  - unexpected task: Adjust stall upgrade prices
```

