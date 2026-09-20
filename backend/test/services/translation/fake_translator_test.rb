# frozen_string_literal: true

require "test_helper"

class Translation::FakeTranslatorTest < ActiveSupport::TestCase
  test "is deterministic and tags the target language" do
    request = Translation::Request.new(
      source_text: "Hello", source_language: Translation::Language::EN,
      target_language: Translation::Language::JA, context: "At work"
    )

    result = Translation::FakeTranslator.new.translate(request)

    assert_equal "[日本語] Hello", result.text
    assert_equal "Fake translation using context: At work", result.notes
    assert_equal "fake", result.model
    assert_equal "[日本語《にほんご》] Hello", result.furigana
    assert_equal result.text, result.furigana.gsub(/《[^》]*》/, ""), "furigana must strip back to the text"
    assert_not result.readings_omitted
  end

  test "every reading the fake emits annotates kanji, the way a real one does" do
    # A 《…》 group reads the run of kanji in front of it; one that follows anything else is not a
    # reading of anything, and a renderer is right to drop it.
    furigana = T.must(translate("Hello", target_language: Translation::Language::JA).furigana)

    bases = furigana.scan(/(.)《/).flatten

    assert_not_empty bases, "the fake has to emit a reading, or nothing exercises ruby rendering"
    bases.each { |base| assert_match(/\p{Han}/, base, "#{base} is not kanji: #{furigana}") }
  end

  test "a Japanese target gets glosses whose spans really are in the text" do
    glosses = translate("Hello", target_language: Translation::Language::JA).glosses

    assert_equal [ "[日本語]", "Hello" ], glosses.map(&:text)
    assert_equal [ "にほんご", nil ], glosses.map(&:reading)
    assert glosses.all? { |gloss| gloss.meaning.present? }, "every gloss needs a meaning"
    glosses.each do |gloss|
      assert_equal gloss.text, "[日本語] Hello"[gloss.starts_at, gloss.length], "the span must hold the word"
    end
    assert_operator T.must(glosses.first).starts_at + T.must(glosses.first).length, :<=, T.must(glosses.last).starts_at
  end

  test "only a Japanese target gets furigana, but every target gets glosses" do
    result = translate("Hello", target_language: Translation::Language::ES)

    assert_equal "[ES] Hello", result.text
    assert_nil result.furigana
    assert_not result.readings_omitted, "Spanish never had readings to omit"
    # A space-delimited target glosses too, so the dev path exercises the locating that
    # ClaudeTranslator does by word boundary there (design D2.3).
    assert_equal [ "[ES]", "Hello" ], result.glosses.map(&:text)
    assert_equal [ nil, nil ], result.glosses.map(&:reading), "kana readings are the Japanese feature"
  end

  test "a source over the furigana limit omits the readings, as production does" do
    long = "yo " * Translation::Prompt::FURIGANA_LIMIT

    result = translate(long, target_language: Translation::Language::JA)

    assert_nil result.furigana
    assert result.readings_omitted, "dev and CI have to be able to reach the degraded state"
  end

  test "a source with more words than the cap truncates the gloss list, as production does" do
    long = (1..(Translation::Prompt::MAX_GLOSSES + 10)).map { |n| "word#{n}" }.join(" ")

    result = translate(long, gloss_level: Translation::GlossLevel::EVERY)

    assert_equal Translation::Prompt::MAX_GLOSSES, result.glosses.size
    assert result.glosses_truncated, "the fake must be able to show what an overrun looks like"
  end

  test "the NONE level glosses nothing" do
    assert_empty glosses_at(Translation::GlossLevel::NONE)
  end

  test "the NOTABLE level glosses the handful worth remarking on" do
    assert_equal [ "[日本語]", "world" ], glosses_at(Translation::GlossLevel::NOTABLE).map(&:text)
  end

  test "the EVERY level glosses visibly more than NOTABLE" do
    every = glosses_at(Translation::GlossLevel::EVERY)

    assert_equal [ "[日本語]", "Hello", "there", "world" ], every.map(&:text)
    assert_operator every.size, :>, glosses_at(Translation::GlossLevel::NOTABLE).size
  end

  test "every level's spans really are in the text, in order and non-overlapping" do
    Translation::GlossLevel.values.each do |level|
      glosses = glosses_at(level)
      text = "[日本語] Hello there world"
      glosses.each_cons(2) { |a, b| assert_operator a.starts_at + a.length, :<=, b.starts_at, level.serialize }
      glosses.each do |gloss|
        assert_equal gloss.text, text[gloss.starts_at, gloss.length], level.serialize
        assert gloss.meaning.present?, "every gloss needs a meaning"
      end
    end
  end

  private

  def translate(source_text, target_language: Translation::Language::JA, gloss_level: Translation::GlossLevel::NOTABLE)
    request = Translation::Request.new(
      source_text:, source_language: Translation::Language::EN, target_language:, context: nil, gloss_level:
    )
    Translation::FakeTranslator.new.translate(request)
  end

  def glosses_at(gloss_level, target_language: Translation::Language::JA)
    translate("Hello there world", target_language:, gloss_level:).glosses
  end
end
