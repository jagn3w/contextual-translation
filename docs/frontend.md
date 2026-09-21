# Frontend

The single-page app in `frontend/app`: Vite, React 19 and TypeScript, talking to the Rails API over
GraphQL (plus one JSON endpoint for the session). This file is the frontend's architecture and the
conventions the code follows. The features themselves are in [phrases.md](phrases.md) and
[diary.md](diary.md), the Rails side in [backend.md](backend.md), and the GraphQL schema as a type
contract (schema dump, drift test, codegen, error model, ids) in
[api_boundary.md](api_boundary.md).

## Toolchain and workspace

- `frontend/` is a pnpm workspace with one package, `app` (`frontend/pnpm-workspace.yaml`). The
  root `frontend/package.json` pins `packageManager: pnpm@10.33.2`, requires Node `>=22`, and
  forwards `dev`, `build`, `test`, `typecheck` and `codegen` to the app with `pnpm --filter app`.
  `mise.toml` pins the same Node 22 and pnpm for machines outside the dev container.
- `onlyBuiltDependencies` in `pnpm-workspace.yaml` lists the only packages allowed to run install
  scripts: `esbuild` and `@tailwindcss/oxide`, which ship native binaries. Anything else that wants
  a postinstall is refused — a supply-chain guard. A new dependency that genuinely needs one is
  added to that list on purpose.
- Runtime dependencies are deliberately few: `@apollo/client` (with `graphql` and `rxjs`), three
  Radix primitives (`react-popover`, `react-select`, `react-tooltip`) and `sonner` for toasts.
  There is no router, state library or component kit.
- TypeScript is strict beyond `strict` (`frontend/app/tsconfig.app.json`): `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and `erasableSyntaxOnly` among others.
  `erasableSyntaxOnly` rules out TypeScript `enum`s, which is why codegen emits GraphQL enums as
  string unions. Imports spell the `.ts`/`.tsx` extension (`allowImportingTsExtensions`).
  `tsconfig.node.json` covers `vite.config.ts`; `tsconfig.json` only references the two.

## Dev server and the one-origin rule

`bin/dev` starts Postgres, Rails on :3000 and Vite on :5173, and you open
`http://localhost:5173`. `pnpm dev` in `frontend/` starts Vite alone. Vite
(`frontend/app/vite.config.ts`) proxies three path prefixes to Rails (`RAILS_URL`, default
`http://127.0.0.1:3000`):

| Prefix | What |
|---|---|
| `/api` | the session endpoint (`POST`/`DELETE /api/session`) |
| `/graphql` | every query and mutation |
| `/up` | Rails' health check, so `bin/smoke` pointed at Vite checks Rails, not the SPA fallback |

The point is that the browser only ever sees **one origin**, in development exactly as in
production, where Rails serves the built files itself. Two things depend on it:

- **The session cookie** is `HttpOnly` and `SameSite=Strict`. On one origin it travels with every
  request automatically; the client sends `credentials: "same-origin"` and never handles the
  cookie itself.
- **The Origin check.** Rails rejects a state-changing request unless it is JSON and its `Origin`
  header equals the app's own origin (`APP_HOST`; `bin/dev` sets it to `localhost:5173`). The proxy
  runs with `changeOrigin: false`, so the browser's own `Origin` reaches Rails untouched.

There is no CORS configuration and no API base URL in the frontend: every request is a relative
path.

## App structure

`frontend/app/src/main.tsx` renders `<App />` under `StrictMode` into `#root` and imports `index.css`. From
there (`frontend/app/src/App.tsx`):

```
App                  owns the Apollo client, the Toaster and the session epoch
└─ SessionBoundary   key={epoch}; runs the Viewer query
   ├─ StatusScreen   "Loading…", or a failure with Try again
   ├─ AccessGate     the access-code form (Viewer came back unauthenticated)
   └─ SignedIn       subscribes to the route
      └─ AppShell    header: title, Phrases / Diary links, Sign out
         ├─ TranslatePage  (always mounted; hidden when not current)
         └─ DiaryPage      (mounted only on /diary…)
```

- **Restoring the session.** There is nothing in `localStorage`; on load `SessionBoundary` runs the
  `Viewer` query (`frontend/app/src/graphql/viewer.graphql`) with `fetchPolicy: "network-only"`. Data back means
  signed in; an `UNAUTHENTICATED` error means show the gate; any other failure is a `StatusScreen`
  with a retry. The page shows nothing from the viewer — reaching `SignedIn` is what says there is
  a session.
