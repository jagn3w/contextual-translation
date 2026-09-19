# typed: strict
# frozen_string_literal: true

module Claude
  # Keeps a Workload Identity Federation access token fresh on one background thread, so
  # translations never fetch credentials themselves (design D5.2).
  #
  # Only the warmer thread calls the wrapped provider (STS plus the Anthropic token exchange,
  # which can take tens of seconds and can't be interrupted). It fetches at once, then at half
  # each token's lifetime, and early when a translation reports a 401. A failed fetch is retried
  # with capped exponential backoff while the current token is served until it expires.
  #
  # Request threads get two entry points, neither of which fetches:
  # - `call`, the Anthropic::Client credentials provider, returns the current token or raises
  #   TokenUnavailable, and never waits. The SDK's TokenCache calls it untimed from request
  #   threads, so it must be instant. It hands out copies that expire inside the cache's
  #   advisory window, so the cache asks again on every request rather than keeping an older
  #   token after a refresh.
  # - `await_token`, which ClaudeTranslator calls before each Claude request, waits a bounded
  #   time for a usable token, or for a newer one after a 401.
  class TokenRefresher
    extend T::Sig

    # A token with less than this left is treated as expired: a Claude call can take 30 s.
    MIN_VALIDITY_SECONDS = 60.0
    INITIAL_BACKOFF_SECONDS = 5.0
    MAX_BACKOFF_SECONDS = 60.0
    # The SDK's TokenCache returns its cached token without asking us until the token is within
    # ADVISORY_REFRESH_SECONDS of expiry; the copies `call` hands out are always inside that.
    HANDOUT_SECONDS = T.let(Anthropic::Credentials::ADVISORY_REFRESH_SECONDS / 2, Integer)

    # No usable token within the caller's time budget. The underlying fetch failure, if any, is
    # the `cause`. An Anthropic error so that, raised from `call` inside the SDK's TokenCache
    # advisory window, the cache falls back to its still-valid token instead of failing.
    class TokenUnavailable < Anthropic::Errors::Error; end
    # Claude rejected a token that was itself fetched because of a 401. Another fetch won't
    # help (the service account or federation rule is likely wrong), so the warmer backs off.
    class TokenRejected < StandardError; end
    # The token endpoint returned a token that is already (nearly) expired.
    class ShortLivedToken < StandardError; end

    Clock = T.type_alias { T.proc.returns(Float) }
    Sleeper = T.type_alias { T.proc.params(seconds: Float).void }

    sig do
      params(
        provider: T.untyped, # Anthropic::Credentials::WorkloadIdentity (or any #call -> AccessToken)
        logger: T.any(::Logger, ActiveSupport::BroadcastLogger),
        clock: Clock,
        sleeper: Sleeper
      ).void
    end
    def initialize(provider:, logger: Rails.logger, clock: -> { Time.now.to_f }, sleeper: ->(seconds) { sleep(seconds) })
      @provider = provider
      @logger = logger
      @clock = clock
      @sleeper = sleeper
      @lock = T.let(Mutex.new, Mutex)
      # Signalled whenever the token, the backoff state or a refresh request changes.
      @changed = T.let(ConditionVariable.new, ConditionVariable)
      @current = T.let(nil, T.nilable(Anthropic::Credentials::AccessToken))
      @fetched_at = T.let(0.0, Float)
      # Counts successful fetches; identifies which token a request used.
      @generation = T.let(0, Integer)
      # A request had a token of this generation (or older) rejected: fetch a newer one now.
      @refresh_after = T.let(nil, T.nilable(Integer))
      # The latest generation fetched because of a 401, and a rejection of it for the warmer.
      @forced_generation = T.let(nil, T.nilable(Integer))
      @rejection = T.let(nil, T.nilable(TokenRejected))
      @backing_off = T.let(false, T::Boolean)
      @last_error = T.let(nil, T.nilable(StandardError))
      @thread = T.let(nil, T.nilable(Thread))
    end

    # The Anthropic::Client credentials interface. Never fetches and never waits. The copy it
    # returns expires within HANDOUT_SECONDS by the cache's clock (wall time), so the SDK sends
    # whichever token is current when each request is built.
    sig { returns(Anthropic::Credentials::AccessToken) }
    def call
      @lock.synchronize do
        token = @current
        raise_unavailable("no usable Claude access token") unless token && usable?(token)

        handout_until = Time.now.to_i + HANDOUT_SECONDS
        expires_at = token.expires_at
        return token if expires_at && expires_at <= handout_until

        Anthropic::Credentials::AccessToken.new(token: token.token, expires_at: handout_until)
      end
    end

    # Waits up to `timeout` seconds for a usable token and returns its generation. With `after`
    # (the generation of a token Claude just rejected) it waits for a newer one, asking the
    # warmer to fetch it now unless it already has. Fails at once while the warmer is backing
    # off after a failed fetch: its next attempt may be a minute away, and Puma threads
    # shouldn't be parked on it.
    sig { params(timeout: Float, after: T.nilable(Integer)).returns(Integer) }
    def await_token(timeout:, after: nil)
      start
      deadline = monotonic + timeout
      @lock.synchronize do
        request_refresh(after) if after
        loop do
          token = @current
          return @generation if token && usable?(token) && (after.nil? || @generation > after)
          raise_unavailable("the Claude access token fetch is failing; retrying in the background") if @backing_off

          remaining = deadline - monotonic
          raise_unavailable("timed out after #{timeout.round(1)}s waiting for a Claude access token") unless remaining.positive?

          @changed.wait(@lock, remaining)
        end
      end
    end

    # The SDK binds its base URL into the provider; pass it through.
    sig { params(base_url: T.untyped).void }
    def bind_base_url(base_url)
      @provider.bind_base_url(base_url) if @provider.respond_to?(:bind_base_url)
    end

    # Starts the warmer thread, or revives one that died (idempotent). Puma's after_booted hook
    # calls it; `await_token` does too, for rake tasks and consoles.
    sig { void }
    def start
      @lock.synchronize do
        return if @thread&.alive?

        @thread = Thread.new { run }
        @thread.name = "claude-wif-token-refresher"
      end
    end

    # Stops the warmer thread. For tests; process exit doesn't need it.
    sig { void }
    def stop
      thread = @lock.synchronize do
        running = @thread
        @thread = nil
        running
      end
      thread&.kill&.join(1)
    end

    # Seconds until the warmer should fetch: now if there's no usable token or a request
    # reported the current one rejected, else at half its lifetime; nil if it never expires.
    sig { returns(T.nilable(Float)) }
    def seconds_until_refresh
      @lock.synchronize { refresh_due_in }
    end

    private

    sig { void }
    def run
      delay = INITIAL_BACKOFF_SECONDS
      loop do
        due = wait_until_due
        error = due.is_a?(StandardError) ? due : fetch(forced: due == :forced)
        if error
          @logger.error("Claude WIF token refresh failed (#{error.class}: #{error.message.truncate(200)}); retrying in #{delay.round}s")
          @sleeper.call(delay)
          delay = [ delay * 2, MAX_BACKOFF_SECONDS ].min
        elsif due == :scheduled
          # Only a routine refresh resets the backoff: a fetch forced by a 401 can succeed and
          # still produce tokens Claude rejects.
          delay = INITIAL_BACKOFF_SECONDS
        end
      end
    rescue StandardError => e
      # Never expected (fetch rescues); `await_token` revives the thread if it happens.
      @logger.error("Claude WIF token refresher stopped: #{e.class}: #{e.message}")
    end

    # Waits until a fetch is due and says why: :scheduled, or :forced by a 401. Returns the
    # rejection instead when Claude rejected a token a 401 had already replaced, so the warmer
    # backs off before fetching again.
    sig { returns(T.any(Symbol, TokenRejected)) }
    def wait_until_due
      @lock.synchronize do
        loop do
          if (rejection = @rejection)
            @rejection = nil
            return rejection
          end
          wait = refresh_due_in
          break if wait && !wait.positive?

          @changed.wait(@lock, wait)
        end
        # A fetch is starting: requests can wait for it again.
        @backing_off = false
        refresh_requested? ? :forced : :scheduled
      end
    end

    # Calls the provider outside the lock, since it can take tens of seconds. Returns the
    # failure, if any. A token that is already unusable counts as a failure, or the warmer
    # would fetch again at once, in a loop.
    sig { params(forced: T::Boolean).returns(T.nilable(StandardError)) }
    def fetch(forced:)
      token = @provider.call
      unless usable?(token)
        raise ShortLivedToken, "the token endpoint returned a token that expires in " \
                               "#{(token.expires_at.to_f - @clock.call).round}s"
      end

      @lock.synchronize do
        @current = token
        @fetched_at = @clock.call
        @generation += 1
        @forced_generation = @generation if forced
        @last_error = nil
        @changed.broadcast
      end
      @logger.info("Claude WIF token refreshed; expires in #{(token.expires_at.to_f - @clock.call).round}s")
      nil
    rescue StandardError => e
      @lock.synchronize do
        @last_error = e
        @backing_off = true
        @changed.broadcast
      end
      e
    end

    # Callers hold the lock. A no-op once a newer token exists or the refresh was already asked
    # for. If the rejected token was itself fetched because of a 401, this counts as a failed
    # fetch: requests fail fast and the warmer backs off, so a persistent 401 costs one token
    # exchange per backoff interval rather than one per request.
    sig { params(after: Integer).void }
    def request_refresh(after)
      return if @generation > after || @refresh_after == after

      @refresh_after = after
      if @forced_generation == after
        rejection = TokenRejected.new("Claude rejected a token fetched after a 401; check the " \
                                      "service account and federation rule")
        @rejection = rejection
        @last_error = rejection
        @backing_off = true
      end
      @changed.broadcast
    end

    # Callers hold the lock.
    sig { returns(T::Boolean) }
    def refresh_requested?
      requested = @refresh_after
      !requested.nil? && @generation <= requested
    end

    # Callers hold the lock.
    sig { returns(T.nilable(Float)) }
    def refresh_due_in
      token = @current
      return 0.0 if token.nil? || !usable?(token)

      return 0.0 if refresh_requested?

      expires_at = token.expires_at
      return nil if expires_at.nil?

      refresh_at = @fetched_at + ((expires_at.to_f - @fetched_at) / 2)
      [ refresh_at - @clock.call, 0.0 ].max
    end

    sig { params(token: Anthropic::Credentials::AccessToken).returns(T::Boolean) }
    def usable?(token)
      expires_at = token.expires_at
      expires_at.nil? || expires_at.to_f - @clock.call > MIN_VALIDITY_SECONDS
    end

    # Callers hold the lock.
    sig { params(message: String).returns(T.noreturn) }
    def raise_unavailable(message)
      # T.unsafe: Sorbet's Kernel#raise signature lacks the `cause:` keyword.
      T.unsafe(Kernel).raise(TokenUnavailable, message, cause: @last_error)
    end

    sig { returns(Float) }
    def monotonic
      Process.clock_gettime(Process::CLOCK_MONOTONIC).to_f
    end
  end
end
