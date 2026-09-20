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

  test "only a Japanese target gets furigana, but every target gets glosses" do
    request = Translation::Request.new(
      source_text: "Hello", source_language: Translation::Language::EN,
      target_language: Translation::Language::ES, context: nil
    )

    result = Translation::FakeTranslator.new.translate(request)

    assert_equal "[ES] Hello", result.text
    assert_nil result.furigana
    # A space-delimited target glosses too, so the dev path exercises the locating that
    # ClaudeTranslator does by word boundary there (design D2.3).
    assert_equal [ "[ES]", "Hello" ], result.glosses.map(&:text)
    assert_equal [ nil, nil ], result.glosses.map(&:reading), "kana readings are the Japanese feature"
  end

  test "the NONE level glosses nothing" do
    assert_empty glosses_at(Translation::GlossLevel::NONE)
  end

  test "the NOTABLE level glosses the handful worth remarking on" do
    assert_equal [ "[JA]", "world" ], glosses_at(Translation::GlossLevel::NOTABLE).map(&:text)
  end

  test "the EVERY level glosses visibly more than NOTABLE" do
    every = glosses_at(Translation::GlossLevel::EVERY)

    assert_equal [ "[JA]", "Hello", "there", "world" ], every.map(&:text)
    assert_operator every.size, :>, glosses_at(Translation::GlossLevel::NOTABLE).size
  end

  test "every level's spans really are in the text, in order and non-overlapping" do
    Translation::GlossLevel.values.each do |level|
      glosses = glosses_at(level)
      text = "[JA] Hello there world"
      glosses.each_cons(2) { |a, b| assert_operator a.starts_at + a.length, :<=, b.starts_at, level.serialize }
      glosses.each do |gloss|
        assert_equal gloss.text, text[gloss.starts_at, gloss.length], level.serialize
        assert gloss.meaning.present?, "every gloss needs a meaning"
      end
    end
  end

  private

  def glosses_at(gloss_level, target_language: Translation::Language::JA)
    request = Translation::Request.new(
      source_text: "Hello there world", source_language: Translation::Language::EN,
      target_language:, context: nil, gloss_level:
    )
    Translation::FakeTranslator.new.translate(request).glosses
  end
end
