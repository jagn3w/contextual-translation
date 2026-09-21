# The API boundary

How the SPA (`frontend/app`) and the Rails API (`backend/`) talk to each other: the GraphQL schema
as the one type contract both sides are built from, the error model that crosses it, the limits and
transport rules that wrap it, and the one REST endpoint beside it. What happens on either side of
the line is elsewhere:

- [docs/backend.md](backend.md): the Rails side — authentication, security, services, Claude.
- [docs/frontend.md](frontend.md): the SPA — routing, components, Apollo cache use, state.
- [docs/phrases.md](phrases.md) and [docs/diary.md](diary.md): the two features, their product
  rules and their parts of the contract.

## Everything the client and server exchange

| Path | Method | What | Session needed |
| --- | --- | --- | --- |
| `/graphql` | POST | Every query and mutation | yes (401 otherwise) |
| `/api/session` | POST | Exchange an access code for a session cookie | no |
| `/api/session` | DELETE | End the session | no |
| `/up` | GET | Rails health check (load balancer, `bin/smoke`) | no |
| any other HTML path | GET | The SPA's `index.html` (client-side routes) | no |

That is the whole surface (`backend/config/routes.rb`). There is no GraphQL-over-GET, no
subscriptions, no websocket, no file upload. `/graphql` and `/api/session` are routed with
`format: false`, so `/graphql.json` and similar spellings are 404s rather than a way around the
path-based throttles.

## The contract pipeline

The schema is defined once, in Ruby, and every other artifact is generated from it and committed:

```
backend/app/graphql/**            Ruby type classes (graphql-ruby, Sorbet typed: strict)
        │  bin/rails graphql:dump_schema        (backend/lib/tasks/graphql.rake)
        ▼
backend/schema.graphql            committed SDL: ContextualTranslateSchema.to_definition
        │  backend test fails if stale          (backend/test/lib/graphql_schema_dump_test.rb)
        │
        │  pnpm codegen                         (frontend/app/codegen.ts)
        │  + frontend/app/src/graphql/*.graphql (the operations the SPA sends)
        ▼
frontend/app/src/gql/             committed generated TypeScript
        │  bin/check fails if stale
        ▼
TypedDocumentNode constants (e.g. ReviewDiaryEntryDocument) passed to Apollo's
useQuery / client.mutate: variables and results are typed end to end
```

Step by step:

1. **Ruby types are the source.** `ContextualTranslateSchema`
   (`backend/app/graphql/contextual_translate_schema.rb`) mounts `Types::QueryType` and
   `Types::MutationType`; object, input, enum and payload types live in
   `backend/app/graphql/types/`, mutations in `backend/app/graphql/mutations/`.
2. **The dump.** `bin/rails graphql:dump_schema` writes `ContextualTranslateSchema.to_definition` to
   `backend/schema.graphql`. The file is committed; it is the contract.
3. **The drift test.** `GraphqlSchemaDumpTest` compares the committed file with a fresh
   `to_definition` and fails with "schema.graphql is stale; run bin/rails graphql:dump_schema". It
   runs with every `bin/rails test`, so `bin/check backend` and CI catch a Ruby change that was not
   dumped.
4. **Codegen.** `pnpm codegen` (in `frontend/`, or `frontend/app/`) runs GraphQL Code Generator
   with `frontend/app/codegen.ts`:
   - `schema: "../../backend/schema.graphql"` — it reads the committed file, never a running
     server, so codegen works offline and in CI without Rails.
   - `documents: ["src/**/*.graphql"]` with `ignoreNoDocuments: false`. The operations live in
     `frontend/app/src/graphql/` (`translate.graphql`, `viewer.graphql`, `diary.graphql`).
     Codegen validates every operation against the schema, so an operation that asks for a field
     the schema no longer has fails here.
   - The `client` preset into `src/gql/`, with `fragmentMasking: false`: fragment fields are plain
     properties of the result types, and components use the generated fragment types directly
     (`frontend/app/src/lib/diary.ts` renames them to `DiaryEntry`, `DiaryThread`, …).
   - `enumsAsTypes: true`: GraphQL enums become string-literal unions (`"EN" | "ES" | "JA"`), not
     TypeScript `enum`s, which the frontend's `erasableSyntaxOnly` tsconfig forbids.
   - `strictScalars: true` with `scalars: { ISO8601DateTime: "string" }`: every custom scalar must
     be mapped explicitly (a new one fails codegen until it is), and datetimes arrive as ISO 8601
     strings that the client parses where it needs a `Date`.
   - `useTypeImports: true`.
5. **Committed output.** `frontend/app/src/gql/graphql.ts` holds the schema's types, one
   `…Query`/`…Mutation`/`…Variables`/`…Fragment` type per operation, and one `…Document` constant
   per operation (a `TypedDocumentNode`). `frontend/app/src/gql/gql.ts` and `index.ts` hold the preset's `graphql()`
   helper, which the app does not use: code imports the `…Document` constants and types from
   `frontend/app/src/gql/graphql.ts` directly.
