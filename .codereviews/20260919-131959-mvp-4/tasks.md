# Code review — mvp @ 2026-09-19 13:20

Base: 59df687...mvp · HEAD: 517053f · Effort: low (unverified) · Reviewers: 2 · Findings: 5 for this change (of 7 raw, 0 refuted) · Pre-existing filed to the backlog: 1

## Concern

- [x] A persistent 401 makes every request force a new WIF exchange with no backoff, since backoff only covers failed fetches — backend/app/services/translation/claude_translator.rb:107 !p2
  The exchange succeeds but the API rejects its tokens (e.g. the service account lacks permission). Request 1 gets a 401 on gen N and forces gen N+1, which also gets a 401, and the error is SERVICE_MISCONFIGURED. Request 2 does the same with N+1 and N+2. That is one STS call plus one exchange per request, and each request is parked for seconds, up to 30 s.
  Fix: rate-limit 401-driven refreshes. Treat a forced token that is rejected again as a failure for backoff, or allow at most one forced refresh per backoff interval and fail fast on the next 401.

- [x] The generation `await_token` returns is not the token the request sends, because the SDK TokenCache keeps the older token until its 120 s advisory window — backend/app/services/claude/token_refresher.rb:86
  With a 1 h token: the warmer fetches T1 (gen 1), then T2 (gen 2) at the half-life. The SDK still sends T1 until 120 s before T1 expires. If T1 gets a 401, await_token(after: 2) forces a needless gen-3 exchange; if that exchange fails, the request fails even though T2 was valid. The reverse race can resend a revoked token. The "passthrough" comment states the design's assumption, not how the gem behaves.
  Fix: make the SDK cache follow the refresher. Hand TokenCache tokens whose expires_at sits inside the advisory window so it always calls `call`, or invalidate client.token_cache whenever a new generation lands. Add a Client-level test: half-life refresh, then a 401.

- [x] A fetch that returns an already-unusable token (expires_in <= 60 or non-numeric) counts as a success, so the warmer re-fetches in a tight loop — backend/app/services/claude/token_refresher.rb:201
  The token endpoint returns expires_in: 30. fetch resets the delay, refresh_due_in returns 0 because the token isn't usable?, and the warmer calls STS and the exchange as fast as they answer. Meanwhile await_token times out with no cause, reported as UPSTREAM_UNREACHABLE.
  Fix: in fetch, treat a token that isn't usable? as a failure: set a descriptive @last_error and @backing_off so it goes through capped backoff.

## Nit

- [x] The `|| unreachable` fallback reports any unmapped fetch-failure cause (a TypeError bug, a ConfigurationError) as UPSTREAM_UNREACHABLE — backend/app/services/translation/claude_error_mapper.rb:23
  A bug in the identity-token lambda raises TypeError. map(cause) returns nil, and the fallback logs "Couldn't reach Claude." at warn level. Before this change the raw error re-raised as unexpected.
  Fix: fall back to unreachable only when there is no cause. Return nil for an unmappable cause so it re-raises as unexpected, or at least log the cause's class and message.

- [x] The concurrent-401 test polls with an unbounded `sleep 0.1 until ...`, so a regression hangs the suite instead of failing it — backend/test/services/claude/token_refresher_test.rb:145
  If the second provider call never happens, the poll spins forever. The neighbouring tests wrap their waits in Timeout.timeout(5).
  Fix: wrap the poll in Timeout.timeout(5).

## Filed elsewhere

Pre-existing, reported at their real severity and filed as their own work — this change is not
where they get fixed. Prose, deliberately: they are the run's record, and as tasks here they
would gate the branch.

- concern — backend/app/services/translation/claude_error_mapper.rb:43 — transient WIF token-endpoint and STS failures (5xx, 429, throttling) map to SERVICE_MISCONFIGURED instead of UPSTREAM_UNREACHABLE → task:transient-wif-token-endpoint-and-18d6bbc2f6df1358
