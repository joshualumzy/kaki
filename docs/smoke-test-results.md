# Smoke test results

- Date and time: 2026-11-02 16:10
- Commit tested (`git rev-parse --short HEAD`): b98942a
- Part run: both
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
| 1 | "Hi everyone, let's start." | Sam | Yes | 2.5 s | |
| 2 | "Arjun, the build crashes after ten customers in a row. Can you file a bug for it?" | Arjun | No | 2.7 s | Speech recognition misheard it as "belt crashes off to 10 customers... pile the buff", so Arjun answered about "belt size". |
| 3 | "What is the final build date?" | Sam | Yes | 1.3 s | Sam answered "next Thursday". |
| 4 | "Mei, why are players quitting on level 5?" | Mei | Yes | 1.2 s | Mei correctly mentioned 14 out of 20 quit. Speech recognition heard "May Why are players quitting on level?". |
| 5 | "Please post the launch date in Mattermost." | (None) | (None) | (None) | User mic didn't pick this up / not in logs. |
| 6 | Say nothing for 20 seconds. | (None) | (None) | (None) | No nudges seen in output. |
| 7 | (Typed) "What did Starfruit say about the build date?" | Arjun | Yes | 1.4 s | Arjun said "final build by Thursday". |
| 8 | Press Stop while an NPC is speaking. | (Interruption) | N/A | N/A | Successfully interrupted. |

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
