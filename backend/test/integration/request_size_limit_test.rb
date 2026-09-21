# frozen_string_literal: true

require "test_helper"

class RequestSizeLimitTest < ActionDispatch::IntegrationTest
  test "bodies over 64 KB are rejected before parsing" do
    sign_in

    post_json "/graphql", { query: "{ viewer { accessCodeLabel } }", variables: { padding: "x" * 70_000 } }

    assert_response :content_too_large
    assert_equal "payload_too_large", response.parsed_body["error"]
  end

  # Without Content-Length there is nothing to check before reading the body, and Rails would read
  # all of it to measure it, so a chunked body is refused outright.
  test "a chunked body without a Content-Length is refused with 411" do
    sign_in
    body = { query: "{ viewer { accessCodeLabel } }", variables: { padding: "x" * 70_000 } }.to_json

    post "/graphql", params: body,
      headers: json_headers.merge("Content-Type" => "application/json", "Transfer-Encoding" => "chunked"),
      env: { "CONTENT_LENGTH" => nil }

    assert_nil request.get_header("CONTENT_LENGTH"), "the request under test must carry no Content-Length"
    assert_response :length_required
    assert_equal "length_required", response.parsed_body["error"]
  end

  test "a bodiless request without a Content-Length is not refused" do
    sign_in

    delete "/api/session", headers: json_headers.merge("Content-Type" => "application/json")

    assert_response :no_content
  end

  test "a maximum-size translate request fits" do
    sign_in
    source = "語" * 10_000 # 3 bytes each in UTF-8
    context = "語" * 2_000

    body = graphql(
      "mutation($input: TranslateInput!) { translate(input: $input) { errors { code } } }",
      variables: { input: { sourceText: source, sourceLanguage: "JA", targetLanguage: "EN", context: } }
    )

    assert_response :success
    assert_equal [], body.dig("data", "translate", "errors")
  end
end
