# frozen_string_literal: true

require "test_helper"

class TranslationTest < ActiveSupport::TestCase
  test "builds the fake translator by default" do
    assert_instance_of Translation::FakeTranslator, Translation.build_translator({})
  end

  test "builds the Claude translator with the configured model and effort" do
    translator = Translation.build_translator(
      "TRANSLATOR" => "claude", "CLAUDE_AUTH" => "api_key", "ANTHROPIC_API_KEY" => "k",
      "CLAUDE_MODEL" => "claude-sonnet-5", "CLAUDE_EFFORT" => "low"
    )

    assert_instance_of Translation::ClaudeTranslator, translator
    assert_equal "claude-sonnet-5", translator.instance_variable_get(:@model)
    assert_equal "low", translator.instance_variable_get(:@effort)
  end

  test "rejects an unknown translator" do
    assert_raises(ArgumentError) { Translation.build_translator("TRANSLATOR" => "gpt") }
  end
end
