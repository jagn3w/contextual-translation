# Contextual Translate

Translation that takes context into account. Tell Claude *where* you are and *who* you're
talking to, and it picks the right meaning ("Is this a bat?" at a baseball game), the right
formality (Spanish *tú*/*usted*, Japanese plain/polite/honorific) and the right regional variety.

The design, decisions (D-numbers) and task list live in `design/` and are synced with jkb.

## Layout

| Path | What |
|---|---|
| `backend/` | Rails 8 API: GraphQL (`graphql-ruby`), Sorbet `typed: strict`, Postgres |
| `backend/schema.graphql` | The committed GraphQL schema — the type contract the frontend codegen reads |
| `frontend/` | pnpm workspace; `frontend/app` is the Vite + React + TypeScript SPA |
| `design/` | Design doc and tasks (jkb-synced) |
| `docs/diary.md` | The Diary page: product rules and the backend/frontend GraphQL contract |

## Toolchain

Ruby 3.4.10, Node 22, pnpm 10 (pinned in `mise.toml`), PostgreSQL 16. The dev container has all
of them; elsewhere, `mise install`.

## Running it locally

```sh
bin/dev          # Postgres + Rails (:3000) + Vite (:5173); open http://localhost:5173
```

`bin/dev` sets up what's missing on the first run: it copies `backend/.env` from `.env.example`
(the fake translator, no API key), installs gems and packages, creates the database, and keeps
Postgres data in `~/.cache/pg-dev`. Ctrl-C stops everything it started. To sign in, create an
access code: `cd backend && bin/rails access_codes:create LABEL=Local`. The sections below run
each half on its own.

## Checks

`bin/check` runs every quality gate — RuboCop, Sorbet, Brakeman, Rails tests (including the
`schema.graphql` drift check), TypeScript, Vitest and the production build. CI runs the same
script, and it is the `jkb task land` gate. `bin/check backend` or `bin/check frontend` runs one
half. Without `PGHOST`/`DATABASE_URL` it starts a throwaway Postgres cluster for the run.

## Backend

```sh
cd backend
bundle install
cp .env.example .env            # defaults use the fake translator; no API key needed
# .env sets PGHOST=127.0.0.1 (the dev container's Postgres listens on TCP only)
bin/rails db:prepare
bin/rails server                # http://localhost:3000
```

Checks:

```sh
bin/rails test                  # Minitest
bundle exec srb tc              # Sorbet
bin/rubocop                     # style (rails-omakase)
bin/brakeman --no-pager         # security
bin/rails graphql:dump_schema   # after any GraphQL change; commit schema.graphql
```

### Local API testing (curl)

Create an access code, start the server, then run the smoke script — it signs in with a cookie
jar, runs the `viewer` query and a `translate` mutation, signs out, and checks the session is gone:

```sh
cd backend
bin/rails access_codes:create LABEL="Local testing"      # prints the code once
bin/rails server
# in another terminal, from the repo root:
ORIGIN=http://localhost:5173 bin/smoke ctx-XXXX-... http://localhost:3000
```

`ORIGIN` must be the origin Rails accepts (`APP_HOST`, `localhost:5173` in development). Through
the Vite dev server (`pnpm dev`), `bin/smoke ctx-XXXX-...` needs no extra settings. Against
production: `bin/smoke ctx-XXXX-... https://translate.jagnew.io`. `TEXT`, `CONTEXT`, `FROM` and
`TO` change the sample translation.

By hand, every state-changing request needs the JSON content type and the Origin header:

```sh
curl -c jar -b jar -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"code":"ctx-XXXX-..."}' http://localhost:3000/api/session
curl -c jar -b jar -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"query":"{ viewer { accessCodeLabel } }"}' http://localhost:3000/graphql
```

### Translation eval

`backend/eval/cases.yml` holds 18 cases covering ambiguity ("bat" at a ballpark vs a cave),
formality (Spanish *usted*/*tú*, Japanese keigo) and regional vocabulary (Spain vs Mexico), plus a
prompt-injection check. Run them against Claude (this costs money):

```sh
TRANSLATOR=claude CLAUDE_AUTH=api_key ANTHROPIC_API_KEY=... bin/rails eval:translations EFFORTS=low,medium
```

It prints each translation with Claude's notes, a pass count per category, and p50/p95 latency per
effort level (target: p95 under 10 s).

After adding or upgrading gems, regenerate type information with `bin/tapioca gems` (and
`bin/tapioca dsl` after model or route changes).

## Frontend

```sh
cd frontend
pnpm install
pnpm dev                        # http://localhost:5173 — proxies /api and /graphql to Rails on :3000
```

Checks: `pnpm typecheck`, `pnpm test` (Vitest), `pnpm build`.

GraphQL operations live in `frontend/app/src/graphql/*.graphql`. After changing one — or after the
backend's `schema.graphql` changes — run `pnpm codegen` and commit `frontend/app/src/gql/`; the
generated `TypedDocumentNode`s give every query and mutation checked types end to end.

## Production

One Docker image runs Rails, which also serves the built SPA: `spa/index.html` for every
client-side route (no-cache, strict CSP) and Vite's hashed assets from `public/` (cached forever).
The entrypoint runs `db:prepare` before Puma. Required env: `SECRET_KEY_BASE`, `DATABASE_URL`,
`ACCESS_CODE_PEPPER`, `APP_HOST`, `TRANSLATOR=claude` plus the Claude auth settings (see
`backend/.env.example`). Puma runs 8 threads by default (`RAILS_MAX_THREADS`) because a
translation holds its thread for the whole Claude call.

### Releasing

`bin/release` builds the image on your machine for the x86 EC2 host (`docker buildx --platform
linux/amd64`), pushes it to a private GHCR package tagged with the commit SHA, and runs
`caprover deploy --imageName` — CapRover never builds anything. It refuses to run with uncommitted
changes; `DRY_RUN=1` prints the commands instead.

```sh
IMAGE_REPO=ghcr.io/<owner>/contextual-translate bin/release
```

Needs Docker with buildx (logged in to ghcr.io) and the CapRover CLI (`pnpm add -g caprover`).
`captain-definition` points at the Dockerfile as a fallback for building on the server.

## License

MIT — see `LICENSE`.
