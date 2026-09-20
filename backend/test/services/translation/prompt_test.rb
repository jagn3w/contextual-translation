# frozen_string_literal: true

require "test_helper"

class Translation::PromptTest < ActiveSupport::TestCase
  test "the gloss cap is interpolated everywhere it is stated, never spelled out" do
    cap = Translation::Prompt::MAX_GLOSSES.to_s
    # Everything but the constant's own line: a literal here would let the number Claude is told
    # drift from the number ClaudeTranslator actually keeps.
    source = Rails.root.join("app/services/translation/prompt.rb").read.sub(/^\s*MAX_GLOSSES =.*$/, "")

    assert_not_includes source, cap, "interpolate MAX_GLOSSES instead of writing #{cap} out"
    assert_includes Translation::Prompt::SYSTEM, "stop at #{cap} entries"
    assert_includes Translation::Prompt::OUTPUT_SCHEMA.dig(:properties, :glosses, :description), "at most #{cap}."
  end

  test "a source within the annotation limit asks for annotations" do
    message = Translation::Prompt.user_message(request_of_length(Translation::Prompt::ANNOTATION_LIMIT))

    assert_includes message, "<annotations>on</annotations>"
  end

  test "a longer source asks for none, so a long translation is not competing with them" do
    request = request_of_length(Translation::Prompt::ANNOTATION_LIMIT + 1)

    assert_not Translation::Prompt.annotations?(request)
    assert_includes Translation::Prompt.user_message(request), "<annotations>off</annotations>"
  end

  test "the system prompt says what the off switch means, and stays fixed text" do
    assert_includes Translation::Prompt::SYSTEM, "<annotations>"
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
