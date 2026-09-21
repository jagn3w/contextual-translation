# frozen_string_literal: true

require "test_helper"

class Diary::PromptTest < ActiveSupport::TestCase
  # Every operation teaches from the shared TEACHER text, so the rule to teach the idiomatic
  # expression of what the student means — and to ask when that meaning is ambiguous — reaches the
  # review, the replies and the hints alike (docs/diary.md).
  test "every operation carries the idiomatic-meaning rule" do
    [ Diary::Prompt::REVIEW_SYSTEM, Diary::Prompt::REPLY_SYSTEM, Diary::Prompt::HINT_SYSTEM,
      Diary::Prompt::TOPICS_SYSTEM ].each do |system|
      assert_includes system, Diary::Prompt::TEACHER
    end
    assert_match(/ask which they mean/, Diary::Prompt::TEACHER)
  end

  test "a hint asks what an ambiguous request means before climbing the ladder" do
    assert_match(/instead of the hint at <level> ask which they mean/, Diary::Prompt::HINT_SYSTEM)
    assert_match(/without answering,\s+go with the most likely meaning/, Diary::Prompt::HINT_SYSTEM)
  end

  # As with Translation::Prompt::MAX_GLOSSES: a count Claude is told must be interpolated from the
  # constant the parser caps with, or what Claude is told can drift from what the app keeps.
  test "the counts the prompts state are interpolated, never spelled out" do
    words = { 1 => "one", 2 => "two", 3 => "three", 4 => "four", 5 => "five" }
    # Everything but the constants' own lines and the hint ladder, whose "- 3:" items are levels.
    source = Rails.root.join("app/services/diary/prompt.rb").read
      .gsub(/^\s*(MAX_ENTRY_NOTES|TOPIC_COUNT) =.*$/, "")
      .gsub(/^\s*- \d+( or more)?:.*$/, "")

    { "MAX_ENTRY_NOTES" => Diary::Prompt::MAX_ENTRY_NOTES, "TOPIC_COUNT" => Diary::Prompt::TOPIC_COUNT }.each do |name, value|
      assert_no_match(/\b#{value}\b/, source, "interpolate #{name} instead of writing #{value} out")
      assert_no_match(/\b#{words.fetch(value)}\b/i, source, "interpolate #{name} instead of writing #{words.fetch(value)}")
    end
    assert_includes Diary::Prompt::REVIEW_SYSTEM, "0 to #{Diary::Prompt::MAX_ENTRY_NOTES} entry-wide notes"
    assert_includes Diary::Prompt::REVIEW_SCHEMA.dig(:properties, :notes, :description),
      "0 to #{Diary::Prompt::MAX_ENTRY_NOTES}"
    assert_includes Diary::Prompt::TOPICS_SYSTEM, "exactly #{Diary::Prompt::TOPIC_COUNT} short"
  end

  test "the review prompt describes its context threads as they are selected" do
    assert_match(/including "help" threads/, Diary::Prompt::REVIEW_SYSTEM)
    assert_match(/only the most recent are included/, Diary::Prompt::REVIEW_SYSTEM)
    assert_match(/superseded="true"/, Diary::Prompt::REVIEW_SYSTEM)
  end
end
