# frozen_string_literal: true

require "test_helper"

class Translation::ServiceTest < ActiveSupport::TestCase
  setup do
    @cache = ActiveSupport::Cache::MemoryStore.new
    @service = Translation::Service.new(
      translator: Translation::FakeTranslator.new,
      rate_limiter: Translation::RateLimiter.new(cache: @cache)
    )
    @access_code, = AccessCode.generate!(label: "x")
    @session = session_for(@access_code)
  end

  test "translates a valid request" do
    assert_equal "[ES] Hola?", @service.call(request("Hola?"), session: @session).text
  end

  test "blank text is EMPTY_INPUT" do
    assert_code :EMPTY_INPUT, request("   \n ")
  end

  test "text over 10,000 characters is INPUT_TOO_LONG" do
    assert_nothing_raised { @service.call(request("a" * 10_000), session: @session) }
    error = assert_code :INPUT_TOO_LONG, request("a" * 10_001)
    assert_includes error.message, "10,000"
  end

  test "context over 2,000 characters is INPUT_TOO_LONG" do
    error = assert_code :INPUT_TOO_LONG, request("Hi", context: "c" * 2_001)
    assert_includes error.message, "Context"
  end

  test "the same source and target language is SAME_LANGUAGE" do
    assert_code :SAME_LANGUAGE, request("Hi", to: Translation::Language::EN)
  end

  test "a session may translate 10 times a minute" do
    travel_to(Time.current.beginning_of_minute + 1.minute + 5.seconds)
    10.times { @service.call(request("Hi"), session: @session) }

    error = assert_code :RATE_LIMITED, request("Hi")
    assert_equal 55, error.retry_after_seconds
    assert error.code.retryable?

    travel 1.minute
    assert_nothing_raised { @service.call(request("Hi"), session: @session) }
  end

  test "a session may translate 150 times a day" do
    travel_to(Time.current.beginning_of_day + 1.day)
    15.times do |minute|
      travel_to(Time.current.beginning_of_day + minute.minutes) do
        10.times { @service.call(request("Hi"), session: @session) }
      end
    end

    travel_to(Time.current.beginning_of_day + 1.hour) do
      error = assert_code :RATE_LIMITED, request("Hi")
      assert_includes error.message, "today"
    end
  end

  test "an access code is capped at 30 a minute across its sessions" do
    travel_to(Time.current.beginning_of_minute + 1.minute + 1.second)
    sessions = Array.new(4) { session_for(@access_code) }
    sessions.first(3).each { |session| 10.times { @service.call(request("Hi"), session:) } }

    error = assert_raises(Translation::Error) { @service.call(request("Hi"), session: sessions.last) }

    assert_equal Translation::ErrorCode::RATE_LIMITED, error.code
    assert_includes error.message, "Too many Claude requests on this access code"
  end

  test "an attempt refused by one limit still counts against the others" do
    travel_to(Time.current.beginning_of_minute + 1.minute + 1.second)
    10.times { @service.call(request("Hi"), session: @session) }
    assert_raises(Translation::Error) { @service.call(request("Hi"), session: @session) } # refused by session-minute
    second = session_for(@access_code)
    third = session_for(@access_code)
    10.times { @service.call(request("Hi"), session: second) }
    9.times { @service.call(request("Hi"), session: third) } # 30 counted on the code, incl. the refused one

    error = assert_raises(Translation::Error) { @service.call(request("Hi"), session: third) }

    assert_includes error.message, "Too many Claude requests on this access code"
  end

  test "when a minute and a daily limit are both exceeded, the daily one is reported" do
    day = Time.current.beginning_of_day + 1.day
    15.times do |minute|
      travel_to(day + minute.minutes + 1.second) { 10.times { @service.call(request("Hi"), session: @session) } }
    end
    travel_to(day + 20.minutes + 1.second) do
      10.times { assert_raises(Translation::Error) { @service.call(request("Hi"), session: @session) } }

      error = assert_raises(Translation::Error) { @service.call(request("Hi"), session: @session) }

      assert_includes error.message, "today"
      assert_operator error.retry_after_seconds, :>, 3600
    end
  end

  test "invalid requests don't count against the limits" do
    travel_to(Time.current.beginning_of_minute + 1.minute + 1.second)
    20.times { assert_raises(Translation::Error) { @service.call(request(""), session: @session) } }

    assert_nothing_raised { @service.call(request("Hi"), session: @session) }
  end

  private

  def request(text, to: Translation::Language::ES, context: nil)
    Translation::Request.new(source_text: text, source_language: Translation::Language::EN, target_language: to, context:)
  end

  def session_for(access_code)
    Authentication::Current.new(access_code:, session_key: SecureRandom.hex(16), authenticated_at: Time.current)
  end

  def assert_code(code, request)
    error = assert_raises(Translation::Error) { @service.call(request, session: @session) }
    assert_equal Translation::ErrorCode.deserialize(code.to_s), error.code
    error
  end
end
