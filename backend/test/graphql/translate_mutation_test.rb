# frozen_string_literal: true

require "test_helper"

class TranslateMutationTest < ActionDispatch::IntegrationTest
  MUTATION = <<~GRAPHQL
    mutation Translate($input: TranslateInput!) {
      translate(input: $input) {
        translation { text notes sourceLanguage targetLanguage }
        errors { code message retryable retryAfterSeconds }
      }
    }
  GRAPHQL

  INPUT = { sourceText: "Is this a bat?", sourceLanguage: "EN", targetLanguage: "ES", context: "Baseball game" }.freeze

  # A translator that raises the given error, for exercising the error paths.
  class RaisingTranslator
    include Translation::Translator

    def initialize(error) = @error = error
    def translate(_request) = raise(@error)
  end

  setup { sign_in }
  teardown { Translation.translator = nil }

  test "returns the translation" do
    body = graphql(MUTATION, variables: { input: INPUT })

    assert_response :success
    assert_equal(
      {
        "translation" => {
          "text" => "[ES] Is this a bat?",
          "notes" => "Fake translation using context: Baseball game",
          "sourceLanguage" => "EN",
          "targetLanguage" => "ES"
        },
        "errors" => []
      },
      body.dig("data", "translate")
    )
  end

  test "anticipated failures come back as typed errors" do
    Translation.translator = RaisingTranslator.new(
      Translation::Error.new(Translation::ErrorCode::UPSTREAM_RATE_LIMITED, "Claude is busy.", retry_after_seconds: 7)
    )

    body = graphql(MUTATION, variables: { input: INPUT })

    assert_nil body.dig("data", "translate", "translation")
    assert_equal(
      [ { "code" => "UPSTREAM_RATE_LIMITED", "message" => "Claude is busy.", "retryable" => true, "retryAfterSeconds" => 7 } ],
      body.dig("data", "translate", "errors")
    )
  end

  test "non-retryable codes say so" do
    Translation.translator = RaisingTranslator.new(
      Translation::Error.new(Translation::ErrorCode::BUDGET_EXCEEDED, "Budget used up.")
    )

    error = graphql(MUTATION, variables: { input: INPUT }).dig("data", "translate", "errors", 0)

    assert_equal "BUDGET_EXCEEDED", error["code"]
    assert_equal false, error["retryable"]
    assert_nil error["retryAfterSeconds"]
  end

  test "unanticipated failures become a top-level INTERNAL error with a log reference" do
    Translation.translator = RaisingTranslator.new(RuntimeError.new("secret internals"))

    body = graphql(MUTATION, variables: { input: INPUT })

    error = body.dig("errors", 0)
    assert_equal "Something unexpected went wrong.", error["message"]
    assert_equal "INTERNAL", error.dig("extensions", "code")
    assert_match(/\A\h{8}\z/, error.dig("extensions", "reference"))
    assert_not_includes body.to_json, "secret internals"
  end

  test "rejects unknown languages at the schema level" do
    body = graphql(MUTATION, variables: { input: INPUT.merge(targetLanguage: "FR") })

    assert body["errors"].present?
    assert_nil body["data"]
  end
end
