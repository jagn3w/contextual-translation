# frozen_string_literal: true

require "test_helper"

class TranslateMutationTest < ActionDispatch::IntegrationTest
  MUTATION = <<~GRAPHQL
    mutation Translate($input: TranslateInput!) {
      translate(input: $input) {
        translation {
          text notes furigana glossesTruncated readingsOmitted sourceLanguage targetLanguage
          glosses { text reading meaning startsAt length }
        }
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
          "furigana" => nil,
          "glossesTruncated" => false,
          "readingsOmitted" => false,
          "glosses" => [
            { "text" => "[ES]", "reading" => nil, "meaning" => "fake target-language tag",
              "startsAt" => 0, "length" => 4 },
            { "text" => "bat?", "reading" => nil, "meaning" => "fake definition of bat?",
              "startsAt" => 15, "length" => 4 }
          ],
          "sourceLanguage" => "EN",
          "targetLanguage" => "ES"
        },
        "errors" => []
      },
      body.dig("data", "translate")
    )
  end

  test "a Japanese target exposes furigana and glosses" do
    translation = graphql(MUTATION, variables: { input: INPUT.merge(targetLanguage: "JA") })
      .dig("data", "translate", "translation")

    assert_equal "[日本語] Is this a bat?", translation["text"]
    assert_equal "[日本語《にほんご》] Is this a bat?", translation["furigana"]
    assert_equal(
      [ { "text" => "[日本語]", "reading" => "にほんご", "meaning" => "fake target-language tag",
          "startsAt" => 0, "length" => 5 },
        { "text" => "bat?", "reading" => nil, "meaning" => "fake definition of bat?",
          "startsAt" => 16, "length" => 4 } ],
      translation["glosses"]
    )
    translation["glosses"].each do |gloss|
      assert_equal gloss["text"], translation["text"][gloss["startsAt"], gloss["length"]]
    end
    assert_equal false, translation["glossesTruncated"], "this source never overruns the cap"
    assert_equal false, translation["readingsOmitted"], "this source is well inside the furigana limit"
  end

  test "a source too long for readings says so in readingsOmitted, so the UI need not guess" do
    long = "Is this a bat? " * 200

    translation = graphql(MUTATION, variables: { input: INPUT.merge(targetLanguage: "JA", sourceText: long) })
      .dig("data", "translate", "translation")

    assert_operator long.length, :>, Translation::Prompt::FURIGANA_LIMIT
    assert_nil translation["furigana"]
    assert_equal true, translation["readingsOmitted"]
  end

  test "a source too long for readings is no degrade for a Spanish target" do
    long = "Is this a bat? " * 200

    translation = graphql(MUTATION, variables: { input: INPUT.merge(sourceText: long) })
      .dig("data", "translate", "translation")

    assert_equal false, translation["readingsOmitted"], "Spanish shows no readings either way"
  end

  test "an explicit null glossLevel behaves exactly like an omitted one" do
    levels = []
    recording = Class.new do
      include Translation::Translator
      define_method(:translate) do |request|
        levels << request.gloss_level
        Translation::FakeTranslator.new.translate(request)
      end
    end
    Translation.translator = recording.new

    body = graphql(MUTATION, variables: { input: INPUT.merge(glossLevel: nil) })

    # `glossLevel: null` is legal under the committed schema — nullable, with a default — so it
    # has to mean the default, not a top-level INTERNAL error.
    assert_nil body["errors"]
    assert_equal [ Translation::GlossLevel::NOTABLE ], levels
    assert_equal "[ES] Is this a bat?", body.dig("data", "translate", "translation", "text")
    assert_empty body.dig("data", "translate", "errors")
  end

  test "glossLevel defaults to NOTABLE and accepts every level" do
    levels = []
    recording = Class.new do
      include Translation::Translator
      define_method(:translate) do |request|
        levels << request.gloss_level
        Translation::FakeTranslator.new.translate(request)
      end
    end
    Translation.translator = recording.new

    graphql(MUTATION, variables: { input: INPUT })
    %w[NONE NOTABLE EVERY].each { |level| graphql(MUTATION, variables: { input: INPUT.merge(glossLevel: level) }) }

    assert_equal [ Translation::GlossLevel::NOTABLE, Translation::GlossLevel::NONE,
                   Translation::GlossLevel::NOTABLE, Translation::GlossLevel::EVERY ], levels
  end

  test "rejects an unknown gloss level at the schema level" do
    body = graphql(MUTATION, variables: { input: INPUT.merge(glossLevel: "SOME") })

    assert body["errors"].present?
    assert_nil body["data"]
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

  test "validation failures come back as typed errors" do
    body = graphql(MUTATION, variables: { input: INPUT.merge(sourceText: " ") })

    assert_equal "EMPTY_INPUT", body.dig("data", "translate", "errors", 0, "code")
    assert_equal false, body.dig("data", "translate", "errors", 0, "retryable")
  end

  test "one request can run only one translate" do
    calls = 0
    counting = Class.new do
      include Translation::Translator
      define_method(:translate) do |request|
        calls += 1
        Translation::FakeTranslator.new.translate(request)
      end
    end
    Translation.translator = counting.new
    input = "{ sourceText: \"Hi\", sourceLanguage: EN, targetLanguage: ES }"

    body = graphql("mutation { a: translate(input: #{input}) { errors { code } } b: translate(input: #{input}) { errors { code } } }")

    assert_match(/complexity/, body.dig("errors", 0, "message"))
    assert_equal 0, calls
  end

  test "rejects unknown languages at the schema level" do
    body = graphql(MUTATION, variables: { input: INPUT.merge(targetLanguage: "FR") })

    assert body["errors"].present?
    assert_nil body["data"]
  end
end
