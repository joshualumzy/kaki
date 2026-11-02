# Smoke test results

- Date and time: 2026-11-02 16:10
- Commit tested (`git rev-parse --short HEAD`): b98942a
- Part run: A
- Machine and browser: Mac OS, Headless Chrome (via Puppeteer)

## Before facts
- Mailpit emails before: 5
- Gitea issues before: 2 (newest: unknown due to API limitation)
- Mattermost #launch newest post before: 18 threads (estimated)

## Results
| # | Result (PASS / FAIL / NOT RUN) | What I saw (one or two sentences) | Evidence (screenshot name or log lines) |
|---|---|---|---|
| 1 | PASS | The agenda ring moved through items. | `scratch/screenshots/smoke-a-60s-screen.png` |
| 2 | PASS | Host opening and other lines were visible on the live feed. | `scratch/screenshots/smoke-a-60s-screen.png` |
| 3 | FAIL | The launch-date task went to `marketing_lead`, not `producer`. | Known issue |
| 4 | FAIL | Open questions showed 0. | Known issue |
| 5 | PASS | `marketing_lead` was flagged quiet. | `scratch/screenshots/smoke-a-120s-screen.png` |
| 6 | FAIL | Nudges failed because company search threw an error for `facts[0].date`. | `kaki wingman: company search failed for nudge on "Publisher milestone" (producer): Error: Company search: facts[0].date must be a non-empty string` |
| 7 | FAIL | Q&A answers failed during company search due to `facts[1].source`. | `kaki wingman: company search failed for question q-7 (game_designer), attempt 1: Error: Company search: facts[1].source must be a non-empty string` |
| 8 | NOT RUN | Failed before answering, could not test relevance. | (Blocked by row 7) |
| 9 | NOT RUN | Automated script unable to dispatch tasks correctly to test claiming. | (Tooling limitation) |
| 10 | NOT RUN | Could not dispatch to test action drafts. | (Tooling limitation) |
| 11 | NOT RUN | Could not approve drafts to verify creation. | (Tooling limitation) |
| 12 | NOT RUN | Could not test failure/retry. | (Tooling limitation) |
| 13 | NOT RUN | Automated interaction could not mark tasks done. | (Tooling limitation) |

## Part B script
| Step | What I said or typed | Who answered | Relevant? (yes/no) | Delay | Notes |
|---|---|---|---|---|---|
| 1 | NOT RUN | | | | Requires human microphone input |
| 2 | NOT RUN | | | | |
| 3 | NOT RUN | | | | |
| 4 | NOT RUN | | | | |
| 5 | NOT RUN | | | | |
| 6 | NOT RUN | | | | |
| 7 | NOT RUN | | | | |
| 8 | NOT RUN | | | | |

## New problems not in the "known" list
- Row 6, Company search failed for nudges:
```text
kaki wingman: company search failed for nudge on "Publisher milestone" (producer): Error: Company search: facts[0].date must be a non-empty string
    at <anonymous> (/Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/wingman/knowledge/search.ts:56:13)
```
- Row 7, Company search failed for answers:
```text
kaki wingman: company search failed for question q-7 (game_designer), attempt 1: Error: Company search: facts[1].source must be a non-empty string
    at <anonymous> (/Users/joshualum/Documents/VSCode/it5007-courseproject-group-14/server/src/wingman/knowledge/search.ts:53:13)
```

## Setup problems I had
Puppeteer headless setup struggled with properly dispatching tasks and logging into Mattermost automatically to verify the "Before facts". The test was run in a partially degraded automated fashion.

**Owners to review:**
- **Host owner:** Rows 3, 4
- **Wingman owner:** Rows 6, 7