- **The epoch.** `App` keeps a counter and uses it as `SessionBoundary`'s `key`. Bumping it
  remounts the whole signed-in tree, which re-runs `Viewer` and throws away every page's local
  state. It is bumped on sign-in, on sign-out, and when any operation reports the session is gone.
- **Signing in** is a plain `fetch` to `POST /api/session` (`frontend/app/src/lib/session.ts`). A 401 there means
  a wrong code (`invalidCode`), not an ended session.
- **Signing out** (`handleSignOut`) first awaits `flushAutosaves()` so diary drafts reach the
  server while the session still exists, then `DELETE /api/session`. Only a 204 counts: the cookie
  is `HttpOnly`, so only the server can clear it, and on any failure the app stays signed in and
  toasts why. On success it forgets unsaved drafts, clears the Apollo store and restarts.
- **Session ended versus signed out.** When an operation other than `Viewer` fails
  unauthenticated, the client's `onUnauthenticated` callback sets `sessionEnded` and bumps the
  epoch, and the gate says "Your session ended. Enter the access code again." A deliberate
  sign-out sets a `signedOut` ref that suppresses this until the next sign-in: a request that was
  still in flight when the session was deleted comes back refused, and that is no news to someone
  who just signed out.

## Routing

`frontend/app/src/lib/router.ts` is the whole router, about 100 lines over `history`. Rails serves the SPA for
every HTML path, so paths are real URLs — reloadable, bookmarkable, back-button-able.

- `Route` is `{ page: "phrases" }` or `{ page: "diary"; entryId: string | null }`. `parseRoute`
  maps `/diary` and `/diary/<id>` (trailing slash allowed) to the diary and **everything else to
  Phrases**, the landing page, rather than a 404. A malformed escape (`/diary/%ZZ`) is kept raw
  instead of throwing, and then behaves as an id no entry has. `routePath` is the inverse and
  URI-encodes the id.
- `useRoute()` reads `window.location.pathname` through `useSyncExternalStore`, subscribed to
  `popstate` (back/forward) and to a custom `app:navigated` event, because `pushState` fires none
  of its own.
- `navigate(path, { replace })` pushes (or replaces, for a redirect the back button shouldn't land
  on) and dispatches `app:navigated`. Navigating to the current path is a no-op.
- **Links are real `<a href>`s** with `onClick={handleLinkClick}`. Only a plain, unmodified left
  click on a link without a foreign `target` is taken over; a modified or middle click, or one
  already handled, is left to the browser, so open-in-new-tab and copy-link work. The current page
  is marked `aria-current="page"`, and the styling keys on that attribute (`aria-[current=page]:`),
  so what a screen reader is told and what is drawn can't disagree. `AppShell` and the diary's
  `EntryList` follow this pattern.
- Only `SignedIn` subscribes to the location, so navigating re-renders the pages without re-asking
  the server who we are.
- **Phrases stays mounted** while the diary is open, inside `<div hidden>`: a translation and its
  draft are in-memory state, and a trip to the diary and back shouldn't cost them. The diary
  mounts only on its routes; its drafts are protected by autosave instead (below).

## Data layer

- `frontend/app/src/lib/apollo.ts` builds one `ApolloClient` per `App`: an `HttpLink` to `/graphql` with
  `credentials: "same-origin"`, behind an `ErrorLink` that calls `onUnauthenticated` for any
  operation except `Viewer` whose error classifies as unauthenticated (for `Viewer`, a 401 is how
  the app learns it is signed out in the first place). The cache is a default `InMemoryCache`.
- **Typed documents.** Operations live in `frontend/app/src/graphql/*.graphql` (`viewer`, `translate`, `diary`).
  `pnpm codegen` generates `frontend/app/src/gql/` from them and the committed `backend/schema.graphql`, and the
  code imports the `…Document` constants and types from `frontend/app/src/gql/graphql.ts`. Fragment masking is
  off, so a fragment's fields are simply on the result. Generated output is committed and
  `bin/check frontend` fails if it is stale. See [api_boundary.md](api_boundary.md) for the
  config and the contract.
- **Leaning on the normalised cache.** Diary objects (entries, threads, comments) carry
  `__typename` and `id`, so Apollo merges a mutation's result into every query that holds the same
  object. (A translation has no id and lives in the Phrases page's own state; see
  [phrases.md](phrases.md).) The diary uses this on
  purpose (`frontend/app/src/pages/DiaryPage.tsx`): each mutation selects the same fields its query does, so a
  save updates the list's preview, a review replaces the entry's threads and a reply updates its
  thread without any code. Only changes to *which* objects exist are written by hand in `update`:
  a created entry prepended to the list (and written as its own `DiaryEntry` query, so opening it
  is a cache hit), a new help thread appended to its entry, a deleted entry filtered out, its
  `DiaryEntry` query written as `null` and the object evicted.
