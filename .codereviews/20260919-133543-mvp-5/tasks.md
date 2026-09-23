# Code review — mvp @ 2026-09-19 13:35

Base: 517053f...mvp · HEAD: 864dcad · Effort: low (unverified) · Reviewers: 3 · Findings: 4 for this change (of 6 raw, 0 refuted) · Pre-existing filed to the backlog: 1

## Must-fix

- [x] Real STS throttles and IDPCommunicationError map to SERVICE_MISCONFIGURED: aws-sdk-core hard-codes `throttling?`/`retryable?` to false and these arrive as HTTP 400; the test fakes `throttling?` on a singleton — backend/app/services/translation/claude_error_mapper.rb:34 !p1
  STS rate-limits GetWebIdentityToken and raises Aws::STS::Errors::Throttling (status 400). Both predicates are false (aws-sdk-core errors.rb:43-50) and status < 500, so users see "isn't configured correctly" and it logs at error level, contrary to D5.2. The finder reproduced this with a stub_responses STS client.
  Fix: classify by error code (Throttling, IDPCommunicationError, RequestLimitExceeded, or Aws::Plugins::Retries::ErrorInspector) plus status >= 500. Drop the dead predicate calls. Test with an error raised by a stub_responses STS client.

## Concern

- [x] A 401 on an older token that TokenCache's in-progress shortcut sent is charged to the newer forced token, so a valid token is counted as rejected — backend/app/services/claude/token_refresher.rb:236 !p2
  Token N revoked; forced F = N+1 published. Request C gets generation F from await_token, but another thread is inside the provider call, so TokenCache returns the cached N handout (token_cache.rb:80-81). C sends N, gets a 401, and reports after: F. That records a TokenRejected: C fails fast, and the warmer sleeps a backoff step before forcing an extra exchange. Needs stampede timing.
  Fix: count a rejection only against the token actually sent. Compare the bearer string with @current.token, or have `call` record the generation it handed out.

- [x] A queued @rejection isn't checked against a fetch that superseded it, and a successful fetch never clears @backing_off — backend/app/services/claude/token_refresher.rb:182 !p2
  (a) A 401 on F arrives during a scheduled fetch that then lands F+1. wait_until_due returns the stale rejection, so the warmer logs a failure right after a success and sleeps, and 401 retries on the valid F+1 fail fast meanwhile. (b) A 401 during a backoff sleep queues a rejection, which costs a second backoff step before the first forced fetch.
  Fix: drop a pending rejection whose generation is superseded, and clear @backing_off on a successful fetch. While a fetch or backoff sleep is in progress, set refresh_after instead of queueing a rejection.

## Nit

- [x] The ShortLivedToken guard only rejects tokens with 60 s or less left, so an expires_in of about 61-70 s makes the warmer refetch every few seconds with no backoff — backend/app/services/claude/token_refresher.rb:203 !p3
  expires_in=65: about 64 s remain after a 1 s exchange, so the token is usable and counts as a success. Four seconds later it isn't, the scheduled fetch succeeds again and resets the delay: one STS call plus one exchange roughly every 4 s.
  Fix: require a fetched token to stay usable for a minimum interval (e.g. expires_in - MIN_VALIDITY_SECONDS >= INITIAL_BACKOFF_SECONDS), or put a floor on the time from one success to the next scheduled fetch.

## Filed elsewhere

Pre-existing, reported at their real severity and filed as their own work — this change is not
where they get fixed. Prose, deliberately: they are the run's record, and as tasks here they
would gate the branch.

- concern — backend/app/services/claude/client_factory.rb:62 — `sts_client ||=` memoizes a client whose credential chain resolved to nil during a transient IMDS failure, so every fetch raises MissingCredentialsError (SERVICE_MISCONFIGURED) until the process restarts → task:sts-client-memoized-after-a-tran-18d6bca9b38007b0
