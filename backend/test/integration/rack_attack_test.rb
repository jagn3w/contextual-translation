# frozen_string_literal: true

require "test_helper"

class RackAttackTest < ActionDispatch::IntegrationTest
  BAD_CODE = "ctx-0000-0000-0000-0000-0000-0000"

  # The test environment's cache is a NullStore, which disables counting; use a real store here.
  setup do
    @original_store = Rack::Attack.cache.store
    Rack::Attack.cache.store = ActiveSupport::Cache::MemoryStore.new
  end

  teardown do
    Rack::Attack.cache.store = @original_store
  end

  test "sign-in is throttled after 5 attempts a minute per IP" do
    travel_to(Time.current.beginning_of_minute + 1.minute + 1.second)
    5.times do
      post_json "/api/session", { code: BAD_CODE }
      assert_response :unauthorized
    end

    post_json "/api/session", { code: BAD_CODE }

    assert_response :too_many_requests
    assert_equal "rate_limited", response.parsed_body["error"]
    assert_operator response.headers["retry-after"].to_i, :>, 0
  end

  test "throttling is per IP" do
    travel_to(Time.current.beginning_of_minute + 1.minute + 1.second)
    5.times { post_json "/api/session", { code: BAD_CODE } }

    post_json "/api/session", { code: BAD_CODE }, headers: { "REMOTE_ADDR" => "203.0.113.9" }

    assert_response :unauthorized
  end

  test "sign-in is throttled after 20 attempts an hour" do
    # Successful sign-ins, so the failure ban (which would block — and stop counting — requests)
    # stays out of the way. rack-attack uses clock-aligned windows, so pin the hour.
    _record, good_code = AccessCode.generate!(label: "x")
    hour = Time.current.beginning_of_hour + 1.hour
    4.times do |minute|
      travel_to(hour + minute.minutes + 1.second) do
        5.times do
          post_json "/api/session", { code: good_code }
          assert_response :no_content
        end
      end
    end

    travel_to(hour + 30.minutes) do
      post_json "/api/session", { code: good_code }
    end

    assert_response :too_many_requests
    assert_equal "rate_limited", response.parsed_body["error"]
  end

  test "10 failed codes in 10 minutes ban the IP from signing in for 10 minutes" do
    _record, good_code = AccessCode.generate!(label: "x")
    hour = Time.current.beginning_of_hour + 1.hour
    2.times do |window|
      travel_to(hour + (window * 2).minutes + 1.second) do
        5.times { post_json "/api/session", { code: BAD_CODE } }
      end
    end

    travel_to(hour + 5.minutes) do
      post_json "/api/session", { code: good_code }
      assert_response :too_many_requests
      assert_equal "too_many_failed_attempts", response.parsed_body["error"]
    end

    travel_to(hour + 15.minutes) do
      post_json "/api/session", { code: good_code }
      assert_response :no_content
    end
  end

  test "the GraphQL endpoint is capped at 60 requests a minute per IP" do
    travel_to(Time.current.beginning_of_minute + 1.minute + 1.second)
    sign_in
    60.times { graphql("{ viewer { accessCodeLabel } }") }
    assert_response :success

    graphql("{ viewer { accessCodeLabel } }")

    assert_response :too_many_requests
  end

  test "a format suffix doesn't escape the sign-in throttle" do
    post "/api/session.json", params: { code: BAD_CODE }, headers: json_headers, as: :json

    assert_response :not_found
  end

  test "a spoofed Forwarded header doesn't change the client IP" do
    travel_to(Time.current.beginning_of_minute + 1.minute + 1.second)
    6.times do |i|
      post_json "/api/session", { code: BAD_CODE },
        headers: { "REMOTE_ADDR" => "10.0.0.2", "Forwarded" => "for=198.51.100.#{i}" }
    end

    assert_response :too_many_requests
  end

  test "X-Forwarded-For from the proxy identifies the client" do
    travel_to(Time.current.beginning_of_minute + 1.minute + 1.second)
    5.times do
      post_json "/api/session", { code: BAD_CODE }, headers: { "REMOTE_ADDR" => "10.0.0.2", "X-Forwarded-For" => "203.0.113.7" }
    end

    post_json "/api/session", { code: BAD_CODE }, headers: { "REMOTE_ADDR" => "10.0.0.2", "X-Forwarded-For" => "203.0.113.8" }

    assert_response :unauthorized
  end

  test "health checks are never throttled" do
    100.times { get "/up" }

    assert_response :success
  end
end
