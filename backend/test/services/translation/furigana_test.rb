# frozen_string_literal: true

require "test_helper"

# The annotation rules, asked of the string itself. Result.for_request is what asks them of a
# translator's reply (result_test.rb); this is where each rule's own case lives.
class Translation::FuriganaTest < ActiveSupport::TestCase
  test "the translation with a reading after every run of kanji is what an annotation is" do
    text = "これは野球のバットですか？"
    furigana = "これは野球《やきゅう》のバットですか？"

    assert_equal furigana, Translation::Furigana.checked(furigana, text)
    assert_nil Translation::Furigana.rejection(furigana, text)
  end

  test "a string that is not one, or carries no readings at all, is nothing to reject" do
    # The prompt asks for an empty string when there is nothing to annotate, and structured
    # outputs can still hand back a number or a null. Neither is a furigana and neither is a
    # reading Claude tried to give the reader, so neither is worth a warning in the log.
    [ nil, 42, "", "これは野球のバットですか？" ].each do |value|
      assert_nil Translation::Furigana.checked(value, "これは野球のバットですか？"), value.inspect
      assert_nil Translation::Furigana.rejection(value, "これは野球のバットですか？"), value.inspect
    end
  end

  test "a translation with 《…》 of its own cannot be annotated, and the log says why" do
    # U+300A/U+300B are ordinary Japanese punctuation — book titles, emphasis — and the prompt
    # asks Claude to keep the original's punctuation style, so `He recommended 《Kokoro》 to me.`
    # translates to a sentence carrying a pair of them. The notation has no way to hold that: the
    # browser deletes every 《…》 group it finds, so the title itself would disappear from the
    # text the reader copies. The readings give way instead — and the reason is named, because
    # "it does not strip back" reads as a model defect where this is punctuation nobody can
    # annotate. Result#readings_omitted is what tells the reader (result_test.rb).
    text = "彼は《こころ》を勧めてくれた。"
    furigana = "彼《かれ》は《こころ》を勧《すす》めてくれた。"

    assert_nil Translation::Furigana.checked(furigana, text)
    assert_equal "the translation contains 《 or 》 of its own", Translation::Furigana.rejection(furigana, text)
  end

  test "an annotation that leaves a run of kanji bare is rejected whole" do
    # Annotating only the unfamiliar part is ordinary furigana convention on paper, and here it
    # is a wrong reading nothing downstream can catch: the notation records no base length, so
    # the browser can only read はいえん as the reading of the run in front of it — 新型肺炎, four
    # characters it was never written for. Nothing in the string is malformed, and the round trip
    # passes. Only the translation, which this side has and the browser doesn't, shows 記事 left
    # bare. So the whole string goes, and the reader is told there are no readings rather than
    # shown one that is a lie.
    text = "新型肺炎の記事"
    furigana = "新型肺炎《はいえん》の記事"

    assert_equal "the readings do not sit one per run of kanji", Translation::Furigana.rejection(furigana, text)
    assert_nil Translation::Furigana.checked(furigana, text)
  end

  test "a reading that sits after anything but a run of kanji is rejected whole" do
    # お願い《おねがい》 is the same defect from the other end: the group follows the い, so the
    # browser has no run to put おねがい over and drops that reading — while 願 stands there
    # unannotated. The browser dropping one reading quietly is exactly the silence this rule
    # exists to break.
    text = "お願いします"
    furigana = "お願い《おねがい》します"

    assert_equal "the readings do not sit one per run of kanji", Translation::Furigana.rejection(furigana, text)
  end

  test "a reading written for part of the run it follows is accepted, because nothing can measure it" do
    # The limit of the rule above, stated so nobody reads more into it than it says. 毎日東京 is
    # one maximal run, so 毎日東京《とうきょう》 has its group in the only place a group for that
    # run can sit; both sides agree on the base, and neither can know とうきょう was meant for
    # 東京 alone. Nothing but the prompt can ask for the whole run's reading, and it does, in so
    # many words (Prompt::SYSTEM).
    text = "毎日東京へ行きます"
    furigana = "毎日東京《とうきょう》へ行《い》きます"

    assert_equal furigana, Translation::Furigana.checked(furigana, text)
  end

  test "an annotation that is not the translation over again is rejected" do
    text = "これは野球のバットですか？"
    furigana = "これは野球《やきゅう》の secret バットですか？"

    assert_equal "it does not strip back to the translation", Translation::Furigana.rejection(furigana, text)
  end

  test "a reading holding an opening bracket is not one group, because the browser says it isn't" do
    # The browser's READING_GROUP allows neither bracket inside a reading, so it reads this as the
    # single group 《じ》 with 《かん before it. A Ruby pattern that allowed an opening bracket
    # there swallowed 《かん《じ》 whole, got 漢字 back and shipped furigana the browser then threw
    # away entirely — every reading in the reply lost, silently.
    assert_nil Translation::Furigana.checked("漢字《かん《じ》", "漢字")
  end

  test "a group with nothing in it annotates nothing, so it is rejected too" do
    # The browser renders no ruby for an empty reading, which would leave 漢字 bare while the
    # string looks annotated.
    assert_equal "a reading is empty", Translation::Furigana.rejection("漢字《》を書《か》く", "漢字を書く")
  end

  test "a run is what the browser says a run is, at every boundary it has a rule for" do
    # These are the cases frontend/app/src/lib/furigana.ts names one by one, each annotated the
    # way the browser would read it. Ruby and TypeScript decide independently where a run starts
    # and ends, and a disagreement here is a furigana this side accepts and the browser drops, or
    # the other way about — so every boundary the browser documents is exercised against the same
    # example.
    {
      # Full-size ケ, ノ, ツ and small ヶ inside a run: 霞ケ関, 一ノ瀬, 四ツ谷, 一ヶ月.
      "霞ケ関に行く" => "霞ケ関《かすみがせき》に行《い》く",
      "一ノ瀬さん" => "一ノ瀬《いちのせ》さん",
      "四ツ谷まで" => "四ツ谷《よつや》まで",
      "一ヶ月です" => "一ヶ月《いっかげつ》です",
      # The same letters as ordinary katakana: バケツ水 is the run 水, never ケツ水.
      "バケツ水" => "バケツ水《みず》",
      # A run may not end on one either, so 日本語ケーキ is the run 日本語.
      "日本語ケーキ" => "日本語《にほんご》ケーキ",
      # The marks that appear only in a kanji word: 〇, 々 and 〆.
      "〇〇株式会社" => "〇〇株式会社《まるまるかぶしきがいしゃ》",
      "人々が集まる" => "人々《ひとびと》が集《あつ》まる",
      # A compatibility ideograph (the 﨑 of 宮﨑) and an astral extension (𠮟).
      "宮﨑さん" => "宮﨑《みやざき》さん",
      "𠮟る" => "𠮟《しか》る"
    }.each do |text, furigana|
      assert_equal furigana, Translation::Furigana.checked(furigana, text), text
    end
  end
end
