# frozen_string_literal: true

require "test_helper"

class Translation::FakeTranslatorTest < ActiveSupport::TestCase
  test "is deterministic and tags the target language" do
    request = Translation::Request.new(
      source_text: "Hello", source_language: Translation::Language::EN,
      target_language: Translation::Language::JA, context: "At work"
    )

    result = Translation::FakeTranslator.new.translate(request)

    assert_equal "[JA] Hello", result.text
    assert_equal "Fake translation using context: At work", result.notes
    assert_equal "fake", result.model
    assert_equal "[JA]《ジェイエー》 Hello", result.furigana
    assert_equal result.text, result.furigana.gsub(/《[^》]*》/, ""), "furigana must strip back to the text"
  end

  test "a Japanese target gets glosses whose spans really are in the text" do
    request = Translation::Request.new(
      source_text: "Hello", source_language: Translation::Language::EN,
      target_language: Translation::Language::JA, context: nil
    )

    glosses = Translation::FakeTranslator.new.translate(request).glosses

    assert_equal [ "[JA]", "Hello" ], glosses.map(&:text)
    assert_equal [ "ジェイエー", nil ], glosses.map(&:reading)
    assert glosses.all? { |gloss| gloss.meaning.present? }, "every gloss needs a meaning"
    glosses.each do |gloss|
      assert_equal gloss.text, "[JA] Hello"[gloss.starts_at, gloss.length], "the span must hold the word"
    end
    assert_operator T.must(glosses.first).starts_at + T.must(glosses.first).length, :<=, T.must(glosses.last).starts_at
  end

  test "only a Japanese target gets furigana" do
    request = Translation::Request.new(
      source_text: "Hello", source_language: Translation::Language::EN,
      target_language: Translation::Language::ES, context: nil
    )

    result = Translation::FakeTranslator.new.translate(request)

    assert_equal "[ES] Hello", result.text
    assert_nil result.furigana
    assert_empty result.glosses
  end
end