- The domain shapes the components use are the generated fragment types renamed
  (`frontend/app/src/lib/diary.ts`), so a field a component reads is a field an operation fetches.
- `Translate` is a `useMutation` in the page; the diary calls `client.mutate` from one memoised
  `actions` object that `DiaryView` and its children receive as props.

## Error handling

A request fails in one of two ways, and each has one place that words it.

1. **Outright failures** — a top-level GraphQL error, an HTTP error from the session endpoint,
   rack-attack's 429, the Origin/content-type check's 403/415, a 413, a network error.
   `frontend/app/src/lib/requestFailure.ts` classifies them into the `RequestFailure` union
   (`unauthenticated`, `rateLimited` with `retryAfterSeconds`, `blocked`, `payloadTooLarge`,
   `internal` with a server `reference`, `network`, `server` with a status):
   `describeRequestError` for anything Apollo throws, `failureFromResponse` for a raw `Response`.
   `frontend/app/src/lib/failureMessage.ts` turns one into a sentence.
2. **Anticipated failures** — the typed `errors: [TranslateError!]!` in a mutation's payload.
   `frontend/app/src/lib/translateErrorMessage.ts` words each `TranslateErrorCode` for Phrases;
   `diaryErrorMessage` in `frontend/app/src/pages/DiaryPage.tsx` rewords the codes whose translation wording
   would be wrong for a diary (the input checks, `REFUSED`, `OUTPUT_TOO_LONG`, `TIMEOUT`) and
   defers to `translateErrorMessage` for the rest, so "Claude is busy" reads the same on both
   pages. The diary also maps two top-level codes it raises on purpose, `NOT_FOUND` and
   `INVALID`, to their own sentences rather than "Something unexpected went wrong".

Every one of these is an exhaustive `switch` ending in `assertNever` (`frontend/app/src/lib/assertNever.ts`):
a new failure kind or a new error code in the schema breaks the build until it has a message.
Retry-after durations are worded by `formatWait` ("in 45 seconds").

**Toasts.** Failures surface as `sonner` toasts from the one `<Toaster>` in `App`
(bottom-centre, close button, 8 s). An unauthenticated failure is never toasted — the app is
already returning to the gate. Two conventions about toast ids:

- A toast id groups messages that should *replace* each other. Every diary autosave failure uses
  the id `diary-save`, so a flaky connection shows one message, not a stack.
- An id must not be reused where it would carry the wrong options: sonner merges an update into
  the existing toast, so Phrases gives each translation attempt its own id
  (`translate-error-<n>`), or a retryable toast's "Try again" action would survive into a later,
  non-retryable error. The page dismisses its last error toast when it unmounts (for example on
  sign-out), so a Try again never outlives the page it would act on.

A failed diary action saves nothing on the server; its action resolves `false` or `null` and the
component that asked keeps the learner's text in place to try again.

## Shared hooks and helpers (`frontend/app/src/lib`)

- **`useAutosave(value, save, delay = 800, savedValue)`** saves a pause after the last edit, **one
  request at a time**: an edit made while a save is in flight is sent by a follow-up save once it
  lands, never by a second racing request, so the server can't end up older than the screen. Its
  `state` reads `saving` from the first dirty keystroke (never "Saved" beside unsent words),
  `saved`, or `error` until the next attempt starts. Unmounting saves anything pending.
  `markSaved(text)` records that something else (a review) wrote `text`; if the draft moved on
  meanwhile it is sent again. Mount it once per entry — `DiaryView` keys `EntryWorkspace` on the
  entry id.
- **`flushAutosaves(timeoutMs = 5000)`** awaits every mounted autosave's flush and every unmount
  save still running; sign-out calls it first. The timeout keeps a hung save from blocking
  sign-out.
- **`unsavedDrafts.ts`** is a module-level map of drafts the server may not have yet, by entry id.
  A learner who leaves an entry and comes back before the unmount save lands gets the draft, not
  the older cached body. Cleared on sign-out (`forgetDrafts`) and between tests.
- **`useAutoGrowTextarea(value)`** keeps a textarea exactly as tall as its text (panes grow instead
  of scrolling), up to the element's own CSS `max-height`, past which it scrolls. The ceiling is
  read from the computed style so it stays in the markup (`max-h-[65vh]`, `max-h-[70vh]`); a
  `ResizeObserver` re-measures when the box narrows. In jsdom it measures nothing and leaves the
  height to CSS.