6. **Stale-output check.** `bin/check frontend` runs `pnpm codegen` and fails if
   `git status --porcelain -- app/src/gql` shows any change ("frontend/app/src/gql is stale: run
   'pnpm codegen' in frontend/ and commit the result"). Then `pnpm typecheck` compiles every use of
   the generated types. CI runs `bin/check backend` and `bin/check frontend`
   (`.github/workflows/ci.yml`).

The result: a field renamed in Ruby fails the backend drift test until dumped; once dumped, it fails
codegen (if an operation still selects the old name) or the typecheck (if code still reads it). An
enum value added in Ruby breaks every exhaustive `switch` over that enum in the SPA until it is
handled (see [Exhaustive client messages](#exhaustive-client-messages)).

What the schema does **not** carry, and is therefore duplicated by hand on both sides:

- **Length limits.** Translation: 10,000 code points of source text, 2,000 of context
  (`Translation::Service::MAX_SOURCE_LENGTH` / `MAX_CONTEXT_LENGTH`; `MAX_SOURCE_LENGTH` /
  `MAX_CONTEXT_LENGTH` in `frontend/app/src/lib/translateLimits.ts`). Diary: 10,000 for a body,
  2,000 for a comment or question, 2,000 for a review (`Diary::Service`; `frontend/app/src/lib/diary.ts`).
  Both sides count Unicode code points (Ruby `String#length`; `codePointLength` in
  `frontend/app/src/lib/codePoints.ts`). The server is authoritative; the client's copy only drives
  counters and disables buttons early.
- **The language list's display names** (`frontend/app/src/lib/languages.ts`); the codes themselves
  come from the generated `Language` union.

## Changing the contract

A recipe for adding a field or a mutation end to end. Run everything from the repo root unless a
directory is given.

1. **Backend type.** Add the field to the type class (`backend/app/graphql/types/…`), or for a
   mutation:
   - an input type `Types::<Name>InputType < Types::BaseInputObject` with `graphql_name "<Name>Input"`,
   - a payload type (reuse `DiaryEntryPayload` / `DiaryThreadPayload` where the shape fits),
   - `Mutations::<Name> < Mutations::BaseMutation` (or `BaseDiaryMutation` for diary records) with
     `argument :input, Types::<Name>InputType` and `type <Payload>, null: false`,
   - a `field :<name>, mutation: Mutations::<Name>` line in `Types::MutationType`, with
     `complexity: 100` if it calls Claude (see [Limits](#limits)).

   Write a `description:` for anything whose meaning is not obvious from its name; it lands in
   the SDL and in the generated TypeScript doc comments. For a new input type, regenerate its
   Sorbet RBI with `bin/tapioca dsl Types::<Name>InputType` (in `backend/`); the repo keeps
   these under `backend/sorbet/rbi/dsl/types/`.
2. **Backend test.** Add an integration test under `backend/test/graphql/` that posts the operation
   (see [Testing both sides](#testing-both-sides-of-the-boundary)), including its failure cases.
3. **Dump.** `cd backend && bin/rails graphql:dump_schema`. Review the diff of
   `backend/schema.graphql`: it is the public face of your change. Removing or renaming a field, or
   making a nullable field non-null in an input (or non-null to nullable in an output), breaks the
   deployed client until it is redeployed — the SPA and API ship together in one image, but a
   browser tab loaded before a deploy keeps sending the old operations.
4. **Operation.** Add or change the operation in `frontend/app/src/graphql/*.graphql`. Give it a
   name (the fake server and the `ErrorLink` both key on `operationName`). In the diary, a mutation
   that returns an entry or thread selects the same fragment its query does, so Apollo's normalised
   cache updates both views in place (the header comment of `frontend/app/src/graphql/diary.graphql` says so).
5. **Codegen.** `cd frontend && pnpm codegen`. Use the new `…Document` and types from
   `frontend/app/src/gql/graphql.ts`.
6. **Client handling.** Handle the payload's typed `errors` and any top-level error codes the
   mutation can raise (see [The error model](#the-error-model)). If you added a `TranslateErrorCode`,
   give it a message in `translateErrorMessage` (and in `diaryErrorMessage` if the translation
   wording does not fit the diary) — the typecheck will insist.
7. **Fake server.** Add a handler for the new operation name to the fake that stands in for its
   feature (`frontend/app/src/test/fakeDiary.ts`, or the test's own `server.onGraphql(...)`), and
   return what the real server would: the same field names, `__typename` on every object, payload
   `errors` as an array. Renaming an operation means renaming its handler: an unhandled name throws
   "No fake handler for GraphQL …".
8. **Docs.** Update the feature's contract section (`docs/diary.md`'s "GraphQL contract", or
   `docs/phrases.md`) and the [operations index](#operations-index) below.
9. **Check and commit.** `bin/check` (both sides). Commit the Ruby change, `backend/schema.graphql`,
   the `.graphql` operation, the regenerated `frontend/app/src/gql/`, the fakes and the tests
   together, so every commit's schema, generated types and code agree.

## Schema conventions

- **Plain mutations, one input, one payload.** Mutations extend `Mutations::BaseMutation`, a
  `GraphQL::Schema::Mutation`, not the Relay `RelayClassicMutation`: no `clientMutationId`, and
  each mutation declares its own input object and payload type so the SDL reads exactly as
  designed. Every mutation takes a single non-null `input:` argument and returns a non-null
  payload.
- **Payloads carry the result and the anticipated errors side by side.** `TranslatePayload
  { translation, errors }`, `DiaryEntryPayload { entry, errors }`, `DiaryThreadPayload { thread,
  errors }`, `DiaryTopicsPayload { topics, errors }`. `errors` is always a non-null list; the result
  is null (or, for `topics`, empty) exactly when `errors` is non-empty. `DeleteDiaryEntryPayload
  { deletedId }` and `ResolveDiaryThread`'s payload never carry errors in practice: nothing they
  do can fail in an anticipated way.
- **Nullability means something.** Non-null is the default for fields that always exist; nullable
  fields say in their description when they are null (`reviewedBody`: "Null until the first
  review"; `startsAt`: "Null when it could not be located"; `furigana`, `notes`, `reading`). Kind-
  specific diary thread fields (`verdict`, `title`, `sentence`, `startsAt`, `length`) are nullable
  and documented with the kind they apply to. Optional input fields are nullable and, where an
  omitted value has a meaning, carry a default in the schema (`TranslateInput.glossLevel =
  NOTABLE`). graphql-ruby treats an explicit `null` for such an argument as null, not as the default,
  so `Mutations::Translate` coerces it back to the published default read from the argument
  itself (`TranslateInputType.gloss_level_default`) rather than tightening the schema.
- **Descriptions are part of the contract.** They appear in `backend/schema.graphql` and as doc comments in
  `frontend/app/src/gql/graphql.ts`, so a reader of either side sees them. Units and reference points are stated
  there (code points, which string an offset points into, ordering of lists).
- **Enums are Ruby `T::Enum`s underneath.** Each GraphQL enum value maps to a `T::Enum` instance
  (`value "JA", "Japanese", value: Translation::Language::JA`), so resolvers and services never see
  GraphQL strings. `TranslateErrorCode` is generated from `Translation::ErrorCode.values`, whose
  serialized values are the GraphQL names; its descriptions are fetched from a hash, so a new Ruby
  code without a description fails at boot. The other enums (`Language`, `GlossLevel`,
  `DiaryVerdict`, `DiaryThreadKind`, `DiaryAuthor`) list their values explicitly; their GraphQL
  names are upper case while the Ruby serialized values (stored in Postgres) are lower case.
- **Offsets are Unicode code points.** `Gloss.startsAt`/`length` index `Translation.text`;
  `DiaryThread.startsAt`/`length` index `DiaryEntry.reviewedBody`. JavaScript strings are UTF-16,
  so the client converts (`frontend/app/src/lib/codePoints.ts`, `Array.from` in the diary fake);
  astral characters such as 𠮟 are one code point but two UTF-16 units.
- **Datetimes** are `ISO8601DateTime` strings (graphql-ruby's built-in scalar).
- **Ids are opaque strings.** Every diary id the API exposes or accepts (`DiaryEntry.id`,
  `DiaryThread.id`, `DiaryComment.id`, `deletedId`, and every `id`/`entryId`/`threadId` input) is
  the record's `public_id`, a random UUID. Internal bigint keys never leave the database, so ids
  reveal nothing about how many records exist. `PublicId.parse` (`backend/app/models/public_id.rb`)
  accepts only UUID-shaped strings (case-insensitively) and returns nil otherwise, so **a malformed
  id behaves exactly like a missing one**: `diaryEntry(id:)` returns null and a mutation raises
  `NOT_FOUND`, never a database error. Another access code's id is indistinguishable from a
  missing one too. Clients must not parse or construct ids. (Codegen types `ID` inputs as
  `string | number` and outputs as `string`.)
- **Scoped by session, not by argument.** No operation takes an access code or user id; every
  resolver reads `context[:current_session]`, which `GraphqlController` fills from the cookie.

## The error model

Four layers, from most to least anticipated. A client handling a response checks them from the
bottom up: did the request reach GraphQL at all (HTTP), did execution fail (top-level `errors`),
did the operation fail in a way it anticipated (payload `errors`)?

### 1. Typed payload errors: anticipated failures

Every failure the backend can foresee is a `Translation::Error` with a `Translation::ErrorCode`,
rescued in the mutation and returned in the payload's `errors` list as a `TranslateError`:

```graphql
type TranslateError {
  code: TranslateErrorCode!    # one of 13 codes, below
  message: String!             # safe, user-facing English
  retryable: Boolean!          # whether trying again may succeed
  retryAfterSeconds: Int       # when known
}
```

The response is HTTP 200 with `data` present and no top-level `errors`. The diary reuses the type
(and its name) so the Phrases and Diary pages share codes, limits and wording.

| Code | Meaning | `retryable` |
| --- | --- | --- |
| `EMPTY_INPUT` | Text is blank (no Claude call) | no |
| `INPUT_TOO_LONG` | Over a length limit (no Claude call) | no |
| `SAME_LANGUAGE` | Source and target, or writing and notes language, are the same | no |
| `RATE_LIMITED` | This session or access code is over its limit of Claude calls (translations and tutor calls share it); `retryAfterSeconds` set | yes |
| `TIMEOUT` | Claude took too long | yes |
| `UPSTREAM_RATE_LIMITED` | Claude is rate-limiting us | yes |
| `UPSTREAM_OVERLOADED` | Claude is overloaded | yes |
| `UPSTREAM_ERROR` | Claude returned a server error | yes |
| `UPSTREAM_UNREACHABLE` | Claude could not be reached | yes |
| `BUDGET_EXCEEDED` | The demo's usage budget is spent | no |
| `SERVICE_MISCONFIGURED` | The server's Claude credentials or settings are wrong | no |
| `REFUSED` | Claude declined | no |
| `OUTPUT_TOO_LONG` | The answer was too long to finish | no |

The codes' descriptions in `backend/schema.graphql` (from `Types::TranslateErrorCodeType`) and the
server's `message` for a failure either feature can meet (the rate limits, Claude's transport and
configuration failures) name neither feature. Messages raised by one feature's own code, such as
`ClaudeTranslator`'s "Claude declined to translate this text.", stay specific to it.

`retryable` is computed from the code (`Translation::ErrorCode#retryable?`), not set per error.
The client shows its own message per code rather than `message`, except for `RATE_LIMITED`, where
`message` says which limit was hit and the client appends the wait. The Phrases page offers "Try
again" only when `retryable` is true and there is no known wait still to run.

### 2. Top-level GraphQL errors: refusals and the unexpected

These arrive in the standard `errors` array with `extensions.code`. For mutations, whose payload
fields are non-null, `data` is `null`.

| `extensions.code` | HTTP | Raised by | Meaning |
| --- | --- | --- | --- |
| `UNAUTHENTICATED` | 401 | `GraphqlController#require_session` | No valid session: none, expired (12 h), or its access code revoked or expired. Body: `{"errors":[{"message":"Not signed in","extensions":{"code":"UNAUTHENTICATED"}}]}` |
| `NOT_FOUND` | 200 | `BaseDiaryMutation#not_found!` | A diary mutation's id is missing, malformed or another code's, or the record was deleted while the tutor was answering. `requestDiaryHint` on a non-HELP thread is also `NOT_FOUND`. |
| `INVALID` | 200 | `BaseDiaryMutation#invalid!` | `updateDiaryEntry` tried to change the languages of an entry that has had feedback or a help thread; or a tutor mutation (`reviewDiaryEntry`, `startDiaryHelpThread`, `replyToDiaryThread`, `requestDiaryHint`) got its answer for a language pair the entry no longer has ("The languages changed while Claude was answering — try again."; nothing saved). The `message` says which. |
| `INTERNAL` | 200 | the schema's `rescue_from(StandardError)` | Anything nobody planned for. `message` is "Something unexpected went wrong."; `extensions.reference` is 8 hex characters, logged with the exception as `GraphQL INTERNAL ref=<reference>` so a user's report can be found in the logs. Details never reach the client. |

Validation errors (a query over the complexity or depth limit, an unknown field, a bad enum value
such as `targetLanguage: FR`) are also top-level errors, with no `extensions.code`. The SPA's own
operations never produce them, because codegen validated them against the same schema.

`GraphqlController` itself answers HTTP 400 with a GraphQL-shaped body (`{"errors":[{"message":…}]}`,
no code) when `query` is not a string or `variables` is not a JSON object.

### 3. HTTP-level failures: before GraphQL runs

Rack middleware and controller `before_action`s can refuse a request before it reaches the schema.
Their bodies are plain JSON, not GraphQL-shaped. In the order they run:

| Status | Body | From | Cause |
| --- | --- | --- | --- |
| 429 | `{"error":"rate_limited","retryAfterSeconds":N}` + `Retry-After` | rack-attack throttles | Over 60 `/graphql` requests a minute from one IP, or the sign-in throttles |
| 429 | `{"error":"too_many_failed_attempts","retryAfterSeconds":N}` + `Retry-After` | rack-attack blocklist | IP banned from `POST /api/session` after repeated failed codes |
| 411 | `{"error":"length_required"}` | `RequestSizeLimit` | A `Transfer-Encoding` header (a chunked body without `Content-Length`); browsers' `fetch`, curl and `bin/smoke` never send one, and under Puma it never reaches Rails (Puma decodes chunked bodies itself) |
| 413 | `{"error":"payload_too_large"}` from `RequestSizeLimit`; under Puma, usually Puma's own plain 413 first | `RequestSizeLimit`, and Puma's `http_content_length_limit` (`backend/config/puma.rb`) | A body over 64 KB (the client tolerates the non-JSON body) |
| 415 | `{"error":"unsupported_media_type"}` | `RequestOriginCheck` | A non-GET/HEAD request whose media type is not `application/json` |
| 403 | `{"error":"forbidden_origin"}` | `RequestOriginCheck` | A non-GET/HEAD request whose `Origin` header is missing or not the app's own |
| 401 | `UNAUTHENTICATED` (GraphQL-shaped, above) | `GraphqlController` | No session (only on `/graphql`) |
| 401 | `{"error":"invalid_code"}` | `Api::SessionsController#create` | Wrong, revoked, expired, missing, non-string or over-100-character access code |

In production Rails also refuses requests for a host other than `APP_HOST` (DNS-rebinding
protection; `/up` exempt), which the app itself never triggers.

### 4. Network failures

`fetch` rejects (offline, DNS, connection reset): no status, no body.

### How the client classifies failures

`frontend/app/src/lib/requestFailure.ts` turns everything outside the typed payload errors into one
`RequestFailure`:

```ts
type RequestFailure =
  | { kind: "unauthenticated" }
  | { kind: "notFound" }
  | { kind: "invalid"; message: string | null }
  | { kind: "rateLimited"; retryAfterSeconds: number | null }
  | { kind: "blocked" }
  | { kind: "payloadTooLarge" }
  | { kind: "internal"; reference: string | null }
  | { kind: "network" }
  | { kind: "server"; status: number };
```

- `describeRequestError(error)` takes what Apollo threw:
  - `CombinedGraphQLErrors` (top-level GraphQL errors): by `extensions.code`, checked in this
    order across all the errors — `UNAUTHENTICATED` → `unauthenticated`, `NOT_FOUND` → `notFound`,
    `INVALID` → `invalid` — and otherwise `internal`, carrying the first `extensions.reference`
    found (null when there is none, as for a validation error, which has no code).
  - `ServerError` (a non-2xx response): `failureFromResponse(status, bodyText, Retry-After)`.
  - Anything else: `network`.
- `failureFromResponse` maps 401 → `unauthenticated`; 403, 411 and 415 → `blocked` (the Origin,
  size-header and content-type checks; a reload is the fix); 413 → `payloadTooLarge`; 429 → `rateLimited`, reading
  `retryAfterSeconds` from the JSON body, else the `Retry-After` header, else null; everything else
  (400, 5xx, a 404 from a misrouted request) → `server` with its status. Unparseable bodies are
  tolerated.
- The 401 from `/graphql` is classified as `unauthenticated` whichever way Apollo surfaces it — as a
  `ServerError` by status, or as `CombinedGraphQLErrors` by its code.
- Only the diary can meet `notFound` and `invalid`. `failureMessage` has generic sentences for
  them ("That no longer exists.", and for `invalid` the server's message when it carries one,
  else "That change isn't allowed."); the diary's `reportFailure` in
  `frontend/app/src/pages/DiaryPage.tsx` says "This entry doesn't exist any more." for `notFound`
  and shows the server's sentence for `invalid`, since `INVALID` has more than one reason. An autosave
  that lands after its entry was deleted drops its `notFound` silently. `diaryEntry(id:)`, a
  query, returns null for a missing entry instead of raising.
- `unauthenticated` is never toasted by a page: the `ErrorLink` has already sent the app back to the
  access-code screen (see [Transport and auth](#transport-and-auth)).

`signIn` in `frontend/app/src/lib/session.ts` treats a 401 from `POST /api/session` as the ordinary
`{ ok: false, reason: "invalidCode" }`, not as a session failure, and every other failure as a
`RequestFailure` via `failureFromResponse`.

### Exhaustive client messages

Every user-facing sentence for a failure comes from a `switch` that ends in `assertNever`
(`frontend/app/src/lib/assertNever.ts`), so a new case fails the typecheck until it has words:

- `translateErrorMessage(code, retryAfterSeconds, serverMessage)`
  (`frontend/app/src/lib/translateErrorMessage.ts`): one message per `TranslateErrorCode`, over
  the generated union type. A code added to the Ruby enum and dumped breaks the build here.
- `diaryErrorMessage(error)` (`frontend/app/src/pages/DiaryPage.tsx`): the diary's wording for the
  six codes whose translation wording would be wrong (`EMPTY_INPUT`, `INPUT_TOO_LONG` — naming all
  three diary limits, `SAME_LANGUAGE`, `REFUSED`, `OUTPUT_TOO_LONG`, `TIMEOUT`), delegating the rest
  to `translateErrorMessage`.
- `failureMessage(failure)` (`frontend/app/src/lib/failureMessage.ts`): one message per
  `RequestFailure.kind`; `internal` includes the reference when there is one ("Something unexpected
  went wrong (reference 1a2b3c4d).").

## Limits

Set on the schema (`backend/app/graphql/contextual_translate_schema.rb`) and around it:

| Limit | Value | Where | Why |
| --- | --- | --- | --- |
| Query depth | 15 | `max_depth` | Bounds nesting; the diary's deepest selection (entry → threads → comments) fits comfortably |
| Query size | 5,000 tokens | `max_query_string_tokens` | Rejects huge query strings before validation work |
| Complexity | 150 | `max_complexity` | One Claude call (100) plus ordinary fields |
| Claude-calling fields | complexity 100 each | `Types::MutationType` | `translate`, `reviewDiaryEntry`, `startDiaryHelpThread`, `replyToDiaryThread`, `requestDiaryHint`, `suggestDiaryTopics` |
| Validation errors reported | 100 | `validate_max_errors` | |
| Request body | 64 KB | `RequestSizeLimit` (`Content-Length`; a chunked body is refused with 411 rather than read to measure it) | Fits the largest valid request (10,000 + 2,000 characters even as 3-byte UTF-8) with room to spare |
| `/graphql` requests | 60 per minute per IP | `backend/config/initializers/rack_attack.rb` | A coarse cap only |
| Sign-in | 5 per minute and 20 per hour per IP; 10 failures in 10 minutes bans the IP for 10 minutes | `backend/config/initializers/rack_attack.rb`, `backend/lib/login_ban.rb` | Brute-forcing access codes |
| Claude calls | per session and per access code | `Translation::RateLimiter`, inside the mutations | Returned as the typed `RATE_LIMITED` error, not an HTTP 429 |

The complexity arithmetic is the important one: two Claude-calling fields in one request cost at
least 200, over the 150 limit, so **one request makes at most one Claude call** of any kind.
Without it, aliases (`a: translate(…) b: translate(…)`) would batch many expensive calls behind one
rate-limiter check and one rack-attack count. The rejected request is a top-level validation error
mentioning complexity, and nothing executes (`backend/test/graphql/translate_mutation_test.rb` and
`backend/test/graphql/diary_test.rb`
assert no call was made). The diary test also asserts that the SPA's full selections — a review
returning the whole entry, and the entry list — stay inside the complexity and depth limits; a
bigger selection in `frontend/app/src/graphql/diary.graphql` should keep that test honest.

The per-IP GraphQL cap sits in rack-attack because it must run before any work; the real Claude
limits live inside the mutations because only there can they answer with a typed, retryable error
that names the limit.

## Transport and auth

### Same origin

The browser only ever talks to one origin. In production Rails serves the built SPA
(`SpaController` renders `spa/index.html` for every HTML path; hashed assets come from `public/`)
beside the API. In development the browser talks to Vite on `:5173`, which proxies `/graphql`,
`/api` and `/up` to Rails on `:3000` (`frontend/app/vite.config.ts`), so cookies and the Origin
check behave exactly as in production. There is no CORS configuration
(`backend/config/initializers/cors.rb` is the commented-out default), and the SPA's
Content-Security-Policy allows `connect-src 'self'` only.

### The session cookie

- An encrypted, signed Rails cookie store session, `_contextual_translate_session`: `HttpOnly`,
  `SameSite=Strict`, `Secure` in production, `expire_after: 12.hours`
  (`backend/config/application.rb`).
- The session holds the access code's id, the sign-in time and a random session key (the key for
  per-session rate limits). Every request reloads the access code, so revoking or expiring it ends
  the session on the next request; sessions also end 12 hours after sign-in whatever the cookie
  says (`backend/app/controllers/concerns/authentication.rb`). See
  [docs/backend.md](backend.md) for the details.
- The SPA never sees the cookie. Whether it is signed in is something it learns by asking.

### State-changing requests: JSON plus Origin

Rails' token-based CSRF protection is not used; no request carries a token. Instead
(`backend/app/controllers/concerns/request_origin_check.rb`), every request except GET and HEAD
must:

1. be `Content-Type: application/json` — which a plain HTML form cannot send (415 otherwise), and
2. carry an `Origin` header equal to the app's own origin (`config.x.allowed_origin`:
   `https://$APP_HOST` in production, `http://$APP_HOST` or `http://localhost:5173` in development,
   `http://www.example.com` in tests) — 403 otherwise, logged.

Together with `SameSite=Strict`, another site can neither make the browser send the cookie nor
make a request the server accepts. Browsers send `Origin` on every same-origin `fetch` POST and
DELETE, and Apollo's `HttpLink` sends JSON, so the SPA satisfies both without doing anything.
A hand-made request (curl, `bin/smoke`) must add both headers; see `README.md` for examples.

The order of checks on a controller request is size (411/413), then media type (415), then Origin
(403), then — on `/graphql` — session (401). rack-attack (429) runs before all of them, in Rack.

### `POST /api/session` and `DELETE /api/session`

Sign-in is REST, not a GraphQL mutation, so rack-attack can throttle it by path before any Rails
code runs (`backend/app/controllers/api/sessions_controller.rb`).

`POST /api/session` with `{"code": "ctx-…"}`:

| Status | Body | When |
| --- | --- | --- |
| 204 | none, plus `Set-Cookie` | The code is valid. The session is reset first (new id: no fixation), then filled. |
| 401 | `{"error":"invalid_code"}` | Unknown, revoked, expired, missing, non-string or longer than 100 characters. Counts toward the IP's ban. |
| 429 | `{"error":"rate_limited",…}` / `{"error":"too_many_failed_attempts",…}` | Throttled or banned |
| 403 / 411 / 413 / 415 | as above | Origin, size or content type |

`DELETE /api/session` resets the session and answers 204, signed in or not. Only the server can
clear the `HttpOnly` cookie, so `signOut()` treats the user as signed out only on a 2xx; anything
else leaves them signed in with a toast. Before signing out the SPA flushes pending diary
autosaves, which would otherwise be refused once the session is gone.

The `code` and `variables` parameters are filtered from the Rails logs
(`backend/config/initializers/filter_parameter_logging.rb`): access codes and the learner's text
never reach them.

### The `Viewer` query restores the session

There is no "am I signed in?" endpoint. On load, and whenever the app restarts its session
(after sign-in, sign-out, or a session ending mid-use), `SessionBoundary` in
`frontend/app/src/App.tsx` runs the `Viewer` query with `fetchPolicy: "network-only"`:

- data → signed in; the app renders.
- `unauthenticated` → the access-code screen (`AccessGate`), with "Your session ended…" when the
  session ended mid-use rather than on first load.
- any other failure → a status screen with the `failureMessage` and a retry button.

### Apollo Client and the `ErrorLink`

`createApolloClient` (`frontend/app/src/lib/apollo.ts`) builds the one client: an `HttpLink` to
`/graphql` with `credentials: "same-origin"`, an `InMemoryCache`, and an `ErrorLink` in front of it.
The `ErrorLink` watches every operation's errors: if `isUnauthenticated(error)` and the operation is
not `Viewer`, it calls `onUnauthenticated`, which in `App` marks the session ended and remounts
`SessionBoundary` (whose `Viewer` query then routes to the access-code screen). `Viewer` is excluded
because its 401 is how the app learns it is signed out in the first place, and `SessionBoundary`
handles it directly. After a deliberate sign-out, a request still in flight that comes back 401 is
ignored rather than reported as "session ended". On sign-out the client's store is cleared.

The `ErrorLink` does not swallow the error: the operation still rejects, and the page that sent it
sees `unauthenticated` and stays quiet.

## Operations index

Every field of `Query` and `Mutation` in `backend/schema.graphql`, with the operation name the SPA
sends it under. **C** marks a Claude call (complexity 100).

### Session

| Field | SPA operation | |
| --- | --- | --- |
| `viewer: Viewer!` | `Viewer` (`frontend/app/src/graphql/viewer.graphql`) | The signed-in session: access code label, its expiry, the session's expiry. Session restore. |
| — | `POST /api/session` / `DELETE /api/session` | Sign in with an access code / sign out (REST, above). |

### Phrases ([docs/phrases.md](phrases.md))

| Field | SPA operation | |
| --- | --- | --- |
| `translate(input: TranslateInput!): TranslatePayload!` **C** | `Translate` (`frontend/app/src/graphql/translate.graphql`) | Translate text with context into a `Translation` (text, notes, furigana, glosses) or typed errors. |

### Diary ([docs/diary.md](diary.md))

| Field | SPA operation | |
| --- | --- | --- |
| `diaryEntries: [DiaryEntry!]!` | `DiaryEntries` | This access code's entries, newest first (the scrollback; summary fields only). |
| `diaryEntry(id: ID!): DiaryEntry` | `DiaryEntry` | One entry with its threads and comments; null when missing, malformed or another code's. |
| `createDiaryEntry(input): DiaryEntryPayload!` | `CreateDiaryEntry` | A new, empty entry with a language pair. |
| `updateDiaryEntry(input): DiaryEntryPayload!` | `SaveDiaryEntry` | Autosave the body and/or change the language pair (`INVALID` once it has had feedback or help). |
| `deleteDiaryEntry(input): DeleteDiaryEntryPayload!` | `DeleteDiaryEntry` | Delete an entry with its threads and comments; returns `deletedId`. |
| `reviewDiaryEntry(input): DiaryEntryPayload!` **C** | `ReviewDiaryEntry` | Save the body and get sentence-by-sentence feedback. |
| `startDiaryHelpThread(input): DiaryThreadPayload!` **C** | `StartDiaryHelpThread` | Open a "Help me say…" thread with its first hint. |
| `replyToDiaryThread(input): DiaryThreadPayload!` **C** | `ReplyToDiaryThread` | The learner's follow-up and the tutor's reply. |
| `requestDiaryHint(input): DiaryThreadPayload!` **C** | `RequestDiaryHint` | The next, more revealing hint on a HELP thread. |
| `resolveDiaryThread(input): DiaryThreadPayload!` | `ResolveDiaryThread` | Resolve a thread, or reopen it. |
| `suggestDiaryTopics(input): DiaryTopicsPayload!` **C** | `SuggestDiaryTopics` | Three ideas to write about, or follow-ups to the draft; not stored. |

Note the one operation whose name differs from its field: `SaveDiaryEntry` calls
`updateDiaryEntry` (it selects only what an autosave can change). Test fakes key on the operation
name.

## Testing both sides of the boundary

### Backend: post real GraphQL

Integration tests talk to the API the way the browser does. `SessionHelpers`
(`backend/test/support/session_helpers.rb`) provides `post_json`/`delete_json` (JSON body plus the
test origin `http://www.example.com`), `sign_in` (creates an access code and posts it to
`/api/session`, keeping the cookie), and `graphql(query, variables:)`, which posts to `/graphql` and
returns the parsed body. So every GraphQL test also passes through the size, content-type, Origin
and session checks.

- `backend/test/graphql/translate_mutation_test.rb`, `backend/test/graphql/diary_test.rb`,
  `backend/test/graphql/viewer_query_test.rb`:
  operations end to end against the fake translator and tutor (`backend/test/test_helper.rb` sets `TRANSLATOR=fake`), payload
  errors, `NOT_FOUND`/`INVALID`, malformed and foreign ids, `INTERNAL` with a reference, the
  complexity cap, and N+1-free loading of the entry list.
- `backend/test/integration/graphql_endpoint_test.rb`: the controller — 401 `UNAUTHENTICATED`
  without a session, 400 for bad `query`/`variables`, no `/graphql.json`.
- `backend/test/integration/sessions_test.rb`: sign-in and sign-out, the cookie's flags, Origin and
  content-type rejection, revocation and expiry, log filtering.
- `backend/test/integration/request_size_limit_test.rb` and
  `backend/test/integration/rack_attack_test.rb`: the 64 KB limit
  (and the 411 for a chunked body) and the throttles, including path-spelling variants.
- `backend/test/lib/graphql_schema_dump_test.rb`: the committed schema matches the Ruby schema.

### Frontend: a fake server behind `fetch`

Frontend tests run the real Apollo client, `ErrorLink` and session helpers against
`installFakeServer()` (`frontend/app/src/test/fakeServer.ts`), which stubs the global `fetch`:

- `server.onGraphql(operationName, handler)` answers `/graphql` requests by the request body's
  `operationName`; `server.onSession("POST" | "DELETE", handler)` answers `/api/session`. Any other
  request, or an operation with no handler, throws, so a test cannot silently hit an unmodelled
  endpoint. `server.requests` records every call for assertions.
- `json(body, status, headers)` builds a response; `unauthenticated()` is the controller's exact
  401 body; `viewer()` a signed-in `Viewer` result.
- `installFakeDiary(server, entries)` (`frontend/app/src/test/fakeDiary.ts`) registers a handler for
  every diary operation over an in-memory list: enough behaviour (reviews that split sentences and
  compute code-point spans, superseded threads, the backend's preview rule, hint levels with
  `Diary::FakeTutor`'s clarifying first answer to a "want" question, `INVALID`, `SAME_LANGUAGE`)
  that the page's queries, mutations and cache updates run end to end. `notFound()` and
  `invalid()` return the real server's `NOT_FOUND` and `INVALID` shapes (HTTP 200, `data: null`).
  Like the server, it issues random UUIDs for ids; fixtures (`frontend/app/src/test/diaryFixtures.ts`)
  do too, with fixed UUID literals in named constants wherever a test asserts on an id.
- Failure cases are built from the same shapes the backend sends: payload `errors` with a code,
  top-level errors with `extensions.code`, and plain JSON 403/413/429 bodies with `Retry-After`
  (see `frontend/app/src/lib/requestFailure.test.ts`, `frontend/app/src/pages/TranslatePage.test.tsx`,
  `frontend/app/src/App.test.tsx`).

### Keeping the fakes honest

The fakes are hand-written, so the types do not police everything they return. The rules:

- **Return what the operation selects, with `__typename` on every object.** Apollo's cache
  normalises on `__typename` + `id`; a fake without them tests a different cache behaviour than
  production. The real server adds `__typename` because Apollo asks for it in every selection set.
- **Build fixtures from the generated types.** `frontend/app/src/test/fakeDiary.ts` and
  `frontend/app/src/test/diaryFixtures.ts` are typed with
  `DiaryEntry`/`DiaryThread` (the generated fragment types), so a field added to or removed from a
  fragment fails the typecheck in the fakes too. Inline `json({...})` responses in tests are not
  checked this way — keep them in step with the operation by hand.
- **Mirror the transport, not just the data.** A top-level error is HTTP 200 with `errors`; a
  session failure is HTTP 401; rack-attack is a plain JSON 429. Returning the wrong status tests a
  different branch of `describeRequestError`.
- **Rename handlers with operations.** Handlers are keyed by operation name, not field name.
- **When the backend's behaviour changes, change the fake in the same commit**, and add the backend
  integration test that pins the real behaviour, so the two are checked against the same
  description (the feature's doc).

### Against a running server

`bin/smoke ACCESS_CODE [BASE_URL]` checks a real deployment with curl the way the browser does:
cookie jar, JSON bodies, the app's `Origin`. It checks `/up`, signs in (204), runs `viewer` (200),
runs a `translate` and fails on any payload error, creates a diary entry, reads it back with
`diaryEntry` and deletes it (no tutor call, so no Claude cost), signs out (204), and checks that
`viewer` is then 401. `README.md` covers running it against development, Rails directly (`ORIGIN=…`) and
production.
