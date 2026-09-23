# Code review — mvp @ 2026-09-19 04:33

Base: 4f05641...mvp (the fix for review 20260918-170241-mvp-2) · HEAD: 59df687 · Effort: low (unverified) · Reviewers: 3 · Findings: 6 for this change (of 6 raw, 0 refuted) · Pre-existing filed to the backlog: 0

## Must-fix

- [x] The 401 retry calls `token_cache.invalidate` before the forced `ensure_fresh` succeeds. If that fetch fails or times out, the SDK's one-shot `next_force` flag stays set, so a later request runs a synchronous STS and exchange fetch that no deadline covers — backend/app/services/translation/claude_translator.rb:107 !p1
  (Unverified.) A 401 arrives and `invalidate` sets `@cached=nil, @next_force=true`. Then `ensure_fresh(force: true)` raises TokenUnavailable or WorkloadIdentityError, and the flag is never cleared. More than 5 s later, the next translation from any user passes `ensure_fresh(force: false)` on the still-usable `@current`. Then `create_message` reaches `TokenCache#get_token`, which calls `refresher.call(force_refresh: true)`. Because the 5 s dedupe window has passed, `fetch!` runs the provider inline. That is STS (about 14 s with a retry) plus the exchange (30 s open plus 30 s read), all before the SDK's 30 s deadline and outside the translator's 55 s budget, so the request can overrun nginx's 60 s. It is also a duplicate fetch that D5.2 forbids. The same forced call can also wait on `@fetch_lock` behind a fetch already in flight, again outside the deadline. The WebMock test covers only an SDK follow-up that comes within 5 s of a successful forced fetch.
  Fix: Call `invalidate` only after `ensure_fresh(force: true)` succeeds. Alternatively, make the refresher's forced `call` return any token newer than the one that got the 401. In both cases the SDK's follow-up forced call must never fetch or wait on `fetch_lock`.

## Concern

- [x] `ensure_fresh` starts a new fetch thread on every call, and each thread queues on `fetch_lock` and then runs its own full fetch. When STS or the exchange hangs, threads pile up without limit and hit the endpoint back to back, with none of the design's capped backoff — backend/app/services/claude/token_refresher.rb:77 !p2
  (Unverified.) STS or the exchange hangs and the cached token expires. Each translation starts a thread, waits 45 s, and returns UPSTREAM_UNREACHABLE, but its thread stays parked on `@fetch_lock`. When a thread gets the lock, `current` is still the same stale token or nil, so the `!current.equal?(seen)` check fails and the thread fetches again. With 8 Puma threads, a new thread is added about every 6 s, and threads drain at most one per slow fetch. An hour-long outage leaves hundreds of parked threads and a continuous run of STS and exchange calls, where D5.2 requires exponential backoff capped at 60 s.
  Fix: Keep one in-flight fetch in a shared field that later callers wait on with their own timeout. While the refresher is inside its backoff window, raise TokenUnavailable at once instead of starting a request-path fetch.

## Nit

- [x] Forced-refresh dedupe is keyed on time since any forced fetch, and the background refresh is itself forced. A 401 within 5 s of a background refresh therefore resends the rejected token, and the comment claiming 'the first forced refresh always fetches' is false — backend/app/services/claude/token_refresher.rb:165 !p3
  (Unverified.) `refresh_with_backoff` calls `fetch!(seen: nil, force: true)`, which sets `@forced_at`. Suppose that just-fetched token is revoked, or wrong for the workspace, and gets a 401. The translator's `ensure_fresh(force: true)` then returns it unchanged and the retry gets a second 401. The dedupe also ignores which token failed: two 401s on the same token more than 5 s apart each force a fresh exchange. The test forces only after a non-forced call, so it never exercises this case. This is related to the must-fix above (the identity-based fix covers both) but fails differently, so it is kept separate.
  Fix: Dedupe on token identity: pass the token that got the 401 as `seen`, and fetch unless `@current` is a different, newer token. Then fix the comment and the test.

- [ ] The reported wait counts only limits that are strictly over their cap. A refused attempt that takes a daily counter exactly to its cap gets a toast promising a retry that is certain to be refused — backend/app/services/translation/rate_limiter.rb:58 !p3
  (Unverified.) Session-day stands at 149 and this is the 11th request this minute. Session-minute goes to 11 (exceeded) and session-day to 150, which is not exceeded because the check is strictly greater than. The toast says "Try again in 40 seconds", and 40 s later session-day reaches 151 and the request is refused for the day. The code-day limit (500) behaves the same way.
  Fix: Compute the wait over every limit whose count is >= its cap after this increment.

- [ ] When session-day and code-day are both exceeded their waits tie, and `max_by` picks the device message, which hides that the whole access code is exhausted — backend/app/services/translation/rate_limiter.rb:61 !p3
  (Unverified.) A shared code reaches 500/day while this session is also past 150/day. Both waits run until UTC midnight, so the toast says "This device has reached today's translation limit". That suggests another device would help, but it would not.
  Fix: Break ties toward the broader scope, for example with [seconds, scope rank] as the max_by key.

- [ ] Only the new happy-path test renders under StrictMode. `renderSignedIn` and both sign-out and unmount tests still mount once, so the unmount guard is never tested through the double mount this fix targets — frontend/app/src/pages/TranslatePage.test.tsx:24 !p3
  (Unverified.) Suppose a later change adds a lifecycle ref that the StrictMode cleanup resets and the remount does not restore. The sign-out tests would still pass, and only the single StrictMode test could catch it, and only if the success path breaks. Review-history pattern 5 asks for tests to be wrapped in StrictMode.
  Fix: Wrap `renderSignedIn` and the two direct `render` calls in <StrictMode>.

## Filed elsewhere

None: every finding was introduced by this change.