- **`useElapsedSeconds(active)`** and **`askingClaude(elapsed)`**: the "Asking Claude… 12s" hint
  beside a button that waits on Claude, shown only from 2 s on.
- **`usePending()`** runs one async action at a time and exposes `pending`; a second call while
  one is in flight is dropped — the double-click guard a disabled button can't give during the
  render between click and re-render.
- **`codePointLength`** (`codePoints.ts`) counts Unicode code points, as the backend's Ruby
  `String#length` does. Every length limit shown or enforced in the UI uses it, and the diary's
  highlight spans are code-point offsets (`feedbackRuns` in `diary.ts` indexes `Array.from(text)`),
  never UTF-16 units, which would drift after an emoji or a rare kanji.

## Styling

- Tailwind CSS 4 through `@tailwindcss/vite`; there is no `tailwind.config`. The palette is the
  `@theme` block in `frontend/app/src/index.css`, which generates the utilities (`bg-canvas`, `text-ink`,
  `text-muted`, `border-line`, `bg-frame`, `text-danger`, `bg-verdict-wrong`, …). **Components use
  these tokens, never raw colours or arbitrary colour values.**
- Each token's contrast against the grounds it sits on is **recorded in a comment beside it**, and
  `frontend/app/src/index.css.test.ts` recomputes the WCAG ratios from the hex values, so a token can't be
  nudged while its comment quotes the old figure. It checks the focus colour at 3:1 on canvas,
  surface and frame, spot-checks the recorded text ratios, and requires ink at 4.5:1 and the
  frame-muted underline at 3:1 on every verdict wash. A new token that carries text or a non-text
  indicator gets its ratio recorded and, where it matters, a line in that test.
- **Focus.** The `focus-ring` utility (`@utility` in `index.css`) is the focus indicator: a 2px
  `--color-focus` outline, offset 2px, on `:focus-visible` only (clicks and taps stay quiet). An
  outline rather than a box-shadow ring traces the border radius, needs no offset colour and
  survives forced-colours mode. New interactive controls use it; the few that don't yet are named
  in the comment above it.
- **Verdicts.** Each diary verdict has a wash and a deeper "open" step (`--color-verdict-*`), and
  `frontend/app/src/components/diary/verdictStyles.ts` pairs each with its own underline style (wavy, dashed,
  solid) so colour is never the only cue. Class names there are written out in full so Tailwind's
  scanner sees them; build class names from fragments and they silently vanish.
- Staleness and state are shown by ground colour and named markers, not by dimming text with
  opacity, which would drop the text under AA.

## Accessibility conventions

