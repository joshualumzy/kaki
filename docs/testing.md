# How we tested Kaki

We tested at three levels: fast automated tests on every change, robot visitors in real Chrome windows before every
deploy, and sessions with real people.

## 1. Automated tests

- `npm test` runs the Vitest suite for `shared/`, `server/`, `web/` and `scripts/`. Each module has unit tests, and
  the server has integration tests that drive the HTTP and WebSocket API.
- `npm run typecheck` checks the whole TypeScript workspace.

## 2. Robot playtests in the browser

These drive the real app in installed Google Chrome through Playwright, against the local stack or the cloud VM
(`KAKI_PLAYTEST_URL=...`). Each run writes a pass/fail report to `.live-logs/`.

| Command | What it checks |
| --- | --- |
| `npm run playtest:team` | A three-person team meeting (owner plus two teammates, each in their own window): lobby and meeting code, private Wingman cards reaching only the right person, follow-up approval, minutes approved by the owner and published to the wiki, and the room released afterwards. |
| `npm run playtest:team -- --voice` | The same meeting spoken aloud: generated speech goes through a fake microphone, so speech recognition, transcript and minutes are tested end to end. |
| `npm run playtest:live` | One visitor in the practice meeting with the AI colleagues, from joining to the end of the agenda. |
| `npm run playtest:ai` | A language model plays the visitor in one of nine styles (hesitant, terse, off-topic, interrupter, silent and others), then a second model judges the meeting for natural talk, contradictions and made-up facts. |
| `npm run playtest:dialogue` | The conversation engine on its own, without a browser, across every agenda item. |
| `npm run eval:notetaker` | Runs a recorded meeting through the notetaker and compares the decisions, tasks and open questions it finds with the expected list. |

## 3. Real people

Friends and classmates played the practice meeting on their own devices, by voice and by typing. We watched each
session, noted where people got stuck or where an AI colleague said something odd, and turned those notes into
GitHub issues (for example #55 and #62). The robot playtests above were then extended so the same problem would be
caught automatically next time.
