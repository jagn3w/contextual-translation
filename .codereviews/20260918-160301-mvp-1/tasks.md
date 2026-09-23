# Code review — mvp @ 2026-09-18 16:03

Base: main...mvp (two path-split runs: backend code; frontend + deploy/tooling; generated files excluded) · HEAD: a68d87c · Effort: low (unverified) · Reviewers: 6 · Findings: 19 for this change (of 20 raw, 0 refuted) · Pre-existing filed to the backlog: 0

## Must-fix

- [x] The first Claude call passes empty request options, so the beta SDK uses its 600 s default instead of the 30 s client timeout. A stalled first attempt then blocks a Puma thread for up to 10 minutes, and the user gets nginx's 504 instead of TIMEOUT — backend/app/services/translation/claude_translator.rb:74 !p1
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d677e14a82d128 (landed on mvp), with a regression test shown failing before the fix.
  In anthropic-1.71.0 `Beta::Messages#create`, `options.empty? && @client.timeout == DEFAULT_TIMEOUT_IN_SECONDS` is false because the client timeout is 30, so the SDK sets `{timeout: 600}`. The finder says it confirmed this with `rails runner`. Only the retry, which passes `timeout:`, is bounded. When Claude stalls, CapRover's nginx cuts the connection at 60 s, and the thread (one of 8) stays blocked, so a few stalls starve the app. The webmock `to_timeout` test raises at once and cannot catch this. Unverified, but the scenario is specific and includes a runtime check.
  Fix: Always pass an explicit timeout, for example `timeout: [DEADLINE_SECONDS - elapsed, TIMEOUT_SECONDS].min`, on the first call as well. Add a test that asserts the options the SDK receives.

