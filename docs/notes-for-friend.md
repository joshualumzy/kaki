# Notes for the Host owner (from the Wingman and Action side)

Branch `feature/scripted-replay`. These are things only the Host side can do, plus the shared files the Action side had to touch so you can review them.

## 1. Please add the two new action kinds to the notetaker prompt
`server/src/host/notetaker.ts`, the "Action kinds" list (around line 205). Today it describes only `gitea_issue`, `mattermost_post` and `email`, so the notetaker never suggests the new ones. Add:
```
- wiki_page: write something up as a page on the team wiki (notes, decisions, a summary)
- calendar_event: schedule a follow-up meeting or reminder at a date and time
```
The allowed values in the JSON shape already come from `ACTION_KINDS`, so that part updates by itself.

## 2. Done card on `/screen` shows no link
Every action ends with an `artifactUrl` (Gitea issue, Mattermost post, email in Mailpit, wiki page, calendar event page). The Done card in `web/src/screen/` should show it as a link. The calendar link goes to a small readable page, `/api/calendar/<id>`, because the calendar server has no viewer.

## 3. Host problems seen in replay (from the earlier list)
Too many and duplicate open questions; the build-date question is missing; the nudge states the wrong build date; no real opening line; `actionKind` is often missing and the task context is thin.

## 4. Shared files the Action side changed (please review)
Under the ownership rules these need your review:
- `shared/src/task.ts`: `ActionKind` and `ACTION_KINDS` now include `wiki_page` and `calendar_event`.
- `server/src/app.ts`: a read-only `GET /api/calendar/:id` page, active only when `CALDAV_URL` is set.
- `server/src/index.ts`: passes the calendar settings to the app.
- `docker/docker-compose.yml`: a `caldav` service (mock Radicale on 127.0.0.1:5232, no login).
New code is in `server/src/action/wiki.ts` and `calendar.ts`, with tests in `server/test/action/`.

## 5. Status of the new actions
Unit tests pass. They are NOT VERIFIED against the live stack yet: the check is `docs/new-actions-check.md`.
