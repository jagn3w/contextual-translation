# typed: strict
# frozen_string_literal: true

module Translation
  # Where each gloss sits in the translation, asked once for every translator rather than
  # re-derived by each of them (design D2.3). It is the same move Result.for_request makes for
  # the gloss cap and the furigana gate: a rule every call site has to remember is itself the
  # defect. FakeTranslator kept its own plain-substring version of this and so pinned a gloss of
  # "me" to the "me" inside "memo" — a disagreement its tests could not see, because a span that
  # holds the right characters in the wrong place still extracts the right word.
  #
  # One locator serves one translation: it carries the cursor, so successive calls hand back
  # successive occurrences and the spans come out in order and non-overlapping, which is what
  # lets the UI underline a repeated word once per mention.
  class GlossLocator
    extend T::Sig

    # A character that counts as part of a word when deciding whether a gloss's text sits inside
    # a longer one. Unicode-aware, so it covers accented Spanish as well as English.
    WORD_CHARACTER = /[[:word:]]/

    sig { params(translation: String, language: Language).void }
    def initialize(translation:, language:)
      @translation = translation
      @language = language
      @cursor = T.let(0, Integer)
    end

    # Where to underline the gloss: the first occurrence at or after the end of the one located
    # before it. nil when no occurrence is left, which is a gloss the reader cannot be shown at
    # all — the caller drops it rather than guess. A located gloss advances the cursor; a missing
    # one leaves it where it was, so the glosses that follow still get their turn.
    #
    # Offsets count Unicode code points, which is what String#index and String#length return,
    # and what the UI counts too.
    sig { params(text: String).returns(T.nilable(Integer)) }
    def locate(text)
      at = first_occurrence(text)
      return nil if at.nil?

      @cursor = at + text.length
      at
    end

    private

    # In a space-delimited target the occurrence has to be a whole word — a gloss of "age"
    # belongs to "the age of consent", not to the "age" inside "message", and pinning it to the
    # wrong one underlines the wrong characters and pushes the cursor past the real word,
    # dropping the glosses that follow. Japanese writes no boundaries, so a gloss there is
    # legitimately inside a longer run and plain substring search is the only thing that can be
    # meant (design D2.3). If no whole-word occurrence is left, the raw index still beats losing
    # the entry.
    sig { params(text: String).returns(T.nilable(Integer)) }
    def first_occurrence(text)
      raw = @translation.index(text, @cursor)
      return raw unless @language.space_delimited?

      whole_word_index(text) || raw
    end

    # The first occurrence at or after the cursor with no word character against either end.
    sig { params(text: String).returns(T.nilable(Integer)) }
    def whole_word_index(text)
      at = T.let(@translation.index(text, @cursor), T.nilable(Integer))
      while at
        before = at.zero? ? nil : @translation[at - 1]
        return at unless word_character?(before) || word_character?(@translation[at + text.length])

        at = @translation.index(text, at + 1)
      end
      nil
    end

    sig { params(character: T.nilable(String)).returns(T::Boolean) }
    def word_character?(character)
      !character.nil? && character.match?(WORD_CHARACTER)
    end
  end
end
