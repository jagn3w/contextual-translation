# frozen_string_literal: true

require "test_helper"

# Result.for_request is the one path every Translator takes, so every rule that decides what the
# reader is shown holds for all of them — including a translator written after this test (design
# D2.4). That claim is only worth as much as the translator it is tested through, so the tests
# below run a translator this file defines, written the way the next one will be: knowing the
# Translator interface and none of the rules. Each rule it ignores is one the fake has shipped
# wrong at some point, with production correct and dev, CI and the frontend quietly not.
class Translation::ResultTest < ActiveSupport::TestCase
  class RuleIgnoringTranslator
    include Translation::Translator

    # Kanji runs at 毎日東京 (ending at 4) and 行 (ending at 6), so an annotation can be partial.
    TEXT = "毎日東京へ行きます"

    # It glosses the same two words at every level including NONE, puts a kana reading on both
    # whatever the target, and annotates 毎日東京 while leaving 行 bare — which the browser cannot
    # see is wrong, because nothing in the notation says how far back a reading reaches. It does
    # not translate, either: the target language changes nothing it returns, which is the point.
    def translate(request)
      Translation::Result.for_request(
        request:, text: TEXT, model: "rule-ignoring", furigana: "毎日東京《とうきょう》へ行きます",
        glosses: [
          Translation::Gloss.new(text: "東京", reading: "とうきょう", meaning: "Tokyo", starts_at: 2, length: 2),
          Translation::Gloss.new(text: "行", reading: "い", meaning: "to go", starts_at: 5, length: 1)
        ]
      )
    end
  end

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

  test "a translator that glosses at the NONE level still glosses nothing" do
    result = RuleIgnoringTranslator.new.translate(request(gloss_level: Translation::GlossLevel::NONE))

    assert_empty result.glosses, "the reader asked for no definitions; a translator cannot overrule that"
    assert_not result.glosses_truncated, "nothing was cut off — this is the list the reader asked for"
  end

  test "a translator that reads every gloss aloud keeps the readings for Japanese only" do
    spanish = RuleIgnoringTranslator.new.translate(request)
    japanese = RuleIgnoringTranslator.new.translate(request(target_language: Translation::Language::JA))

    assert_equal [ nil, nil ], spanish.glosses.map(&:reading), "kana over a Spanish word is not a reading of it"
    assert_equal %w[東京 行], spanish.glosses.map(&:text), "only the reading comes off; the gloss still travels"
    assert_equal [ "とうきょう", "い" ], japanese.glosses.map(&:reading)
  end

  test "a translator that annotates only part of its translation loses the whole annotation" do
    # 毎日東京《とうきょう》へ行きます leaves 行 bare, and the browser has no way to know: it reads
    # a group as the reading of the run in front of it and cannot see the translation to notice a
    # run that never got one. Rejecting it here turns a reading painted over the wrong characters
    # into the degrade this codebase prefers — no readings, and the reader told so.
    result = RuleIgnoringTranslator.new.translate(request(target_language: Translation::Language::JA))

    assert_equal RuleIgnoringTranslator::TEXT, result.text, "the translation is what must survive"
    assert_nil result.furigana
    assert result.readings_omitted, "a Japanese translation with no readings on it is worth saying out loud"
  end

  test "a Japanese target with no readings says so, whatever cost them" do
    # The reader is owed the same sentence in each of these, because from where they sit it is
    # the same fact: this Japanese text carries no readings. Which rule or limit took them is the
    # log's business (ClaudeTranslator#log_furigana_loss), not theirs.
    japanese = request(target_language: Translation::Language::JA)
    {
      "the source was too long for readings to be asked for" =>
        [ request(target_language: Translation::Language::JA, length: Translation::Prompt::FURIGANA_LIMIT + 1),
          "日本語", "日本語《にほんご》" ],
      "the translator offered none" => [ japanese, "日本語", nil ],
      "the translation has no kanji to annotate" => [ japanese, "ハローです", "" ],
      "the annotation does not strip back to the translation" => [ japanese, "日本語", "英語《えいご》" ],
      "the translation carries 《…》 of its own, which the notation cannot hold" =>
        [ japanese, "彼は《こころ》を読んだ", "彼《かれ》は《こころ》を読《よ》んだ" ]
    }.each do |cause, (for_request, text, furigana)|
      result = Translation::Result.for_request(request: for_request, text:, model: "any", furigana:)

      assert_nil result.furigana, cause
      assert result.readings_omitted, cause
    end
  end

  private

  def request(target_language: Translation::Language::ES, length: 10,
              gloss_level: Translation::GlossLevel::NOTABLE)
    Translation::Request.new(
      source_text: "a" * length, source_language: Translation::Language::EN, target_language:, context: nil,
      gloss_level:
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
