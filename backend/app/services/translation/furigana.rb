# typed: strict
# frozen_string_literal: true

module Translation
  # The furigana notation, and the rules that say whether a string is a usable one (design D2.3).
  #
  # Every Ruby spelling of the notation lives here — the 《…》 group, and what a run of kanji is —
  # because the browser keeps its own copy of both (frontend/app/src/lib/furigana.ts) and the two
  # have to agree character for character. They have drifted before: a Ruby pattern that allowed
  # 《 inside a reading accepted 漢字《かん《じ》 as a clean round trip and shipped it, and the
  # browser, which reads that as the single group 《じ》, failed its own check and dropped every
  # reading in the reply. One home per side, and a test (claude_translator_test.rb) that fails if
  # a second Ruby spelling appears anywhere.
  #
  # Result.for_request is the only caller. The rules are asked of whatever any translator returns
  # rather than of Claude's reply alone, because the translator that forgets them is always the
  # next one — it was the fake that last shipped furigana its own text could not strip back to
  # (design D2.4).
  module Furigana
    extend T::Sig

    # A reading and its brackets. The reading may contain neither bracket, which is exactly what
    # the browser's READING_GROUP says; see the drift note above for what a looser one costs.
    READING_GROUP = /《[^《》]*》/
    # A group with nothing in it. The browser renders no ruby for one, so a run carrying only
    # this is a run with no reading on it, however annotated it looks.
    EMPTY_READING = "《》"
    # Either bracket, anywhere. U+300A/U+300B are ordinary Japanese punctuation — book titles,
    # emphasis — and the system prompt asks Claude to keep the original's punctuation style, so a
    # translation may legitimately contain a pair of them. The notation has no room for it: the
    # browser deletes every 《…》 group it finds, so a literal pair in the translation would
    # vanish from the text the reader selects and copies, and there is no escape to write it with
    # short of a notation change on both sides. Such a translation therefore travels without
    # readings — cleanly, with Result#readings_omitted saying so — rather than with a hole in it.
    BRACKET = /[《》]/

    # What a reading may be written over, in the two classes the browser splits them into and for
    # the reasons its comments give at length. KANJI is what a run may begin and end with: CJK
    # Unified Ideographs and Extension A, the compatibility ideographs (the 﨑 of a name like
    # 宮﨑), the astral extensions through the compatibility supplement (𠮟, 𩸽 and most rare
    # surname characters), and the marks that appear only in a kanji word and never in a katakana
    # one — 〇, 々 and 〆.
    KANJI = /[〇々〆㐀-䶿一-鿿\u{F900}-\u{FAFF}\u{20000}-\u{2FA1F}]/
    # What a run may contain but never begin or end with: the full-size ケ カ ノ ツ of 霞ケ関, 一カ月,
    # 一ノ瀬 and 四ツ谷, and the small ヶ ヵ of 三ヶ月 / 一ヵ月. Every one is also an ordinary katakana
    # letter, so they are admitted only with a true kanji on both sides — which is what keeps
    # バケツ水 from being read as the run ケツ水.
    KANJI_INTERIOR = /[ヵヶカケノツ]/
    # One maximal run. The same two classes in the same order as the browser's KANJI_RUN, minus
    # its trailing anchor: there the question is which run ends the text before a group, here it
    # is where every run in the translation is, so this one is scanned rather than anchored. It
    # is still maximal at each position — leftmost, and greedy up to the last true kanji it can
    # reach, so a trailing ケ or ツ is trimmed back off the end exactly as it is there.
    KANJI_RUN = /#{KANJI.source}(?:(?:#{KANJI.source}|#{KANJI_INTERIOR.source})*#{KANJI.source})?/

    # The annotation to send on, or nil for anything that is not one: not a string, no readings in
    # it at all (the empty string the prompt asks for when there is nothing to annotate), or a
    # string that breaks one of the rules below. nil is a clean degrade — the reader gets the
    # translation as plain text and is told the readings are missing — where a string that breaks
    # a rule is a reading written over characters it was never meant for, in the one pane people
    # are reading Japanese out of.
    sig { params(value: T.untyped, text: String).returns(T.nilable(String)) }
    def self.checked(value, text)
      return nil unless value.is_a?(String) && value.match?(READING_GROUP)

      rejection(value, text).nil? ? value : nil
    end

    # Which rule `checked` turned a string down on, as a short phrase fit for a log: it names a
    # rule and never a character of the user's text (design D4.2). nil when there is nothing to
    # reject — the string passes, or carries no readings for us to be losing.
    #
    # The rules, in the order a failure is worth hearing about:
    #   - The translation contains a bracket of its own, which the notation cannot carry (BRACKET).
    #     Stripping back would fail anyway — the translation's own 《…》 comes out with the
    #     readings — so this only names the cause, which is the difference between a warning that
    #     reads as a model defect and one that reads as ordinary punctuation nobody can annotate.
    #   - Removing every group must give the translation back character for character. This is the
    #     contract the prompt states and the browser re-checks; anything else is a reworded,
    #     truncated or invented second translation.
    #   - Every group must carry a reading, and the groups must sit one per maximal run of kanji,
    #     in order. Furigana notation carries no base length, so the browser can only infer that a
    #     reading belongs to the run of kanji in front of it. That inference is exact when every
    #     run has its own group and no group sits anywhere else — the browser's base is then the
    #     same run this side measured. Partial annotation is what breaks it: 新型肺炎の記事 annotated
    #     only as 新型肺炎《はいえん》 leaves 記事 bare, and the reader would be shown はいえん over
    #     新型肺炎 with nothing able to catch it.
    #     What this cannot see is a group that sits after a whole run but was written for part of
    #     it — 毎日東京《とうきょう》 is one run with one group, and no rule on either side can know
    #     とうきょう was meant for 東京 alone. Only the prompt can ask for the whole run's reading,
    #     and it does, in so many words.
    sig { params(value: T.untyped, text: String).returns(T.nilable(String)) }
    def self.rejection(value, text)
      return nil unless value.is_a?(String) && value.match?(READING_GROUP)
      return "the translation contains 《 or 》 of its own" if text.match?(BRACKET)
      return "it does not strip back to the translation" unless value.gsub(READING_GROUP, "") == text
      return "a reading is empty" if value.include?(EMPTY_READING)
      return "the readings do not sit one per run of kanji" unless annotated_at(value) == kanji_run_ends(text)

      nil
    end

    # Where each group sits, counted in the plain translation: how many characters precede it once
    # the groups already passed are taken back out. That is the offset the browser's `pending` has
    # reached when it meets the same group, which is what makes comparing these against the ends
    # of the kanji runs the same question the browser would ask if it could see the translation.
    sig { params(furigana: String).returns(T::Array[Integer]) }
    def self.annotated_at(furigana)
      offsets = T.let([], T::Array[Integer])
      plain = T.let(0, Integer)
      cursor = T.let(0, Integer)
      while (group = READING_GROUP.match(furigana, cursor))
        plain += group.begin(0) - cursor
        offsets << plain
        cursor = group.end(0)
      end
      offsets
    end
    private_class_method :annotated_at

    # Where each maximal run of kanji ends, in the same counting: a group annotates the run it
    # comes straight after, so a run's end is the one offset a group for it may sit at.
    sig { params(text: String).returns(T::Array[Integer]) }
    def self.kanji_run_ends(text)
      ends = T.let([], T::Array[Integer])
      text.scan(KANJI_RUN) { ends << T.must(Regexp.last_match).end(0) }
      ends
    end
    private_class_method :kanji_run_ends
  end
end
