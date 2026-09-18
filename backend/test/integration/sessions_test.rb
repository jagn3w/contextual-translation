# frozen_string_literal: true

require "test_helper"

class SessionsTest < ActionDispatch::IntegrationTest
  test "a valid code starts a session with a strict, http-only cookie" do
    record, plaintext = AccessCode.generate!(label: "Panel")

    post_json "/api/session", { code: plaintext }

    assert_response :no_content
    cookie = response.headers["Set-Cookie"].to_s
    assert_match(/_contextual_translate_session=/, cookie)
    assert_match(/httponly/i, cookie)
    assert_match(/samesite=strict/i, cookie)
    assert_not_nil record.reload.last_used_at
    graphql("{ ping }")
    assert_response :success
  end

  test "an invalid code is rejected without a session" do
    post_json "/api/session", { code: "ctx-0000-0000-0000-0000-0000-0000" }

    assert_response :unauthorized
    assert_equal "invalid_code", response.parsed_body["error"]
    graphql("{ ping }")
    assert_response :unauthorized
  end

  test "a missing or non-string code is rejected" do
    post_json "/api/session", {}
    assert_response :unauthorized

    post_json "/api/session", { code: { nested: "x" } }
    assert_response :unauthorized
  end

  test "requests without the app's Origin are rejected" do
    _record, plaintext = AccessCode.generate!(label: "x")

    post "/api/session", params: { code: plaintext }, as: :json
    assert_response :forbidden

    post "/api/session", params: { code: plaintext }, headers: { "Origin" => "https://evil.example" }, as: :json
    assert_response :forbidden
    assert_equal "forbidden_origin", response.parsed_body["error"]
  end

  test "non-JSON bodies are rejected" do
    _record, plaintext = AccessCode.generate!(label: "x")

    post "/api/session", params: { code: plaintext }, headers: json_headers

    assert_response :unsupported_media_type
  end

  test "revoking the code ends its sessions on the next request" do
    record, = sign_in

    record.revoke!
    graphql("{ ping }")

    assert_response :unauthorized
  end

  test "an expired code ends its sessions" do
    record, = sign_in

    record.update!(expires_at: 1.second.ago)
    graphql("{ ping }")

    assert_response :unauthorized
  end

  test "sessions end 12 hours after sign-in" do
    sign_in

    travel 11.hours + 59.minutes do
      graphql("{ ping }")
      assert_response :success
    end
    travel 12.hours + 1.minute do
      graphql("{ ping }")
      assert_response :unauthorized
    end
  end

  test "signing out ends the session" do
    sign_in

    delete_json "/api/session"
    assert_response :no_content

    graphql("{ ping }")
    assert_response :unauthorized
  end

  test "each sign-in gets a new session key" do
    sign_in
    first_key = session[:session_key]
    sign_in
    second_key = session[:session_key]

    assert_match(/\A\h{32}\z/, first_key)
    assert_not_equal first_key, second_key
  end

  test "access codes and GraphQL variables are filtered from logs" do
    filter = ActiveSupport::ParameterFilter.new(Rails.application.config.filter_parameters)

    assert_equal({ "code" => "[FILTERED]", "variables" => "[FILTERED]" },
      filter.filter("code" => "ctx-secret", "variables" => { "sourceText" => "private" }))
  end
end
