# frozen_string_literal: true

require "test_helper"

class Translation::PromptTest < ActiveSupport::TestCase
  test "the gloss cap is interpolated everywhere it is stated, never spelled out" do
    cap = Translation::Prompt::MAX_GLOSSES.to_s
    # Everything but the constant's own line: a literal here would let the number Claude is told
    # drift from the number Result.for_request actually keeps.
    source = Rails.root.join("app/services/translation/prompt.rb").read.sub(/^\s*MAX_GLOSSES =.*$/, "")

    assert_not_includes source, cap, "interpolate MAX_GLOSSES instead of writing #{cap} out"
    assert_includes Translation::Prompt::SYSTEM, "stop at #{cap} entries"
    assert_includes Translation::Prompt::OUTPUT_SCHEMA.dig(:properties, :glosses, :description), "at most #{cap}"
  end

  test "a source within the furigana limit asks for readings" do
    message = Translation::Prompt.user_message(request_of_length(Translation::Prompt::FURIGANA_LIMIT))

    assert_includes message, "<readings>on</readings>"
  end

  test "a longer source asks for no readings, and still asks for the glosses" do
    request = request_of_length(Translation::Prompt::FURIGANA_LIMIT + 1)

    assert_not Translation::Prompt.furigana?(request)
    message = Translation::Prompt.user_message(request)

    assert_includes message, "<readings>off</readings>"
    # The glosses are bounded by MAX_GLOSSES whatever the length, so the level the reader chose
    # still travels: one switch turning off both annotations cost a Spanish reader definitions
    # for a cost only Japanese readings incur.
    assert_includes message, "<gloss_level>notable</gloss_level>"
  end

  test "the system prompt says what the readings switch does and does not turn off" do
    assert_includes Translation::Prompt::SYSTEM, "<readings>"
    assert_includes Translation::Prompt::SYSTEM, "The glosses are not affected by it"
    assert_not_includes Translation::Prompt::SYSTEM, "<annotations>",
      "one switch for both annotations is what the <readings> switch replaced"
  end

  test "a target that can have no readings is told so, however short the source" do
    request = Translation::Request.new(
      source_text: "Is this a bat?", source_language: Translation::Language::EN,
      target_language: Translation::Language::ES, context: nil
    )

    # Spanish has no kana to read, so asking for them invites output tokens and latency for a
    # string the reply can never carry. The switch and Result.for_request's gate read one
    # predicate, so neither can be told "on" while the other drops what comes back.
    assert_not Translation::Prompt.furigana?(request)
    assert_includes Translation::Prompt.user_message(request), "<readings>off</readings>"
  end

  test "the system prompt stays fixed text" do
    assert_not_includes Translation::Prompt::SYSTEM, "source_text>\n", "the source never reaches the system prompt"
  end

  private

  def request_of_length(length)
    Translation::Request.new(
      source_text: "あ" * length, source_language: Translation::Language::EN,
      target_language: Translation::Language::JA, context: nil
    )
  end
end
