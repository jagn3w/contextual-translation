# Code review — mvp @ 2026-09-19 13:56

Base: 864dcad...mvp · HEAD: 4993a9c · Effort: low (unverified) · Reviewers: 3 · Findings: 2 for this change (of 3 raw, 0 refuted) · Pre-existing filed to the backlog: 1

## Nit

- [ ] During a persistent-401 backoff, await_token(after: nil) returns the rejected token before checking @backing_off, so each request pays a Claude round trip and a 401 before failing — backend/app/services/claude/token_refresher.rb:110 !p3
  Claude rejects forced gen 2, and the warmer sleeps up to 60 s with @backing_off set. Each new translation's await_token returns gen 2 (usable, after nil) before the backoff check. The SDK sends it, Claude returns 401, and the retry's await_token(after: 2) then raises TokenRejected. That request still fails correctly, but one round trip late and with a warn log. The comment and D5.2 say requests fail fast.
  Fix: record the rejected generation in the :rejected branch, and have await_token fail at once while backing off and @generation <= it. Or, if one 401 round trip per request is acceptable, reword the comment and D5.2.

- [ ] The failed-refresh test's `@next_force == false` assertion can no longer fail, since nothing sets it after the translator stopped calling invalidate — backend/test/services/claude/client_factory_test.rb:89 !p3
  The SDK's own invalidate runs only when max_retries > 0, and ClientFactory uses 0. The assertion holds whatever the refresher does, so only the exchange count really checks this test's claim.
  Fix: drop the assertion, or replace it with a check on the refresher's pending state (e.g. seconds_until_refresh, or a third request proving no extra exchange).

## Filed elsewhere

Pre-existing, reported at their real severity and filed as their own work — this change is not
where they get fixed. Prose, deliberately: they are the run's record, and as tasks here they
would gate the branch.

- concern — backend/app/services/translation/claude_translator.rb:199 — WIF/STS failures are logged without their AWS or token-endpoint request ID: log_failure reads the outer TokenUnavailable, and the refresher's "refresh failed" line omits it too → task:wif-sts-failures-are-logged-with-18d6bdd97f270b68
