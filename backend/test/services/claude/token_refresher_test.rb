# frozen_string_literal: true

require "test_helper"

class Claude::TokenRefresherTest < ActiveSupport::TestCase
  # Hands out numbered tokens valid for `ttl` seconds from the fake clock. It can be told to
  # fail, or to block until the test lets each call through.
  class FakeProvider
    attr_reader :calls, :callers
    attr_accessor :failures_left, :gate

    def initialize(clock, ttl: 3600)
      @clock = clock
      @ttl = ttl
      @calls = 0
      @callers = []
      @failures_left = 0
      @gate = nil
    end

    def call
      @callers << Thread.current
      @gate&.pop
      @calls += 1
      if @failures_left.positive?
        @failures_left -= 1
        raise Anthropic::Credentials::WorkloadIdentityError, "token endpoint down"
      end
      Anthropic::Credentials::AccessToken.new(token: "token-#{@calls}", expires_at: @clock.call + @ttl)
    end
  end

  setup do
    @now = 1_000.0
    clock = -> { @now }
    @sleeps = Queue.new
    @wake = Queue.new
    @provider = FakeProvider.new(clock)
    # The warmer's backoff sleep blocks until the test releases it.
    @refresher = Claude::TokenRefresher.new(provider: @provider, clock:, sleeper: ->(s) { @sleeps << s; @wake.pop })
  end

  teardown { @refresher.stop }

  test "call never fetches or waits: without a token it raises at once" do
    started = monotonic

    assert_raises(Claude::TokenRefresher::TokenUnavailable) { @refresher.call }
    assert_equal 0, @provider.calls
    assert_operator monotonic - started, :<, 0.1
  end

  test "the warmer fetches on start; requests are then served without fetching" do
    @refresher.start

    assert_equal 1, @refresher.await_token(timeout: 5.0)
    20.times { assert_equal "token-1", @refresher.call.token }
    assert_equal 1, @refresher.await_token(timeout: 0.0)
    assert_equal 1, @provider.calls
    assert_not_includes @provider.callers, Thread.current
  end

  test "await_token waits for an in-flight fetch and returns as soon as it lands" do
    @provider.gate = Queue.new
    @refresher.start
    Thread.new { sleep 0.1; @provider.gate << true }
    started = monotonic

    assert_equal 1, @refresher.await_token(timeout: 5.0)
    assert_operator monotonic - started, :<, 1.0
  end

  test "await_token gives up after its timeout; the fetch still lands in the background" do
    @provider.gate = Queue.new
    started = monotonic

    assert_raises(Claude::TokenRefresher::TokenUnavailable) { @refresher.await_token(timeout: 0.2) }
    assert_operator monotonic - started, :<, 1.0

    @provider.gate << true
    assert_equal 1, @refresher.await_token(timeout: 5.0)
  end

  test "while the warmer backs off, requests fail at once with the fetch failure as the cause" do
    @provider.failures_left = 3
    @refresher.start
    assert_equal 5.0, Timeout.timeout(5) { @sleeps.pop }
    started = monotonic

    error = assert_raises(Claude::TokenRefresher::TokenUnavailable) { @refresher.await_token(timeout: 30.0) }
    assert_operator monotonic - started, :<, 0.5
    assert_instance_of Anthropic::Credentials::WorkloadIdentityError, error.cause
    assert_instance_of Anthropic::Credentials::WorkloadIdentityError,
      assert_raises(Claude::TokenRefresher::TokenUnavailable) { @refresher.call }.cause

    @wake << true
    assert_equal 10.0, Timeout.timeout(5) { @sleeps.pop }
    @wake << true
    assert_equal 20.0, Timeout.timeout(5) { @sleeps.pop }
    @wake << true
    Timeout.timeout(5) { sleep 0.01 until @provider.calls == 4 } # the warmer is fetching again
    assert_equal 1, @refresher.await_token(timeout: 5.0)
    assert_equal "token-4", @refresher.call.token
  end

  test "backoff is capped at a minute" do
    @provider.failures_left = 10
    @refresher.start

    delays = 6.times.map { Timeout.timeout(5) { @sleeps.pop }.tap { @wake << true } }

    assert_equal [ 5.0, 10.0, 20.0, 40.0, 60.0, 60.0 ], delays
  end

  test "during an outage the current token is served until it expires, then requests fail fast" do
    @refresher.start
    generation = @refresher.await_token(timeout: 5.0)
    @provider.failures_left = 100
    assert_raises(Claude::TokenRefresher::TokenUnavailable) { @refresher.await_token(timeout: 5.0, after: generation) }

    assert_equal "token-1", @refresher.call.token
    assert_equal generation, @refresher.await_token(timeout: 5.0)

    @now += 3600 - 30 # inside the minimum validity
    started = monotonic
    assert_raises(Claude::TokenRefresher::TokenUnavailable) { @refresher.call }
    assert_raises(Claude::TokenRefresher::TokenUnavailable) { @refresher.await_token(timeout: 5.0) }
    assert_operator monotonic - started, :<, 0.5
  end

  test "after a 401, await_token has the warmer fetch a newer token" do
    @refresher.start
    generation = @refresher.await_token(timeout: 5.0)

    assert_equal generation + 1, @refresher.await_token(timeout: 5.0, after: generation)
    assert_equal "token-2", @refresher.call.token
    assert_equal 2, @provider.calls
  end

  test "concurrent 401s on the same token share one fetch" do
    @refresher.start
    generation = @refresher.await_token(timeout: 5.0)
    @provider.gate = Queue.new
    waiters = 5.times.map { Thread.new { @refresher.await_token(timeout: 5.0, after: generation) } }
    Timeout.timeout(5) { sleep 0.01 until @provider.callers.size == 2 }

    @provider.gate << true

    assert_equal [ generation + 1 ] * 5, waiters.map(&:value)
    assert_equal 2, @provider.calls
  end

  test "a 401 on a token that was already replaced fetches nothing" do
    @refresher.start
    first = @refresher.await_token(timeout: 5.0)
    second = @refresher.await_token(timeout: 5.0, after: first)

    assert_equal second, @refresher.await_token(timeout: 5.0, after: first)
    assert_equal 2, @provider.calls
  end

  test "waiting never starts a thread per request" do
    @refresher.start
    generation = @refresher.await_token(timeout: 5.0)
    before = Thread.list.size

    20.times { @refresher.await_token(timeout: 5.0) }
    @refresher.await_token(timeout: 5.0, after: generation)

    assert_equal before, Thread.list.size
  end

  test "the next refresh is due at half the token's lifetime, or now when a 401 asked for one" do
    assert_equal 0.0, @refresher.seconds_until_refresh
    @refresher.start
    generation = @refresher.await_token(timeout: 5.0)
    @refresher.stop # so the warmer doesn't act on the 401 below

    assert_in_delta 1800.0, @refresher.seconds_until_refresh, 0.01
    @now += 1799
    assert_in_delta 1.0, @refresher.seconds_until_refresh, 0.01

    @refresher.send(:request_refresh, generation)
    assert_equal 0.0, @refresher.seconds_until_refresh
  end

  test "a token without an expiry is never refreshed on schedule" do
    provider = Object.new
    provider.define_singleton_method(:call) { Anthropic::Credentials::AccessToken.new(token: "forever") }
    refresher = Claude::TokenRefresher.new(provider:)
    refresher.start
    refresher.await_token(timeout: 5.0)

    assert_nil refresher.seconds_until_refresh
  ensure
    refresher&.stop
  end

  test "await_token revives a warmer thread that died" do
    @refresher.start
    generation = @refresher.await_token(timeout: 5.0)
    @refresher.instance_variable_get(:@thread).kill.join(1)

    assert_equal generation + 1, @refresher.await_token(timeout: 5.0, after: generation)
  end

  test "call hands the SDK a copy expiring inside its cache's advisory window" do
    provider = Object.new
    provider.define_singleton_method(:call) { Anthropic::Credentials::AccessToken.new(token: "real", expires_at: Time.now.to_i + 3600) }
    refresher = Claude::TokenRefresher.new(provider:)
    refresher.start
    refresher.await_token(timeout: 5.0)

    handed_out = refresher.call

    assert_equal "real", handed_out.token
    assert_operator handed_out.expires_at, :<=, Time.now.to_f + Anthropic::Credentials::ADVISORY_REFRESH_SECONDS
  ensure
    refresher&.stop
  end

  test "a persistent 401 backs off instead of forcing an exchange per request" do
    @refresher.start
    first = @refresher.await_token(timeout: 5.0)
    forced = @refresher.await_token(timeout: 5.0, after: first) # the 401 on a scheduled token
    started = monotonic

    error = assert_raises(Claude::TokenRefresher::TokenUnavailable) { @refresher.await_token(timeout: 30.0, after: forced) }
    assert_instance_of Claude::TokenRefresher::TokenRejected, error.cause
    assert_raises(Claude::TokenRefresher::TokenUnavailable) { @refresher.await_token(timeout: 30.0, after: forced) }
    assert_operator monotonic - started, :<, 0.5
    assert_equal 2, @provider.calls
    assert_equal 5.0, Timeout.timeout(5) { @sleeps.pop }

    @wake << true # the backoff ends: one more forced fetch
    Timeout.timeout(5) { sleep 0.01 until @refresher.await_token(timeout: 5.0) == forced + 1 }
    assert_raises(Claude::TokenRefresher::TokenUnavailable) { @refresher.await_token(timeout: 30.0, after: forced + 1) }

    assert_equal 10.0, Timeout.timeout(5) { @sleeps.pop } # a successful forced fetch doesn't reset it
    assert_equal 3, @provider.calls
  end

  test "a token that is already unusable counts as a failed fetch, not a loop" do
    provider = FakeProvider.new(-> { @now }, ttl: 30)
    refresher = Claude::TokenRefresher.new(provider:, clock: -> { @now }, sleeper: ->(s) { @sleeps << s; @wake.pop })
    refresher.start

    assert_equal 5.0, Timeout.timeout(5) { @sleeps.pop }
    error = assert_raises(Claude::TokenRefresher::TokenUnavailable) { refresher.await_token(timeout: 5.0) }
    assert_instance_of Claude::TokenRefresher::ShortLivedToken, error.cause
    assert_equal 1, provider.calls
  ensure
    refresher&.stop
  end

  test "passes the SDK's base URL through to the wrapped provider" do
    bound = nil
    provider = Object.new
    provider.define_singleton_method(:bind_base_url) { |url| bound = url }

    Claude::TokenRefresher.new(provider:).bind_base_url("https://api.anthropic.com")

    assert_equal "https://api.anthropic.com", bound
  end

  private

  def monotonic
    Process.clock_gettime(Process::CLOCK_MONOTONIC)
  end
end
