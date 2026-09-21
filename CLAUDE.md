# CLAUDE.md

Contextual Translate: a Rails 8 GraphQL API (`backend/`) and a Vite + React + TypeScript SPA
(`frontend/app`) with two features, **Phrases** (context-aware translation) and **Diary** (a
language-learning diary with Claude as tutor). Both call Claude through one shared client.

## Checks

- `bin/check` runs every gate (RuboCop, Sorbet, Brakeman, Tapioca RBI freshness, Rails tests incl.
  the schema drift test, codegen freshness, typecheck, Vitest, build). It is the CI and land gate;
  run it before you commit. `bin/check backend` / `bin/check frontend` run one half.
- It starts a throwaway Postgres when `PGHOST`/`DATABASE_URL` are unset, which needs a UTF-8
  locale: run it as `LANG=C.UTF-8 LC_ALL=C.UTF-8 bin/check` if `LANG` is empty.
- The codegen check compares `frontend/app/src/gql` against git, so it reports "stale" until the
  regenerated files are committed.
- `bin/dev` runs Postgres, Rails (:3000) and Vite (:5173) for local use.

## When you change…

- **The GraphQL schema** (anything in `backend/app/graphql/`): `bin/rails graphql:dump_schema` in
  `backend/`, then `pnpm codegen` in `frontend/`, and commit `backend/schema.graphql` and
  `frontend/app/src/gql/` with the change. Update the frontend fakes (`frontend/app/src/test/`)
  to match. Recipe: [docs/api_boundary.md](docs/api_boundary.md).
- **Models, migrations, routes or GraphQL input types**: `bin/tapioca dsl` in `backend/` (it runs
  against the test database) and commit the RBIs under `backend/sorbet/rbi/dsl/`; `bin/check`
  fails if they are stale. Commit `backend/db/schema.rb` with migrations, and add a new migration
  rather than editing one that may already have run somewhere.
- **A prompt**: read [docs/prompts.md](docs/prompts.md) first; keep the fake translator/tutor
  behaving like production.

## Rules that are easy to break

- Ruby under `backend/app` and `backend/lib` is Sorbet `typed: strict`, with a `sig` on every
  method. RuboCop is rails-omakase (`[ a, b ]` with inner spaces).
- Tests never call Claude: `TRANSLATOR=fake` is forced in tests and Claude HTTP is stubbed with
  WebMock. Production refuses to boot unless `TRANSLATOR=claude`.
- Talk to Claude only through `Claude.client` and `Claude::MessageCaller` (one client and one
  credential refresher per process; shared retry, deadline and error mapping). Anticipated
  failures are `Translation::Error` with a code, returned in a payload's `errors`.
- User text (translations, diary entries, comments) goes into prompts inside tags as data, and is
  never logged.
- Diary data is private to the access code that created it: always look records up through the
  session's access code. Diary records are exposed only by their random `public_id` UUID, never
  the database id.
- Text offsets exchanged with the frontend count Unicode code points, not UTF-16 units.
- Frontend components use the colour tokens in `frontend/app/src/index.css`, never raw colours;
  new tokens record their contrast ratios (a test recomputes them).
- In frontend tests, let a pending autosave finish (wait for "Saved") before the test ends, or
  its failure toast leaks into the next test.
- Code comments citing "design D2.3"-style numbers refer to a design document that is not in this
  repository (`design/` is gitignored); don't add new ones.

## Docs

- [docs/backend.md](docs/backend.md): request pipeline, access codes and sessions, abuse
  controls, services, the Claude machinery, database, conventions, testing.
- [docs/frontend.md](docs/frontend.md): SPA structure, routing, session lifecycle, data layer,
  styling, accessibility, testing.
- [docs/api_boundary.md](docs/api_boundary.md): the GraphQL type contract, error model, limits,
  transport and auth, every operation.
- [docs/prompts.md](docs/prompts.md): every request sent to Claude.
- [docs/phrases.md](docs/phrases.md) and [docs/diary.md](docs/diary.md): the two features.
- [docs/runbook.md](docs/runbook.md): production.
