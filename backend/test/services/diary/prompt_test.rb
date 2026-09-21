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
end
