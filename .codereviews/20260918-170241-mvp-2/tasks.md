# Code review — mvp @ 2026-09-18 17:02

Base: a68d87c...mvp (the fixes for review 20260918-160301-mvp-1) · HEAD: 4f05641 · Effort: low (unverified) · Reviewers: 3 · Findings: 6 for this change (of 6 raw, 0 refuted) · Pre-existing filed to the backlog: 0

## Must-fix

- [x] The `mounted` ref is set to false in the effect cleanup and never set back to true. Under StrictMode's mount, cleanup, remount cycle, every translate response is dropped, so the dev app cannot translate at all — frontend/app/src/pages/TranslatePage.tsx:79 !p1
  Resolution: fixed in task:fix-mvp-review-20260918-170241-m-18d679a46fce9998 (landed on mvp), with a regression test shown failing before the fix.
  main.tsx renders `<StrictMode><App/></StrictMode>`. In dev, React 19 runs the effect, then its cleanup (L80-83 sets `mounted.current = false`), then the effect again, and keeps the same ref object. The effect body never sets `mounted.current = true`, so every `runTranslation` returns early at L144 or L160. No result, error toast or Retry appears, and the live region stays on "Translating…". Vitest renders without StrictMode, so no test catches it. Production is not affected, but `pnpm dev` with TRANSLATOR=fake cannot translate. Unverified: the scenario is concrete and matches documented StrictMode behaviour.
  Fix: Set `mounted.current = true` in the effect body before returning the cleanup, and wrap at least one TranslatePage test in `<StrictMode>`.

## Concern

- [x] check! reports the first exceeded limit in declaration order rather than the longest one. When a per-minute cap and a daily cap are both exceeded, the client shows "try again in a moment" with Retry and never mentions the daily cap — backend/app/services/translation/rate_limiter.rb:60 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-170241-m-18d679a46fce9998 (landed on mvp), with a regression test shown failing before the fix.
  A session is over its 150/day limit and makes an 11th attempt within a minute. `exceeded` is [session-minute (40 s), session-day (about 61200 s)], and `.first` picks session-minute. The client treats retryAfter <= 60 as a transient limit, so it offers Try again, which D3.4 forbids for a daily cap. Each retry is refused for the rest of the day. The same happens with code-day plus code-minute across devices that share a code. Unverified.
  Fix: Report `exceeded.max_by { |_, retry_after| retry_after }` so a daily cap always wins.

- [x] Per-minute RATE_LIMITED toasts drop the known retryAfterSeconds but still offer an immediate Try again. That retry is certain to fail, and it counts against the session's and the code's daily quotas — frontend/app/src/lib/translateErrorMessage.ts:24 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-170241-m-18d679a46fce9998 (landed on mvp), with a regression test shown failing before the fix.
  On the 11th translation in a minute the server returns retryAfterSeconds=42. The toast used to say "try again in 42 seconds". It now says "try again in a moment" (the test was changed to assert this) and offers Try again. Each click in the next 42 s is refused. Because check! counts every attempt against all four counters, each click also uses up the session's daily quota and the shared code's minute and daily quotas. Unverified.
  Fix: Append the formatted wait (for example "Try again in 42 seconds.") when retryAfterSeconds <= 60, or hold back Try again until the wait has passed.

- [x] The 401-driven force_refresh path the refresher is designed around cannot run. With max_retries: 0 the SDK never calls retry_request?, so a revoked token is never invalidated and translation fails until the token nears expiry or the server is restarted — backend/app/services/claude/token_refresher.rb:14 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-170241-m-18d679a46fce9998 (landed on mvp), with a regression test shown failing before the fix.
  In anthropic 1.71, send_request skips retry_request? when retry_count >= max_retries, and max_retries is 0 (client_factory.rb:67). retry_request? is the only caller of token_cache.invalidate and force_refresh. After a revocation (a federation or service-account change), every translation returns 401, which maps to SERVICE_MISCONFIGURED. This lasts up to about 58 minutes for a 3600 s token, because TokenCache only calls the provider inside its 120 s advisory window. The force_refresh test calls refresher.call directly, never through Anthropic::Client, so it passes although the path is dead. Unverified: this depends on the SDK internals as the finder describes them.
  Fix: In ClaudeTranslator, rescue AuthenticationError once, invalidate the token cache and retry within the deadline. Or correct the doc, the design note (D5.2) and the test. Add a test that goes through Anthropic::Client.

- [x] A synchronous token fetch runs before the SDK's 30 s timeout clock starts, and nothing limits how long it takes. On a cold boot or after a long refresh outage, a request can run well past nginx's 60 s — backend/app/services/translation/claude_translator.rb:94 !p2
  Resolution: fixed in task:fix-mvp-review-20260918-170241-m-18d679a46fce9998 (landed on mvp), with a regression test shown failing before the fix.
  auth_headers calls TokenCache and then TokenRefresher inside build_request, before send_request sets its deadline. Take a boot where the token endpoint is black-holing packets. The request waits up to 30 s on fetch_lock while the background exchange hangs. It then runs its own fetch: up to 14 s of STS plus up to 60 s of exchange. Only after that does the 30 s Claude timeout start. nginx returns 504 while the Puma thread keeps working, which breaks D2.2. This needs a degraded upstream, but the scenario holds together. Unverified.
  Fix: Put limits on the fetch_lock wait and the token exchange timeout, and map a limit being hit to UPSTREAM_UNREACHABLE. Or resolve the token first and pass min(30, DEADLINE - elapsed) as the first attempt's timeout.

## Nit

- [ ] MIN_VALIDITY_SECONDS (60) forces a synchronous fetch while a token is still valid. STS and network errors from that fetch are not caught by TokenCache's advisory-window rescue, so requests fail even though a usable cached token exists — backend/app/services/claude/token_refresher.rb:20 !p3
  During an STS outage longer than half the token's lifetime, the cached token reaches 45 s left. usable? is false, so fetch! runs and raises Seahorse NetworkingError or Net::OpenTimeout. TokenCache's advisory rescue only covers Anthropic::Errors::Error and IOError, so the translation fails while the token is still good for 45 s. The effect is about 30 s of avoidable failures at the tail of a long outage. Unverified.
  Fix: Return the cached token when a synchronous fetch fails and the token has not expired, or align MIN_VALIDITY_SECONDS with the SDK's 30 s mandatory window.

## Filed elsewhere

None: every finding was introduced by this change.
