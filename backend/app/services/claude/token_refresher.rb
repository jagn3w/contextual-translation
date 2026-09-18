# typed: strict
# frozen_string_literal: true

module Claude
  # Keeps a Workload Identity Federation access token fresh in the background, so translations
  # never wait on STS or the Anthropic token exchange (design D5.2).
  #
  # It's an `Anthropic::Client` credentials provider (`call(force_refresh:)` -> AccessToken)
  # wrapping the gem's WorkloadIdentity provider:
  # - `start` (called when Puma boots) runs a thread that fetches a token at once, then again at
  #   half its lifetime, retrying failures with capped exponential backoff while the current
  #   token is still valid.
  # - `call` hands out the cached token. It only fetches synchronously when there is no usable
  #   token (before the first background fetch, or after a long outage) or the SDK forces a
  #   refresh after a 401 — the bounded fallback, not the normal path.
  class TokenRefresher
    extend T::Sig

    # A token with less than this left is treated as expired.
    MIN_VALIDITY_SECONDS = 60.0
    # A forced refresh right after another *forced* fetch reuses it: after a 401 the translator
    # forces a refresh, then the SDK's own token cache asks again with force_refresh. The first
    # forced refresh always fetches, even if a routine fetch just happened.
    FORCE_DEDUPE_SECONDS = 5.0

    # No token arrived within the caller's time budget (the fetch keeps going in the background).
    class TokenUnavailable < StandardError; end
    INITIAL_BACKOFF_SECONDS = 5.0
    MAX_BACKOFF_SECONDS = 60.0

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
      @state_lock = T.let(Mutex.new, Mutex)
      @fetch_lock = T.let(Mutex.new, Mutex)
      @current = T.let(nil, T.nilable(Anthropic::Credentials::AccessToken))
      @fetched_at = T.let(0.0, Float)
      @forced_at = T.let(nil, T.nilable(Float))
      @thread = T.let(nil, T.nilable(Thread))
      @started = T.let(false, T::Boolean)
    end

    # The Anthropic::Client credentials interface.
    sig { params(force_refresh: T::Boolean).returns(Anthropic::Credentials::AccessToken) }
    def call(force_refresh: false)
      start if @started && !@thread&.alive? # revive a background thread that died
      token = @state_lock.synchronize { @current }
      return token if token && !force_refresh && usable?(token)

      @logger.warn("Claude WIF token: no usable cached token; fetching synchronously")
      fetch!(seen: token, force: force_refresh)
    end

    # A usable token within `timeout` seconds, or TokenUnavailable. The translator calls this
    # before each Claude request so waiting for credentials counts against the request's
    # deadline; the SDK's own call then finds the token already cached. A fetch that outlives
    # the timeout finishes on its own thread and still refreshes the cache.
    sig { params(timeout: Float, force: T::Boolean).returns(Anthropic::Credentials::AccessToken) }
    def ensure_fresh(timeout:, force: false)
      token = @state_lock.synchronize { @current }
      return token if token && !force && usable?(token)
      raise TokenUnavailable, "no time left to fetch a Claude access token" unless timeout.positive?

      result = Thread::Queue.new
      Thread.new do
        result << fetch!(seen: token, force:)
      rescue StandardError => e
        result << e
      end
      outcome = result.pop(timeout:)
      raise TokenUnavailable, "timed out after #{timeout.round(1)}s fetching a Claude access token" if outcome.nil?
      raise outcome if outcome.is_a?(StandardError)

      T.cast(outcome, Anthropic::Credentials::AccessToken)
    end

    # The SDK binds its base URL into the provider; pass it through.
    sig { params(base_url: T.untyped).void }
    def bind_base_url(base_url)
      @provider.bind_base_url(base_url) if @provider.respond_to?(:bind_base_url)
    end

    # Starts the background refresh thread (idempotent).
    sig { void }
    def start
      @state_lock.synchronize do
        @started = true
        return if @thread&.alive?

        @thread = Thread.new { run }
        @thread.name = "claude-wif-token-refresher"
      end
    end

    # Seconds until the next background refresh: now if there's no token, else at half its
    # lifetime.
    sig { returns(Float) }
    def seconds_until_refresh
      token, fetched_at = @state_lock.synchronize { [ @current, @fetched_at ] }
      expires_at = token&.expires_at
      return 0.0 if token.nil? || expires_at.nil?

      refresh_at = fetched_at + ((expires_at.to_f - fetched_at) / 2)
      [ refresh_at - @clock.call, 0.0 ].max
    end

    # One background refresh, retrying with capped exponential backoff until it succeeds.
    sig { void }
    def refresh_with_backoff
      delay = INITIAL_BACKOFF_SECONDS
      loop do
        fetch!(seen: nil, force: true)
        return
      rescue StandardError => e
        @logger.error("Claude WIF token refresh failed (#{e.class}: #{e.message.truncate(200)}); retrying in #{delay.round}s")
        @sleeper.call(delay)
        delay = [ delay * 2, MAX_BACKOFF_SECONDS ].min
      end
    end

    private

    sig { void }
    def run
      loop do
        wait = seconds_until_refresh
        @sleeper.call(wait) if wait.positive?
        refresh_with_backoff
      end
    rescue StandardError => e
      # Never expected (refresh_with_backoff rescues); `call` revives the thread if it happens.
      @logger.error("Claude WIF token refresher stopped: #{e.class}: #{e.message}")
    end

    sig { params(token: Anthropic::Credentials::AccessToken).returns(T::Boolean) }
    def usable?(token)
      expires_at = token.expires_at
      expires_at.nil? || expires_at.to_f - @clock.call > MIN_VALIDITY_SECONDS
    end

    # Single-flight: concurrent callers wait for one fetch. A caller that queued behind another
    # fetch (the token changed from the one it `seen`) reuses that result instead of fetching
    # again, unless it must `force` a new token.
    sig do
      params(seen: T.nilable(Anthropic::Credentials::AccessToken), force: T::Boolean)
        .returns(Anthropic::Credentials::AccessToken)
    end
    def fetch!(seen:, force:)
      @fetch_lock.synchronize do
        current, forced_at = @state_lock.synchronize { [ @current, @forced_at ] }
        return current if !force && current && !current.equal?(seen) && usable?(current)
        return current if force && current && forced_at && @clock.call - forced_at < FORCE_DEDUPE_SECONDS

        token = @provider.call
        @state_lock.synchronize do
          @current = token
          @fetched_at = @clock.call
          @forced_at = @fetched_at if force
        end
        @logger.info("Claude WIF token refreshed; expires in #{(token.expires_at.to_f - @clock.call).round}s")
        token
      end
    end
  end
end
