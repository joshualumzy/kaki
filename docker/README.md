# Kaki demo stack

A local, self-hosted stack with Pixel Kampung's messy company data. Everything is
fictional and every credential is a dev-only dummy.

## Start, seed, verify

```bash
npm run stack:up      # docker compose -f docker/docker-compose.yml up -d
npm run seed          # waits for health, then fills every service
npm run seed:verify   # checks the API access and the planted contradictions
```

The first `stack:up` pulls the images; Mattermost runs as an amd64 image under
emulation on Apple Silicon, so its first start can take a couple of minutes.

`npm run seed` is safe to run again: it wipes and recreates the Postgres tables and
Mailpit inbox, and checks before creating anything else. It writes `docker/.env`
(gitignored) with the generated Gitea and Mattermost tokens; `docker/.env.example`
documents every variable and holds placeholders only.

## Reset

```bash
npm run stack:down
docker compose -f docker/docker-compose.yml down -v   # also deletes all volumes
npm run stack:up && npm run seed
```

## Ports (all bound to 127.0.0.1)

| Service | URL | Port |
| --- | --- | --- |
| Wiki.js | http://127.0.0.1:8081 | 8081 |
| Gitea | http://127.0.0.1:8082 | 8082 (SSH 2222) |
| Mattermost | http://127.0.0.1:8083 | 8083 |
| Mailpit | http://127.0.0.1:8084 | 8084 (SMTP 1025) |
| Postgres | `postgres://kaki:kaki_dev_password@127.0.0.1:5433/kaki` | 5433 |

The repo's dev server uses 3001 and the web app uses 5173, so neither is touched.

## Services and seeded data

- Wiki.js: game design doc, publisher contract summary (final build 20 Nov), booth
  rules (3m x 3m), plus a lunch page as noise.
- Gitea: org `pixel-kampung`, repo `hawker-heroes`, 8 issues including the closed
  save-file corruption bug and older closed noise.
- Mattermost: team `pixel-kampung`, channels `#playtest-feedback`, `#art`, `#launch`
  and `#random`, with the undecided level 5 thread.
- Mailpit: 5 emails, including Starfruit moving the final build to 17 Nov and the
  organiser shrinking the booth to 3m x 2m.
- Postgres: pgvector extension, playtest quit stats (level 5 spike), wishlist counts,
  launch budget, and an empty `knowledge_chunks` table with a `vector(1024)` column.

## Admin logins

- Wiki.js: `admin@pixelkampung.example` / `kaki_wiki_dev`
- Gitea: `wei-ling` / `kaki_gitea_dev`
- Mattermost: `weiling` / `kaki_mattermost_dev` (also `arjun`, `mei`, `daniel` with
  the same password)

See `docker/.env.example` for the URLs, ports and token variables used by the app.
