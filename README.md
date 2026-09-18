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

## Toolchain

Ruby 3.4.10, Node 22, pnpm 10 (pinned in `mise.toml`), PostgreSQL 16. The dev container has all
of them; elsewhere, `mise install`.

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

## License

MIT — see `LICENSE`.
