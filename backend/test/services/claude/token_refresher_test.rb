# frozen_string_literal: true

require "test_helper"

class Claude::TokenRefresherTest < ActiveSupport::TestCase
  # Hands out numbered tokens valid for `ttl` seconds from the fake clock; can be told to fail.
  class FakeProvider
    attr_reader :calls
    attr_accessor :failures_left

    def initialize(clock, ttl: 3600)
      @clock = clock
      @ttl = ttl
      @calls = 0
      @failures_left = 0
    end

    def call
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
    @sleeps = []
    @provider = FakeProvider.new(clock)
    @refresher = Claude::TokenRefresher.new(provider: @provider, clock:, sleeper: ->(s) { @sleeps << s })
  end

  test "fetches once, then serves the cached token without calling the provider" do
    assert_equal "token-1", @refresher.call.token
    @now += 1_000

    assert_equal "token-1", @refresher.call.token
    assert_equal 1, @provider.calls
  end

  test "fetches synchronously when the cached token is (nearly) expired" do
    @refresher.call
    @now += 3600 - 30 # inside the 60 s minimum validity

    assert_equal "token-2", @refresher.call.token
  end

  test "a forced refresh always fetches; a second one right after reuses it" do
    @refresher.call

    assert_equal "token-2", @refresher.call(force_refresh: true).token
    assert_equal "token-2", @refresher.call(force_refresh: true).token # the SDK's follow-up
    @now += 10
    assert_equal "token-3", @refresher.call(force_refresh: true).token
  end

  test "background refresh is due at half the token's lifetime" do
    assert_equal 0.0, @refresher.seconds_until_refresh
    @refresher.refresh_with_backoff

    assert_in_delta 1800.0, @refresher.seconds_until_refresh, 0.01
    @now += 1799
    assert_in_delta 1.0, @refresher.seconds_until_refresh, 0.01
    @now += 10
    assert_equal 0.0, @refresher.seconds_until_refresh
  end

  test "a failing background refresh backs off exponentially and keeps serving the old token" do
    @refresher.refresh_with_backoff # token-1
    @now += 1800
    @provider.failures_left = 5

    served_during_outage = @refresher.call.token
    @refresher.refresh_with_backoff

    assert_equal "token-1", served_during_outage
    assert_equal [ 5.0, 10.0, 20.0, 40.0, 60.0 ], @sleeps
    assert_equal "token-7", @refresher.call.token
  end

  test "start runs the refresh on a background thread" do
    fetched = Queue.new
    provider = Object.new
    provider.define_singleton_method(:call) do
      fetched << true
      Anthropic::Credentials::AccessToken.new(token: "bg", expires_at: Time.now.to_f + 3600)
    end
    # The thread's sleeper blocks forever after the first fetch; the test ends it.
    refresher = Claude::TokenRefresher.new(provider:, sleeper: ->(_) { sleep })

    refresher.start

    assert Timeout.timeout(5) { fetched.pop }
    assert_equal "bg", refresher.call.token
  ensure
    refresher&.instance_variable_get(:@thread)&.kill
  end

  test "ensure_fresh gives up after its timeout while the fetch finishes in the background" do
    release = Queue.new
    provider = Object.new
    provider.define_singleton_method(:call) do
      release.pop
      Anthropic::Credentials::AccessToken.new(token: "late", expires_at: Time.now.to_f + 3600)
    end
    refresher = Claude::TokenRefresher.new(provider:)

    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    assert_raises(Claude::TokenRefresher::TokenUnavailable) { refresher.ensure_fresh(timeout: 0.2) }
    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 1.0

    release << true
    assert_equal "late", Timeout.timeout(5) { sleep 0.01 until (t = refresher.instance_variable_get(:@current)); t }.token
  end

  test "ensure_fresh returns a usable cached token without fetching" do
    @refresher.call

    assert_equal "token-1", @refresher.ensure_fresh(timeout: 0.0).token
    assert_equal 1, @provider.calls
  end

  test "passes the SDK's base URL through to the wrapped provider" do
    bound = nil
    provider = Object.new
    provider.define_singleton_method(:bind_base_url) { |url| bound = url }

    Claude::TokenRefresher.new(provider:).bind_base_url("https://api.anthropic.com")

    assert_equal "https://api.anthropic.com", bound
  end
end
