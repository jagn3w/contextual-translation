# frozen_string_literal: true

require "test_helper"

class RequestSizeLimitTest < ActionDispatch::IntegrationTest
  test "bodies over 64 KB are rejected before parsing" do
    sign_in

    post_json "/graphql", { query: "{ viewer { accessCodeLabel } }", variables: { padding: "x" * 70_000 } }

    assert_response :content_too_large
    assert_equal "payload_too_large", response.parsed_body["error"]
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
