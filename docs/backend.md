# Backend

The Rails side of Contextual Translate: how a request travels through it, how access and abuse
are controlled, how the two features (Phrases and Diary) are layered, and the conventions the code
follows. It is written for an engineer about to change the backend.

File paths are relative to `backend/` (`app/models/access_code.rb` is
`backend/app/models/access_code.rb`), except where a path starts with a top-level directory such as
`backend/`, `bin/`, `docs/` or `frontend/`.

Related documents:

- [phrases.md](phrases.md): the translator end to end (the prompt, `Result`, `Furigana`,
  `GlossLocator`, the eval set).
- [diary.md](diary.md): the Diary feature's product rules and GraphQL contract.
- [api_boundary.md](api_boundary.md): the GraphQL schema as the type contract (`schema.graphql`,
  the drift test, codegen, the error model, complexity and depth limits, public ids).
- [frontend.md](frontend.md): the SPA.
- [runbook.md](runbook.md): standing up production.

## Stack and layout

Rails 8.1 in API mode (`config.api_only = true`), Ruby 3.4, PostgreSQL 16, Puma. GraphQL through
`graphql-ruby`; Sorbet, with every Ruby file under `app/` and `lib/` (rake files aside) at
`typed: strict`; the Anthropic Ruby SDK (`anthropic`) for Claude; `aws-sdk-core` for the STS
identity token used by Workload Identity Federation; `rack-attack` for throttles; `solid_cache`
for a database-backed `Rails.cache`. Only the Railties the app needs are loaded
(`backend/config/application.rb`: no Active Storage, Action Mailer, Action Cable or Action Text).

| Path (under `backend/`) | What |
|---|---|
| `app/controllers/` | `GraphqlController` (the one API endpoint), `Api::SessionsController` (sign in/out), `SpaController` (serves the built SPA) |
| `app/controllers/concerns/` | `RequestSizeLimit`, `RequestOriginCheck`, `Authentication`: the request pipeline |
| `app/graphql/` | `ContextualTranslateSchema`, `types/`, `mutations/`: a thin layer over the services |
| `app/services/translation/` | Phrases: `Service`, `RateLimiter`, the `Translator` seam and its implementations, prompt and result rules, error codes |
| `app/services/diary/` | Diary: `Service`, the `Tutor` seam, `FakeTutor`, `ClaudeTutor`, prompts, enums |
| `app/services/claude/` | Shared Claude plumbing: `ClientFactory`, `MessageCaller`, `TokenRefresher`; `app/services/claude.rb` holds the one client |
| `app/models/` | `AccessCode`, `DiaryEntry`, `DiaryThread`, `DiaryComment`, `PublicId` |
| `lib/` | `LoginBan`, `AccessCodes::Duration`, the translation eval runner (`translation_eval/`), rake tasks (`tasks/`) |
| `config/initializers/` | `rack_attack.rb`, `access_codes.rb` (pepper), `client_ip.rb`, `translation.rb` (boot-time guard), `filter_parameter_logging.rb` |
| `db/` | Migrations and `schema.rb` |
| `schema.graphql` | The committed GraphQL schema (see api_boundary.md) |
| `sorbet/` | Sorbet config and Tapioca-generated RBIs |
| `test/` | Minitest suite |
| `eval/cases.yml` | Translation eval cases (see phrases.md) |

Dependency direction: controllers → GraphQL types and mutations → services → models and the
Claude plumbing. Services never see GraphQL types, and the tutor and translator implementations
never touch the database (their requests and results are plain `T::Struct` values).

## Routes

`backend/config/routes.rb` defines four things:

| Route | Handler |
|---|---|
| `POST /graphql` | `GraphqlController#execute`; every query and mutation |
| `POST /api/session`, `DELETE /api/session` | `Api::SessionsController#create` / `#destroy` |
| `GET /up` | Rails' health check (no session, never throttled) |
| `GET /` and any other HTML `GET` | `SpaController#show` |

The API routes use `format: false`, so `/graphql.json` and similar variants do not exist; rack-attack
matches these exact paths, and a format suffix would otherwise slip past it.

## Request pipeline

A request to `/graphql` or `/api/session` passes through, in order:

