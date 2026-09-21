# typed: strict
# frozen_string_literal: true

module Translation
  # Deterministic stand-in used by tests, CI and frontend development (TRANSLATOR=fake), so none
  # of them need an API key or spend money (design D2.4).
  class FakeTranslator
    extend T::Sig
    include Translator

    MODEL = "fake"
    # The word a Japanese fake translation is tagged with, and its reading. Kanji on purpose: a
    # 《…》 reading annotates the run of kanji in front of it, so a tag of "[JA]" gave the dev and
    # CI paths ruby text with nothing to attach to and no way to catch a renderer that mishandles
    # it.
    JA_TAG_WORD = "日本語"
    JA_TAG_READING = "にほんご"
    # What every other run of kanji is read as — the source text's own kanji, which reach the fake
    # translation unchanged and which a fake translator has no way to read. It is visibly a
    # stand-in rather than a plausible reading, so nobody mistakes the dev path for a translator.
    STAND_IN_READING = "かな"

    sig { override.params(request: Request).returns(Result) }
    def translate(request)
      text = "#{tag(request)} #{request.source_text}"
      notes = request.context.present? ? "Fake translation using context: #{request.context}" : nil
      # Result.for_request applies every rule here exactly as it does for ClaudeTranslator — the
      # gloss level and cap, the Japanese-only kana readings, the furigana limit and the
      # annotation rules — so the fake degrades the way production does and dev and CI can see
      # the truncated gloss list and the omitted readings for themselves (design D2.4).
      Result.for_request(request:, text:, notes:, furigana: furigana_for(text),
        glosses: glosses_for(text, request), model: MODEL)
    end

    private

    # `text` with a reading after every run of kanji, so the dev and test paths exercise ruby
    # rendering — the tag reads にほんご and anything the source brought with it gets the stand-in.
    # Every run, not just the tag's: Result.for_request rejects an annotation that leaves a run
    # bare (Furigana), because a reader shown one reading and no other cannot tell which run it
    # was written for. A source carrying kanji used to make the fake's furigana exactly that, and
    # the browser dropped the whole string rather than paint it.
    #
    # Whether this request wanted readings at all — a Japanese target, a source inside the limit —
    # is not asked here: Result.for_request asks it of every translator, and the fake offering
    # readings a Spanish request will not keep is what makes that gate visible on the dev and CI
    # path instead of merely assumed (design D2.4). Nor does this promise the result is usable:
    # a source with 《…》 of its own cannot be annotated at all, and the fake is how dev and CI
    # reach that degrade.
    sig { params(text: String).returns(String) }
    def furigana_for(text)
      text.gsub(Furigana::KANJI_RUN) do |run|
        "#{run}《#{run == JA_TAG_WORD ? JA_TAG_READING : STAND_IN_READING}》"
      end
    end

    # The fake honours <gloss_level> so the dev and CI paths exercise the picker instead of
    # showing the same list whatever the reader chose — the gate can only test the feature if the
    # translator it runs has it (design D2.4). Every target gets glosses, not just Japanese, so
    # the space-delimited spans ClaudeTranslator has to locate by word boundary are exercised too.
    sig { params(text: String, request: Request).returns(T::Array[Gloss]) }
    def glosses_for(text, request)
      level = request.gloss_level
      words =
        case level
        # NONE is not a case of its own: Result.for_request drops the list for it, on the one path
        # every translator takes, and the fake offering words it will not keep is what exercises
        # that rule in dev and CI rather than leaving it assumed (design D2.4).
        #
        # A couple of entries, standing in for "the ones worth remarking on": the language tag
        # and the last word of the fake translation.
        when GlossLevel::NONE, GlossLevel::NOTABLE then [ tag(request), T.must(text.split.last) ].uniq
        # Every word, which is visibly more than NOTABLE for anything but a one-word source — and
        # for a source of more than Prompt::MAX_GLOSSES words, more than the cap keeps.
        when GlossLevel::EVERY then text.split
        else T.absurd(level)
        end
      glosses_at(words, text, request)
    end

    # Spans are located by GlossLocator, the same object ClaudeTranslator places Claude's glosses
    # with, so they really are substrings of `text` and never overlap — and so the dev and CI
    # paths exercise the production rule rather than a second, plainer one. They did once: a
    # local `text.index` put the gloss for "me" on the "me" inside "memo", which the fake's own
    # tests could not catch, because the wrong occurrence still holds the right characters
    # (design D2.4).
    sig { params(words: T::Array[String], text: String, request: Request).returns(T::Array[Gloss]) }
    def glosses_at(words, text, request)
      locator = GlossLocator.new(translation: text, language: request.target_language)
      words.filter_map do |word|
        starts_at = locator.locate(word)
        next if starts_at.nil?

        is_tag = word == tag(request)
        # The tag carries a kana reading whatever the target, so that a Spanish request really
        # does arrive at Result.for_request with a reading on it and the "kana readings are the
        # Japanese feature" rule is exercised rather than taken on trust (design D2.4).
        Gloss.new(
          text: word, meaning: is_tag ? "fake target-language tag" : "fake definition of #{word}",
          reading: is_tag ? JA_TAG_READING : nil, starts_at:, length: word.length
        )
      end
    end

    sig { params(request: Request).returns(String) }
    def tag(request)
      return "[#{JA_TAG_WORD}]" if request.target_language == Language::JA

      "[#{request.target_language.serialize.upcase}]"
    end
  end
end