- [-] The rack-attack rules compare the raw `req.path` to exact strings, but the router normalizes paths. So `/api/session/`, `//api/session` and `/graphql/` reach the same controllers and skip every login throttle, the LoginBan blocklist and the GraphQL per-IP cap — backend/config/initializers/rack_attack.rb:23 !p1
  Resolution: refuted — rack-attack 6.8 rewrites PATH_INFO with the router normalizer before evaluating rules (Rack::Attack#call); regression tests added in task:fix-mvp-review-20260918-160301-m-18d677e14a82d128.
  An attacker or a banned IP sends `POST /api/session/` with a valid Origin. Rack::Attack sees a path that does not equal SESSION_PATH, so the 5/min and 20/hr throttles and the ban do not match. `RouteSet#call` then normalizes the path, and `recognize_path` routes it to `Api::SessionsController#create`. Failures are still recorded, but the ban never blocks this variant. CapRover's nginx forwards the raw URI, so production is affected. This is the same bypass class as the `.json` suffix that commit a68d87c fixed, and the tests cover only `.json`. Unverified, but the scenario names the exact code paths.
  Fix: Match every rule against `Journey::Router::Utils.normalize_path(req.path)`, or reject non-canonical paths before Rack::Attack runs. Add trailing-slash and double-slash cases to rack_attack_test.rb.

- [x] Swap replaces the source pane with the last translation even after the source was edited, so the user's unsubmitted text is lost with no undo. `stale` compares only the languages, so an out-of-date result shows as current — frontend/app/src/pages/TranslatePage.tsx:83 !p1
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d677e14a82d128 (landed on mvp), with a regression test shown failing before the fix.
  Translate "Hello" EN->ES to get "Hola". Replace the source with a new paragraph, which is not re-sent because translation is manual. Click swap: setSourceText("Hola") runs and the paragraph is gone. Separately, after editing the source or context, or after a failed re-translate, the old result stays at full opacity as if it matched the current input. Unverified: the reasoning is concrete and consistent on its face.
  Fix: Store the sourceText and context each translation was made from. Dim the result when either differs. When the source has changed, swap only the languages, or ask first.

## Concern

- [x] The WIF token refresh (STS plus the Anthropic exchange) runs while the request is being built, before the SDK's deadline starts. Up to about 60 s or more of auth time counts against no timeout and no part of the 55 s budget, so a slow refresh ends in a 504 — backend/app/services/claude/client_factory.rb:61 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d677e14a82d128 (landed on mvp), with a regression test shown failing before the fix.
  On the roughly hourly token refresh, a slow token endpoint can use 30 s to connect plus 30 s to read (TOKEN_EXCHANGE_TIMEOUT). Aws::STS::Client defaults allow a 60 s read timeout and 3 retries. The Messages call then gets its full timeout on top, so the request passes the 60 s proxy limit and returns 504 instead of UPSTREAM_UNREACHABLE. This needs a slow token endpoint during a refresh. It is a separate defect from the 600 s first-call timeout and needs a separate fix.
  Fix: Give the STS client short http_open/read timeouts and retry_limit 0. Bound the token exchange by the remaining deadline, or refresh the token outside the request path.

- [x] TRANSLATOR defaults to `fake` in production, so a container without it boots and serves fake translations, and both the boot check and `claude:auth_check` report success — backend/app/services/translation.rb:21 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  If the CapRover config is missing TRANSLATOR (a typo or a config reset), the after_initialize hook builds FakeTranslator. The user sees '[ES] Is this a bat?'. The post-deploy `bin/rails claude:auth_check` prints 'ok (Translation::FakeTranslator)' and exits 0. This needs a misconfiguration, but when it happens every check stays silent.
  Fix: In production, use ENV.fetch with no default or reject `fake`. Make claude:auth_check abort unless the translator is a ClaudeTranslator.

- [x] signOut ignores network errors and non-2xx responses, but only the server can clear the HttpOnly session cookie, so a failed sign-out quietly signs the user back in — frontend/app/src/lib/session.ts:27 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d677e14a82d128 (landed on mvp), with a regression test shown failing before the fix.
  The user clicks Sign out while offline, or the DELETE returns 403 forbidden_origin or 415. signOut resolves anyway. handleSignOut clears the store and remounts SessionBoundary. The Viewer query still sends the valid cookie, and TranslatePage renders again with no message. On a shared machine the 12-hour session stays live while the user believes they signed out. Unverified.
  Fix: Treat only a 204 as success and return a RequestFailure otherwise. On failure, handleSignOut shows a toast and stays on the page instead of remounting.

- [x] The throwaway Postgres always binds 127.0.0.1:5432, so bin/check aborts whenever the developer's own dev Postgres is already running, and each failed run leaves its temp cluster dir behind — bin/check:24 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  The dev Postgres is running on 127.0.0.1:5432. PGHOST is set only in backend/.env, so the shell has none. `bin/check` (or `jkb task land`) calls start_throwaway_postgres, and pg_ctl fails with 'could not create listen socket'. Under set -e the gate aborts before any check runs. The EXIT trap is installed after pg_ctl, so the mktemp dir and its log are left behind. The finder reproduced this in the dev container.
  Fix: Start the cluster on a free port, or on a unix socket inside PG_DIR, and export PGPORT/PGHOST to match. Install the trap before pg_ctl.

- [x] The runbook's fallback fix for a shared client IP (a trusted-proxy rule for CapRover's nginx) cannot work, and it contradicts the rack_attack initializer, which says not to set trusted_proxies — docs/runbook.md:127 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  After release, the IP check shows 10.x or 172.x because the Swarm mesh SNATs traffic. The owner adds the trusted-proxy rule. rack-attack keys on req.ip, and X-Forwarded-For holds only the mesh IP, so nothing changes. All users still share one sign-in throttle bucket, and one bad code can ban everyone. Unverified: the mesh-SNAT reasoning is plausible but was not checked against the deployment.
  Fix: Remove the trusted-proxy option. Document host-mode port publishing for nginx instead. Optionally have the check grep the app's 'Failed access-code sign-in from <ip>' log line.

- [x] Every RATE_LIMITED error, including the daily caps, shows 'You're translating quickly' with a Try again button that cannot succeed and that bumps the limit counters on each click — frontend/app/src/lib/translateErrorMessage.ts:95 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  The session-day cap is hit with 17 hours left. The client ignores the server's per-limit message and shows 'You're translating quickly — try again in 17 hours.' with Try again. Each click is refused, and check! increments the counters before it compares. Unverified.
  Fix: Show the server's per-limit message. Hold back Try again until retryAfterSeconds has passed, or offer it only when the wait is short.

- [x] The aria-live region is inserted already holding its text on each result, so screen readers generally do not announce the translation — frontend/app/src/pages/TranslatePage.tsx:206 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  The loading branch unmounts the <p aria-live="polite">. When the result arrives, a new, already-filled region is inserted. NVDA, JAWS and VoiceOver announce changes to an existing region, not the insertion of a new one. Unverified: this relies on general screen-reader behaviour, not on a test with an actual reader.
  Fix: Keep one live region mounted outside the loading and empty branches, and update only its text.