1. **rack-attack** (Rack middleware, before the router): the throttles and the sign-in ban, see
   [Abuse controls](#abuse-controls).
2. **Cookie and session middleware.** API mode drops them, so `config/application.rb` adds back
   `ActionDispatch::Cookies` and an encrypted cookie store: `_contextual_translate_session`,
   `httponly`, `same_site: :strict`, `secure` in production, `expire_after: 12.hours`. The cookie is
   encrypted and signed with `SECRET_KEY_BASE`; rotating it signs everyone out.
3. **`ApplicationController` before-actions**, from its concerns, in include order:
   - `RequestSizeLimit` (`app/controllers/concerns/request_size_limit.rb`): a `Content-Length`
     over 64 KB gets `413 {"error":"payload_too_large"}` before the body is parsed (Rails parses
     params lazily). 64 KB fits the largest valid translate request (10,000 characters of text plus
     2,000 of context, even at 3 bytes per character).
   - `RequestOriginCheck`: the CSRF defence, below.
   - `Authentication` itself adds no before-action; it provides `current_session`.
4. **The controller.** `GraphqlController` has `before_action :require_session`, which answers
   `401` with a GraphQL-shaped body (`errors[0].extensions.code = "UNAUTHENTICATED"`) so the client
   handles it like any other top-level error. It then checks that `query` is a string and
   `variables` is a JSON object (`400` otherwise) and runs `ContextualTranslateSchema.execute` with
   `context: { current_session: }`.

`SpaController` inherits from `ActionController::API` directly, not `ApplicationController`, so
none of the above applies to it (it only answers `GET`s and needs no session).

### CSRF: SameSite, JSON and Origin

Rails' token-based forgery protection is not used; no request carries a token. Instead
`RequestOriginCheck` (`app/controllers/concerns/request_origin_check.rb`) relies on three layers:

- the session cookie is `SameSite=Strict`, so other sites' requests do not carry it;
- every non-`GET`/`HEAD` request must have `Content-Type: application/json` (`415
  unsupported_media_type` otherwise), which a plain HTML form cannot send;
- its `Origin` header must be present and equal `config.x.allowed_origin` (`403 forbidden_origin`
  otherwise, logged at `warn`).

`config.x.allowed_origin` is `https://$APP_HOST` in production, `http://$APP_HOST` in development
(default `localhost:5173`, the Vite dev server, which proxies `/api` and `/graphql` to Rails), and
`http://www.example.com` in tests (Rails' integration-test host). Anything calling the API by hand,
`curl` or `bin/smoke`, must send both headers; see the README's "Local API testing".

### Sessions and access codes

The app has no user accounts. Access is by **access code**, a shared secret an operator creates and
hands out; a browser trades it for a session cookie.

`POST /api/session` with `{"code": "..."}` (`Api::SessionsController#create`). This is a REST
endpoint rather than a GraphQL mutation so rack-attack can throttle it by path. A code that is not
a string, is over 100 characters, or does not match an active code gets `401
{"error":"invalid_code"}`, logs `Failed access-code sign-in from <ip>` (the IP, never the code) and
records a failure for `LoginBan`. A good code gets `204` and a fresh session. `DELETE
/api/session` ends it (`204`).

`Authentication` (`app/controllers/concerns/authentication.rb`) owns the session:

- `start_session` calls `reset_session` first (a new session id: no fixation), then stores three
  values: `access_code_id`, `authenticated_at` (epoch seconds) and `session_key`, 16 random bytes in
  hex that identify this device's session and key the per-session rate limits.
- `current_session` loads and memoizes an `Authentication::Current` struct (`access_code`,
  `session_key`, `authenticated_at`) or `nil`. On **every request** it re-reads the `AccessCode`
  row and checks `active?`, so revoking or expiring a code ends its sessions on their next request.
  It also enforces `SESSION_TTL` (12 hours) from `authenticated_at`: an absolute limit, not a
  sliding one, and the client cannot extend it because the timestamp lives inside the encrypted
  cookie. A session that fails either check is reset.
- GraphQL resolvers reach it as `context[:current_session]`. The `viewer` query exposes the code's
  label and expiry and `sessionExpiresAt` (`authenticated_at + SESSION_TTL`), so the SPA can tell
  when the session will end.

### Access codes

`AccessCode` (`app/models/access_code.rb`):

- **Format.** `ctx-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`: 24 characters of Crockford base32 (no I, L, O or
  U), 120 random bits from `SecureRandom`. Input is normalized before lookup: case, whitespace and
  dashes are ignored, the `ctx` prefix is optional, and the look-alikes O, I and L decode to 0, 1
  and 1, as Crockford specifies.
- **Storage.** Only `code_digest` is stored: HMAC-SHA256 of the normalized body, keyed with
  `config.x.access_code_pepper` (`config/initializers/access_codes.rb`), unique-indexed. A database
  leak exposes no usable code, and an HMAC digest (rather than a slow password hash) is enough
  because the input has 120 bits of entropy and the lookup has to be by digest. The pepper is
  deliberately separate from `SECRET_KEY_BASE`: rotating the secret key ends sessions, rotating the
  pepper invalidates every code. Production requires `ACCESS_CODE_PEPPER` at boot; development and
  test fall back to a fixed placeholder.
- **Lifecycle.** `expires_at` (optional) and `revoked_at`; `active?` and the `active` scope agree
  on "not revoked and not expired". A successful sign-in touches `last_used_at`. Deleting a code
  deletes its diary entries (and, by database cascade, their threads and comments).

Rake tasks (`lib/tasks/access_codes.rake`; in production, run them in the app container, see the
runbook):

```sh
bin/rails access_codes:create LABEL="Side project" [EXPIRES_IN=30d|12h|90m]  # prints the code once
bin/rails access_codes:list      # id, status, label, dates; never the code
bin/rails access_codes:revoke ID=3
```

`EXPIRES_IN` is parsed by `AccessCodes::Duration` (`lib/access_codes/duration.rb`).

## Abuse controls

Two layers: coarse per-IP throttles in rack-attack, ahead of Rails, and per-session and per-code
limits on Claude calls inside the service layer. The second is where the cost is, so it is where the
limits are precise.

### rack-attack and LoginBan

`config/initializers/rack_attack.rb`:

| Rule | Limit |
|---|---|
| `health-check` safelist | `/up` is never throttled |
| `sign-in/ip/minute`, `sign-in/ip/hour` | `POST /api/session`: 5 a minute and 20 an hour per IP |
| `sign-in/banned` blocklist | `POST /api/session` from an IP `LoginBan` has banned |
| `graphql/ip/minute` | `/graphql`: 60 a minute per IP |

Throttled requests get `429 {"error":"rate_limited","retryAfterSeconds":n}` with `Retry-After`; a
banned IP gets `429 {"error":"too_many_failed_attempts",...}`. Both are logged at `warn` with the IP
and path.

`LoginBan` (`lib/login_ban.rb`) wraps `Rack::Attack::Fail2Ban`: 10 failed codes in 10 minutes from
one IP ban it from signing in for 10 minutes. Failures are only known once the controller has checked
the code, so the controller records them and the blocklist consults the ban on the next request. The
ban is short on purpose: a group sharing one office network must not be locked out for long by one
person's typos.

Counters live in `Rails.cache`: Solid Cache (Postgres) in production, so they are shared by every
Puma thread and survive restarts; an in-process memory store in development; a null store in tests
(tests that exercise counting swap in a `MemoryStore`).

Client IPs are `req.ip`. Behind CapRover's nginx, `config/initializers/client_ip.rb` sets
`Rack::Request.forwarded_priority = [:x_forwarded]`: Rack would otherwise prefer the RFC 7239
`Forwarded` header, which nginx passes through untouched, so a client could pick its own IP. Rack
trusts `X-Forwarded-For` only from private-range proxies. Do not set
`config.action_dispatch.trusted_proxies` for this: rack-attack does not read it. The runbook has a
post-deploy check that the logged IPs are real client addresses.

rack-attack normalizes the path before matching, so `/api/session/` and `//api/session` hit the
same rules (`test/integration/rack_attack_test.rb` guards this).

### RateLimiter: per session and per code

`Translation::RateLimiter` (`app/services/translation/rate_limiter.rb`) counts **every Claude
call**: translations, and every diary tutor call (review, help thread, reply, hint, topic ideas).
The two features share one budget.

| Limit | Count | Window |
|---|---|---|
| `session-minute` | 10 | 1 minute |
| `session-day` | 150 | 1 day |
| `code-minute` | 30 | 1 minute |
| `code-day` | 500 | 1 day |

The session limits are per device; the code limits are a backstop, since signing in again starts a
fresh session. Windows are fixed (aligned to the epoch), counted with `Rails.cache.increment`. Every
counter is incremented before any is checked, so an attempt refused by the code limit still counts
against its session, and the error reports the **longest** wait among the exceeded limits, so a
daily cap is not disguised as a per-minute one. Going over raises `Translation::Error` with code
`RATE_LIMITED` and `retry_after_seconds`, which reaches the client as a typed payload error (this
is why the limits live here and not in rack-attack, which can only answer with a bare 429).

If the cache is unavailable (Solid Cache's failsafe returns `nil`), the limiter **fails open**:
the count reads as 0. The Anthropic workspace's monthly spend limit is the hard backstop.

Separately, each mutation that calls Claude has GraphQL complexity 100 against a schema maximum of
150, so one HTTP request makes at most one Claude call however it is aliased (see
api_boundary.md).

## Service layer

Both features have the same shape:

```
GraphQL mutation ──> Service ──> validate ──> RateLimiter.check! ──> Translator / Tutor
                        │                                              ├─ Fake*   (deterministic)
                        └─ persist (Diary only)                        └─ Claude* (MessageCaller)
```

- **`Translation::Service`** (`app/services/translation/service.rb`): validates (non-empty, source
  up to 10,000 characters, context up to 2,000, different languages), checks the rate limit, calls
  `translator.translate(request)` and returns a `Translation::Result`.
- **`Diary::Service`** (`app/services/diary/service.rb`): the diary operations. Records arrive
  already scoped to the session's access code (`Mutations::BaseDiaryMutation` looks them up through
  it). Tutor-calling operations validate, check the rate limit, call the tutor **outside** any
  transaction (a call takes seconds), then persist in a transaction that first re-locks the entry
  or thread; if the learner deleted it meanwhile, that raises `Diary::Service::NotFound` instead of
  a foreign-key error. Nothing is written if the tutor fails. See diary.md for the rules
  themselves.

Anticipated failures, from validation, the rate limiter or Claude, are `Translation::Error` carrying
a `Translation::ErrorCode` (a `T::Enum` whose values match the GraphQL `TranslateErrorCode` enum)
and an optional `retry_after_seconds`. Mutations rescue it and return it in the payload's
`errors` list; the Diary reuses the same error type, so the SPA shows the same messages on both
pages. Two diary-only exceptions become top-level GraphQL errors instead: `Diary::Service::Invalid`
(code `INVALID`) and `NotFound` (code `NOT_FOUND`). Anything else is unexpected and becomes
`INTERNAL`, below. api_boundary.md describes the error model from the client's side.

### Pluggable Translator and Tutor

`Translation::Translator` and `Diary::Tutor` are Sorbet `interface!` modules. Each has two
implementations:

| | Fake | Claude |
|---|---|---|
| Translation | `FakeTranslator`: tags the source text, adds stand-in glosses and readings, and runs everything through the same `Result.for_request` rules as production | `ClaudeTranslator` |
| Diary | `FakeTutor`: splits sentences on punctuation, cycles verdicts (WRONG, IMPROVABLE, CORRECT) so every colour shows, canned hints and topics | `ClaudeTutor`: one prompt and JSON schema per operation (review, reply, hint, topics) |

`TRANSLATOR` selects both: `fake` (the default; tests, CI, frontend work, no API key, no cost) or
`claude`. `Translation.translator` and `Diary.tutor` build and memoize the configured one;
tests replace them with `Translation.translator=` / `Diary.tutor=` and reset them to `nil` in
teardown.

**Production guard.** `build_translator` and `build_tutor` raise unless `TRANSLATOR=claude` in
production: a missing or `fake` value would otherwise boot and serve placeholder output while every
health check passed. `config/initializers/translation.rb` builds both in production at boot, so a
misconfiguration (unknown `TRANSLATOR`, missing WIF ids, a stray API key under WIF) stops the app
from starting rather than failing the first request.

## Claude machinery

Everything about talking to Claude that is not specific to one prompt is shared, so the translator
and the tutor cannot drift apart.

### One client per process

`Claude.client` (`app/services/claude.rb`) is a mutex-guarded, lazily built `Anthropic::Client`.
`ClaudeTranslator` and `ClaudeTutor` both receive it, so under Workload Identity Federation there is
one token refresher (one background thread, one token) per process however many features call
Claude. Only standalone builds (the eval task, `claude:auth_check`) construct their own client.

### ClientFactory and auth modes

`Claude::ClientFactory.build` (`app/services/claude/client_factory.rb`) reads `CLAUDE_AUTH`:

- **`api_key`** (default): `ANTHROPIC_API_KEY`, required. For local development and the eval set,
  with a key from a dev workspace.
- **`wif`** (production): Workload Identity Federation. The EC2 instance role asks AWS STS for a
  short-lived identity token (`GetWebIdentityToken`, audience `https://api.anthropic.com`, 15
  minutes), and the SDK's `WorkloadIdentity` credentials exchange it for an Anthropic access token.
  No Anthropic secret exists anywhere. Requires `AWS_REGION`, `ANTHROPIC_FEDERATION_RULE_ID`,
  `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_SERVICE_ACCOUNT_ID` (`ANTHROPIC_WORKSPACE_ID`
  optional). It **refuses to build** if `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or
  `ANTHROPIC_PROFILE` is set, since any default-constructed client would silently use them instead.
  The STS client is created on first use with tight timeouts (2 s open, 5 s read, one retry), and is
  kept only once it has resolved credentials, so a brief instance-metadata outage cannot poison it
  for the life of the process.

Both modes set `max_retries: 0` (the SDK's own retries are off; `MessageCaller` owns retrying) and
`timeout: 30` seconds.

### TokenRefresher

`Claude::TokenRefresher` (`app/services/claude/token_refresher.rb`) wraps the WIF provider so that
request threads never fetch credentials themselves: the STS call plus token exchange can take tens of
seconds and cannot be interrupted.

- One background thread (`claude-wif-token-refresher`) fetches at once, then at half each token's
  lifetime, and early when a request reports a 401. A failed fetch is retried with exponential
  backoff (5 s doubling to 60 s) while the current token is served until it expires. A token with
  under 60 s left counts as expired; one that arrives with under 120 s of life counts as a failed
  fetch.
- `call`, the SDK's credentials hook, never fetches or waits: it returns the current token or raises
  `TokenUnavailable`. It hands the SDK copies that already look expired, so the SDK asks again on
  every request, and records which token generation each request sent.
- `await_token`, called by `MessageCaller` before each request, waits a bounded time for a usable
  token (or, after a 401, for one newer than the rejected generation). It fails at once while the
  refresher is backing off rather than parking Puma threads.
- If a token fetched *because of* a 401 is itself rejected, the configuration is probably wrong;
  the refresher records `TokenRejected` and backs off, so persistent 401s cost one token exchange
  per backoff interval rather than one per request.

**Warm-up.** Puma's `after_booted` hook (`config/puma.rb`) calls `Translation.translator.warm_up`
in production, which starts the refresher before the first request arrives; because the tutor shares
the client, that warms it too. `await_token` also starts the thread if needed (rake tasks,
consoles, and each worker if Puma ever runs in cluster mode; the hook assumes single mode).

### MessageCaller

`Claude::MessageCaller` (`app/services/claude/message_caller.rb`) wraps one Messages call. The
feature code passes a label (`"translation"`, `"diary review"`, …) and a block that builds the
request with the timeout it is given; `MessageCaller` owns everything around it:

- **Deadline.** The whole call, retry included, must finish within `DEADLINE_SECONDS = 55`, inside
  the 60 s `proxy_read_timeout` of CapRover's nginx. Every request carries an explicit timeout of
  `min(time left, 30 s)`. The explicit timeout matters: with empty request options the SDK's beta
  endpoint ignores the client's 30 s and waits 600 s.
- **Credentials.** Under WIF, `await_token` first, keeping at least 10 s of the deadline for the
  call itself. A no-op with an API key.
- **One retry.** On `429` or `5xx` after the `retry-after` delay (1 s if absent, capped at 5 s),
  and on `401` under WIF after awaiting a newer token. Only if at least 10 s would remain. Never
  on a timeout: a timed-out request is already as slow as a user will tolerate. Never on the
  account tier's spend cap (`enforced_spend_limit_reached`).
- **Error mapping.** Failures go through `Translation::ClaudeErrorMapper`
  (`app/services/translation/claude_error_mapper.rb`), the one place that turns SDK, STS and token
  refresher exceptions into error codes: timeouts → `TIMEOUT`; connection and STS transport
  failures → `UPSTREAM_UNREACHABLE`; 429 → `UPSTREAM_RATE_LIMITED` (with `retry-after`); 529 or
  `overloaded_error` → `UPSTREAM_OVERLOADED`; other 5xx → `UPSTREAM_ERROR`; the workspace usage
  limit, the tier spend cap and billing errors → `BUDGET_EXCEEDED`; 401/403/404, missing AWS
  credentials and rejected tokens → `SERVICE_MISCONFIGURED`. Anything unrecognized is re-raised
  unchanged and ends up as `INTERNAL`.
- **Logging.** Success logs label, model, stop reason, duration and token counts. A mapped failure
  logs the code, exception class, request id and a truncated SDK message, at `error` for
  `SERVICE_MISCONFIGURED` and `BUDGET_EXCEEDED` (an operator must act) and `warn` otherwise.

Requests themselves (built in `ClaudeTranslator` and `ClaudeTutor`) use the beta Messages endpoint
with structured outputs (a JSON schema per operation), an `effort` setting, and the server-side
refusal fallback beta. `CLAUDE_MODEL` (default `claude-opus-5`) and `CLAUDE_EFFORT` (default
`medium`) apply to both features. Parsing happens after `MessageCaller` returns: stop reason
`refusal` → `REFUSED`, `max_tokens` → `OUTPUT_TOO_LONG`, unparseable output → `UPSTREAM_ERROR`.

**Never log user text.** Source text, context, diary bodies, comments and Claude's replies about
them never reach the logs: log lines carry counts, byte sizes, codes and ids only. The same rule is
applied to request logs by `config/initializers/filter_parameter_logging.rb`, which adds `code`
(access codes) and `variables` (every GraphQL input) to Rails' filtered parameters. Prompts put
user text inside tags and instruct the model to treat it as text, never as instructions.

## Database

PostgreSQL 16. Tables (`backend/db/schema.rb`):

| Table | Notes |
|---|---|
| `access_codes` | `label`, `code_digest` (unique), `expires_at`, `revoked_at`, `last_used_at` |
| `diary_entries` | `access_code_id` → `access_codes`, `language`, `notes_language`, `body`, `reviewed_body`, `reviewed_at`, `review_count`; index on `(access_code_id, created_at)` for the scrollback |
| `diary_threads` | `diary_entry_id` → `diary_entries`, `kind`, `verdict`, `sentence`, `starts_at`, `length`, `title`, `current`, `hint_level`, `resolved_at`, `review_round` |
| `diary_comments` | `diary_thread_id` → `diary_threads`, `author`, `body` |
| `solid_cache_entries` | Solid Cache's table |

diary.md explains the diary columns.

- **Cascades.** Every foreign key is `ON DELETE CASCADE`, so deleting an access code or an entry
  removes everything under it in the database, in one statement. The models' `dependent:
  :delete_all` goes one level; the cascades do the rest.
- **Check constraints** mirror the Ruby enums: languages `en`/`es`/`ja`; thread kind
  `sentence`/`entry`/`help`; verdict null or `correct`/`improvable`/`wrong`; author
  `learner`/`tutor`. Models store the enum's serialization as a string, validate inclusion, and
  expose the typed value through `*_enum` readers (`DiaryEntry#language_enum`,
  `DiaryThread#kind_enum`, …).
- **Public ids.** Each diary table has `public_id uuid NOT NULL DEFAULT gen_random_uuid()` with a
  unique index, and it is the only id the API accepts or returns. The bigint primary keys come from
  sequences shared by every access code, so exposing them would reveal how many entries, threads
  and comments exist app-wide. They stay internal (foreign keys, ordering).
  `PublicId.parse` (`app/models/public_id.rb`) returns the lowercase UUID or `nil` for anything not
  UUID-shaped, so a malformed id is looked up as nothing (a missing record) instead of making
  Postgres raise on the cast. Lookups always go through the session's access code, so another
  code's id behaves exactly like a missing one. `gen_random_uuid()` is built into Postgres 13+; no
  extension is needed.
- **Migrations** (`backend/db/migrate/`): `CreateSolidCacheEntries`, `CreateAccessCodes`,
  `CreateDiary`. Solid Cache normally has its own database and `cache_schema.rb`; here it shares the
  primary database (one Postgres app in production), so its table comes from an ordinary migration.
  The container entrypoint (`backend/bin/docker-entrypoint`) runs `db:prepare` before starting
  Puma; production does not dump the schema after migrating, so regenerate `db/schema.rb` in
  development and commit it with the migration.
- **Pool.** `database.yml` sizes the pool to `RAILS_MAX_THREADS` (default 8), matching Puma's
  thread count. A Claude call holds its request thread (and nothing else: tutor calls happen
  outside transactions) for seconds, which is why Puma runs 8 threads rather than Rails' default 3.

## GraphQL server side

`ContextualTranslateSchema` (`app/graphql/contextual_translate_schema.rb`) sets the query and
mutation roots, uses `GraphQL::Dataloader`, and limits incoming queries (max depth 15, 5,000
tokens, complexity 150, 100 validation errors; api_boundary.md explains the numbers).

Its `rescue_from(StandardError)` is the catch-all for failures nobody planned for: it logs the
exception class, message and ten backtrace lines under a random 8-hex-character reference, and
returns a top-level error `"Something unexpected went wrong."` with `extensions: { code:
"INTERNAL", reference: }`. The client shows the reference, and an operator finds the details by
grepping the logs for `ref=<reference>`. Internal messages never reach the client.

Resolvers are thin: mutations (`app/graphql/mutations/`, plain `GraphQL::Schema::Mutation`, not
Relay) build a service request from the input, call the service, and map `Translation::Error` into
the payload. Diary mutations inherit `BaseDiaryMutation`, which provides `find_entry!` and
`find_thread!` (public id, scoped to the session's access code, `NOT_FOUND` otherwise). After
changing any type, run `bin/rails graphql:dump_schema` and commit `backend/schema.graphql`; the
drift test fails otherwise.

## Conventions

- **Sorbet.** Every Ruby file in `app/` and `lib/` is `# typed: strict` (as is
  `config/initializers/access_codes.rb`): every method has a `sig`, every instance variable a
  `T.let`. Tests, rake files and the other initializers carry no sigil, so Sorbet only
  syntax-checks them. Value objects are `T::Struct` (`Translation::Request`, the `Diary::Tutor`
  request and result types, `Authentication::Current`), closed sets are `T::Enum`
  (`Translation::Language`, `ErrorCode`, `GlossLevel`, `Diary::Verdict`, `ThreadKind`, `Author`),
  and exhaustive `case`s end in `T.absurd`. `sorbet-runtime` checks sigs at runtime too. Concerns
  declare `requires_ancestor` (enabled by `--enable-experimental-requires-ancestor` in
  `backend/sorbet/config`). `T.unsafe` appears only where an RBI lags the gem, with a comment
  saying why.
- **Tapioca.** RBIs for gems (`sorbet/rbi/gems/`) and for Rails DSLs such as model attributes and
  GraphQL input types (`sorbet/rbi/dsl/`) are generated and committed. Run `bin/tapioca gems` after
  changing gems and `bin/tapioca dsl` after changing models, routes or GraphQL input types.
- **RuboCop** with `rubocop-rails-omakase` (`backend/.rubocop.yml`), no local overrides.
- **Brakeman** runs with `--exit-on-warn`; any warning fails the check. **bundler-audit** runs in
  CI only (it needs the advisory database).
- **Comments explain why.** Constants carry their reasoning (see the token budgets in
  `ClaudeTranslator` and `ClaudeTutor`, or `Diary::Service::MAX_REVIEW_LENGTH`), and when a
  number is an estimate rather than a measurement, the comment says so and how to measure it.

## Testing

Minitest (`backend/test/`), run with `bin/rails test`.

- **Serial on purpose** (`parallelize(workers: 1)` in `test/test_helper.rb`): the suite takes
  seconds, several tests stub process-global state (`travel_to`, WebMock, `ENV`), and parallel
  workers coordinate over a DRb Unix socket the dev-container sandbox blocks.
- **Never Claude.** `test_helper.rb` forces `TRANSLATOR=fake` and `CLAUDE_AUTH=api_key` and deletes
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, whatever a developer's `.env` says. `webmock/minitest`
  blocks all network access. The Claude classes (`ClaudeTranslator`, `ClaudeTutor`,
  `ClientFactory`) are tested against the real SDK with HTTP stubbed by WebMock, so request shape,
  retries and error mapping are exercised end to end; `TokenRefresher` and `MessageCaller` take
  injectable clocks and sleepers.
- **Fakes and doubles.** GraphQL tests run against `FakeTranslator`/`FakeTutor`, or swap in a
  recording or raising double through `Translation.translator=` / `Diary.tutor=`. Service tests
  construct services with an explicit tutor or translator and a `RateLimiter` over its own
  `MemoryStore` (the test environment's cache is a null store, which counts nothing).
- **Integration helpers.** `test/support/session_helpers.rb` (included in every
  `ActionDispatch::IntegrationTest`) sends requests the way the browser does: `post_json` /
  `delete_json` with the app's `Origin`, `sign_in` (creates a code and signs in, returning the
  record and plaintext), and `graphql(query, variables:)` returning the parsed body.
- **Drift test.** `test/lib/graphql_schema_dump_test.rb` fails if `backend/schema.graphql` differs
  from `ContextualTranslateSchema.to_definition`.

Layout mirrors `app/`: `test/models`, `test/services`, `test/graphql` (resolver behaviour through
the endpoint), `test/integration` (sessions, rack-attack, the size limit, the endpoint's edge
cases), `test/tasks` (rake tasks), `test/lib`.

## Running locally

From the repo root, `bin/dev` runs Postgres (data in `~/.cache/pg-dev`, TCP only), Rails on :3000
and Vite on :5173; open `http://localhost:5173`. On first run it copies `backend/.env.example` to
`backend/.env` (fake translator, no key). Create an access code with
`cd backend && bin/rails access_codes:create LABEL=Local`. The README covers running the backend on
its own and `bin/smoke`, the curl-based end-to-end check (sign in, `viewer`, `translate`, sign out).

To use real Claude locally, set `TRANSLATOR=claude`, `CLAUDE_AUTH=api_key` and a dev-workspace
`ANTHROPIC_API_KEY` in `backend/.env`. `bin/rails claude:auth_check` checks the configured auth and
performs one translation.

**Checks.** `bin/check backend` runs RuboCop, Sorbet (`srb tc`), Brakeman and the tests (drift test
included); CI runs the same script. Without `PGHOST` or `DATABASE_URL` it starts a throwaway
Postgres cluster on a free port and removes it afterwards. That cluster takes its encoding from the
locale: with an unset or `C` locale, `initdb` creates it as `SQL_ASCII`, and creating the UTF-8 test
database fails. Run it under a UTF-8 locale, for example `LANG=C.UTF-8 bin/check backend`.

## Production

One Docker image (`Dockerfile`): a Node stage builds the SPA, a Ruby stage installs gems, and the
runtime stage runs Rails as a non-root user. Rails serves the SPA's `index.html` through
`SpaController` (from `spa/index.html`: `Cache-Control: no-cache`, a strict static
Content-Security-Policy, a `Permissions-Policy`) and Vite's content-hashed assets from `public/`
(cached for a year, `immutable`). The image is deployed to CapRover behind its nginx, which
terminates TLS.

Production settings in `config/environments/production.rb`: `force_ssl` with `assume_ssl` (TLS
ends at the proxy), host authorization for `APP_HOST` only (with `/up` exempt, since CapRover
probes it by container address), logs to stdout tagged with the request id at `RAILS_LOG_LEVEL`
(default `info`), and Solid Cache as `Rails.cache`.

Environment:

| Variable | Purpose |
|---|---|
| `SECRET_KEY_BASE` | Encrypts and signs the session cookie |
| `DATABASE_URL` | Postgres (also holds Solid Cache) |
| `ACCESS_CODE_PEPPER` | HMAC key for access-code digests; required at boot |
| `APP_HOST` | The public host: host authorization and the allowed Origin |
| `TRANSLATOR` | Must be `claude` |
| `CLAUDE_AUTH` | `wif`, plus `AWS_REGION` and the `ANTHROPIC_*` federation ids |
| `CLAUDE_MODEL`, `CLAUDE_EFFORT` | Optional; default `claude-opus-5`, `medium` |
| `RAILS_MAX_THREADS` | Optional; Puma threads and DB pool, default 8 |

`backend/.env.example` documents each one, and [runbook.md](runbook.md) walks through setting up the
host, Postgres, Workload Identity Federation, the environment and the first release, including the
post-deploy checks (`bin/rails claude:auth_check`, `bin/smoke`, the client-IP check).