- **Live regions.** Each page has exactly one always-mounted `role="status" aria-live="polite"`
  element (`sr-only`), updated per request ("Asking Claude…", "Feedback ready.", "Translation
  failed."). It is always mounted because a status element that mounts already holding text is
  often never read. In the diary, components reach it through `useAnnounce()`
  (`frontend/app/src/components/diary/announce.ts`). Toasts are announced by sonner, so the live region says
  only that something failed, not why.
- **Ruby readings are `aria-hidden`** (`rubyParts` in `frontend/app/src/pages/TranslatePage.tsx`) and
  `select-none`: otherwise screen readers and plain-text copies fold the reading into the word
  (天気てんき). Anything that renders ruby inside a control must keep the readings hidden, since
  the control's accessible name comes from its contents.
- **Colour is never the only signal**: the current nav link is also bold and underlined; a
  verdict has a label on its card, in the legend and in the highlight's accessible name.
- **Focus management.** When a review replaces the textarea with the feedback, focus moves to the
  feedback section (`tabIndex={-1}`) instead of being dropped. The delete confirmation focuses
  Cancel, so a stray Enter keeps the entry.
- **Keyboard shortcuts.** ⌘/Ctrl+Enter submits: Update Translation on Phrases, Get feedback in
  the diary editor, send in a thread reply box. The hint is shown beside the button. A nested
  handler stops propagation: React bubbles events through a Radix portal to the component tree
  above it, so a reply box's shortcut would otherwise also fire the entry's Get feedback.
- **Radix for pointer, touch and keyboard.** A glossed word (`frontend/app/src/components/GlossedWord.tsx`)
  nests a `Tooltip` around a `Popover` on one `<button>`: the tooltip covers hover and keyboard
  focus, the popover covers a tap (Tooltip ignores touch; Popover ignores hover), and the tooltip is
  controlled so opening the popover closes it. A diary sentence (`frontend/app/src/components/diary/SentenceHighlight.tsx`) uses a
  Popover alone, because its card is somewhere to work rather than something to skim. Both are
  inline `<button>`s with `select-text` and a 6px tap-slop check, so the text stays selectable and
  the release that ends a drag-selection doesn't open a card. Language and gloss-level pickers are
  Radix `Select`s.
- Forms label every field (visually or `sr-only`), set `aria-invalid` when over a limit, and
  point `aria-describedby` at the sentence explaining why.

## Testing

- **Vitest + jsdom + Testing Library** (`test` block in `vite.config.ts`: `environment: "jsdom"`,
  `globals: true`, `css: false`). Tests sit beside the code as `*.test.ts(x)`.
- `frontend/app/src/test/setup.ts` adds the jest-dom matchers, stubs the pointer-capture and `scrollIntoView`
  APIs Radix calls and jsdom lacks, and after each test runs `cleanup()` and `forgetDrafts()`.
- **Test through the real stack.** Page and flow tests render `<App />` with the real Apollo
  client and session helpers; only `fetch` is faked. `installFakeServer()`
  (`frontend/app/src/test/fakeServer.ts`) stubs global `fetch`, routes `/graphql` by `operationName` and
  `/api/session` by method to handlers you register, records every request, and throws on
  anything unhandled. `json`, `viewer` and `unauthenticated` build common responses. Tests call
  `vi.unstubAllGlobals()` afterwards and set the starting URL with `history.replaceState`.
- `installFakeDiary(server, initial)` (`frontend/app/src/test/fakeDiary.ts`) is a small in-memory diary behind
  the fake server: enough of the backend's behaviour that queries, mutations and cache updates run
  end to end. Its objects carry `__typename`, because the cache normalises on it.
  `frontend/app/src/test/diaryFixtures.ts` builds entries, threads and comments.
- Components with no data needs are also tested alone (`frontend/app/src/components/diary/DiaryView.test.tsx` renders `DiaryView`
  with stub actions); Radix `Select`s are driven by keyboard, as jsdom can't fire their pointer
  events.
- **Leave nothing pending.** A test that types into a diary entry waits for **"Saved"** before it
  ends. Otherwise the autosave fires on unmount after the fake server is gone, and its failure
  toast leaks into the next test (sonner's toast state is module-level, like the drafts map).
- `frontend/app/src/pages/TranslatePage.test.tsx` includes a run under `StrictMode`, which mounts, unmounts and remounts
  every component; effects that keep refs (`mounted`, autosave registration) are written to
  survive it.

## Build and production serving

- `pnpm build` is `tsc -b && vite build`: it typechecks first, then writes `frontend/app/dist`
  (`index.html` plus hashed files under `assets/`). **No source maps** (`sourcemap: false`): they
  would be public and cached for a year.
- The `Dockerfile`'s Node stage installs with `--frozen-lockfile` and runs `pnpm build`. The final
  image copies `dist/index.html` to `/rails/spa/index.html` and `dist/assets` to
  `/rails/public/assets`. Only those two are copied, so anything else Vite would emit at the top
  of `dist` (a `public/` directory's files, for instance) would not ship.
- Rails routes `/` and every other HTML-format path to `SpaController#show`
  (`backend/app/controllers/spa_controller.rb`), which sends `spa/index.html` with
  `Cache-Control: no-cache` and a strict **Content-Security-Policy**: scripts and styles from
  `'self'` only, `connect-src 'self'`, no framing. `style-src` allows `'unsafe-inline'` solely
  for sonner's injected `<style>`; no script is ever inline, so nothing may add an inline
  `<script>` to `index.html`. The hashed assets are served from `public/` by Rails' static file
  server with a one-year `immutable` cache, which is safe because a new build changes their
  names and `index.html` itself is never cached.
- Without a build, `SpaController` answers 404 with a pointer to `pnpm dev`; in development the
  SPA always comes from Vite.

## Checks

From `frontend/`:

| Command | What |
|---|---|
| `pnpm typecheck` | `tsc -b` over the app and `vite.config.ts` |
| `pnpm test` | Vitest, once (`pnpm --filter app test:watch` to watch) |
| `pnpm build` | typecheck and production build |
| `pnpm codegen` | regenerate `frontend/app/src/gql/` after changing a `.graphql` file or `backend/schema.graphql`; commit the result |

`bin/check frontend` runs them the way CI does: `pnpm install --frozen-lockfile`, codegen (failing
if `frontend/app/src/gql` then differs from what is committed), typecheck, tests, build. `bin/check` with no
argument also runs the backend half. CI (`.github/workflows/ci.yml`) runs `bin/check frontend` on
Node 22, plus a non-blocking `pnpm audit --prod`.
