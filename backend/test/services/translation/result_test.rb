# frozen_string_literal: true

require "test_helper"

# Result.for_request is the one path every Translator takes, so the cap and the two degrade flags
# hold for all of them — including a translator written after this test (design D2.4).
class Translation::ResultTest < ActiveSupport::TestCase
  test "the gloss cap holds for any translator, whatever it offers" do
    offered = glosses(Translation::Prompt::MAX_GLOSSES + 5)

    result = Translation::Result.for_request(request: request, text: text_of(offered), model: "any", glosses: offered)

    assert_equal Translation::Prompt::MAX_GLOSSES, result.glosses.size
    assert result.glosses_truncated, "a list the cap cut is a degrade the reader has to be told about"
  end

  test "a list that fits is not flagged as truncated" do
    offered = glosses(2)

    result = Translation::Result.for_request(request: request, text: text_of(offered), model: "any", glosses: offered)

    assert_equal 2, result.glosses.size
    assert_not result.glosses_truncated
  end

  test "furigana survives a Japanese request inside the limit" do
    result = Translation::Result.for_request(
      request: request(target_language: Translation::Language::JA), text: "日本語", model: "any",
      furigana: "日本語《にほんご》"
    )

    assert_equal "日本語《にほんご》", result.furigana
    assert_not result.readings_omitted
  end

  test "a Japanese request over the limit drops the furigana and says the readings were omitted" do
    result = Translation::Result.for_request(
      request: request(target_language: Translation::Language::JA, length: Translation::Prompt::FURIGANA_LIMIT + 1),
      text: "日本語", model: "any", furigana: "日本語《にほんご》"
    )

    assert_nil result.furigana, "a translator that annotates anyway must not spend the reply on it"
    assert result.readings_omitted
  end

  test "a non-Japanese target never reports omitted readings, at any length" do
    [ 1, Translation::Prompt::FURIGANA_LIMIT + 1 ].each do |length|
      result = Translation::Result.for_request(
        request: request(length:), text: "un bate", model: "any", furigana: "un bate《ベイト》"
      )

      assert_nil result.furigana, length
      assert_not result.readings_omitted, "absent readings are normal for Spanish, not a degrade"
    end
  end

  private

  def request(target_language: Translation::Language::ES, length: 10)
    Translation::Request.new(
      source_text: "a" * length, source_language: Translation::Language::EN, target_language:, context: nil
    )
  end

  def glosses(count)
    cursor = 0
    (1..count).map do |n|
      word = "word#{n}"
      gloss = Translation::Gloss.new(text: word, reading: nil, meaning: "number #{n}", starts_at: cursor,
        length: word.length)
      cursor += word.length + 1
      gloss
    end
  end

  def text_of(glosses)
    glosses.map(&:text).join(" ")
  end
end