- [x] A translation still in flight at sign-out puts its error toast on the access-code gate after the page has unmounted, and that toast's Try again does nothing — frontend/app/src/pages/TranslatePage.tsx:112 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  A request is heading for TIMEOUT (up to about 55 s) and the user clicks Sign out, which stays enabled while loading. The unmount effect dismisses TOAST_ID before the toast exists. The mutation then settles and toast.error appears over the gate. Its retry closure was captured while loading=true, so it is a no-op. The case needs sign-out during a slow request, which is narrower than normal use. Unverified.
  Fix: Keep a mounted ref or abort the request with an AbortController on unmount, and skip state updates and toasts after unmount.

## Nit

- [x] The WIF network-error branch does not map OpenSSL::SSL::SSLError or Net::ProtocolError/HTTPBadResponse, so TLS or protocol failures during the token exchange surface as INTERNAL instead of a specific code — backend/app/services/translation/claude_error_mapper.rb:43 !p3
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  A transient 'SSL_connect SYSCALL returned=5' during a token refresh, raised from WorkloadIdentity#perform_exchange outside the SDK's own rescue, matches none of Timeout::Error, SocketError, SystemCallError or IOError. The schema catch-all then returns INTERNAL. The request fails either way, so the harm is the wrong error code on a request that was already failing.
  Fix: Add OpenSSL::SSL::SSLError and Net::ProtocolError / Net::HTTPBadResponse to the network branch.

- [x] run_case rescues only Translation::Error, so one unmapped Claude error (400, 413 or 422) aborts the whole `eval:translations` run and loses the summary — backend/lib/translation_eval/runner.rb:49 !p3
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  With EFFORTS=low,medium, a 400 from a prompt change on case 5 kills the rake task before the p50/p95 summary and the second effort run, after the earlier cases have already been paid for. This affects dev tooling only.
  Fix: Rescue StandardError in run_case and record it as a failure.

- [x] The limiter raises at the first counter that is over its limit, so the counters after it are never incremented, which contradicts the doc comment and D3.4's claim that every counter is incremented before checking — backend/app/services/translation/rate_limiter.rb:54 !p3
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  On the 11th call in a minute, `session-minute` trips and raises, so `session-day`, `code-minute` and `code-day` are not incremented for that attempt. No Claude call gets through, so only the documentation is wrong.
  Fix: Increment all counters and then check them, or correct the comment and D3.4.

- [x] bin/check accepts an unknown target, runs nothing, and reports 'All checks passed' — bin/check:72 !p3
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  `bin/check fronted` in a CI step or jkb gate matches neither target and exits 0, so the gate shows green without running any checks.
  Fix: Reject any argument other than backend or frontend with a non-zero exit.

- [x] CI's `bin/bundler-audit --update` skips config/bundler-audit.yml, so CI never honours advisories on the ignore list, while local runs do — .github/workflows/ci.yml:45 !p3
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  The wrapper adds --config only when ARGV is empty or includes 'check'. An advisory added to ignore: as that file instructs still fails CI.
  Fix: Use `bin/bundler-audit check --update` in CI.

- [x] By default bin/smoke's health check hits the Vite dev server, which does not proxy /up, so the check passes on index.html while Rails is down — bin/smoke:50 !p3
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  GET localhost:5173/up returns the SPA fallback with a 200. The script prints 'ok health check 200', and the real failure only shows up at sign-in as a confusing proxy error.
  Fix: Add '/up' to Vite's server.proxy.

- [x] The sign-out test's check that the 'session ended' notice is absent can never fail, because the status paragraph has no accessible name to match — frontend/app/src/App.test.tsx:76 !p3
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  queryByRole('status', {name: /session ended/i}) returns null even when the notice is shown. A regression to onRestart(true) would still pass. Unverified.
  Fix: Assert with queryByText(/session ended/i). Also add the positive mid-use UNAUTHENTICATED case.

- [x] The client counts the 10,000/2,000 character limits in UTF-16 code units while the backend counts codepoints, so non-BMP text is wrongly blocked — frontend/app/src/pages/TranslatePage.tsx:65 !p3
  Resolution: fixed in task:fix-mvp-review-20260918-160301-m-18d678663f4464b8 (landed on mvp), with a regression test or a reproduced check.
  6,000 emoji count as 12,000 on the client, so the button is disabled, while the backend would accept them.
  Fix: Count codepoints on the client with [...text].length.

## Filed elsewhere

None: every finding was introduced by this change.
