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

    sig { override.params(request: Request).returns(Result) }
    def translate(request)
      text = "#{tag(request)} #{request.source_text}"
      notes = request.context.present? ? "Fake translation using context: #{request.context}" : nil
      # Result.for_request applies the furigana limit and the gloss cap here exactly as it does
      # for ClaudeTranslator, so a long fake source degrades the way production does — dev and CI
      # can see both the truncated gloss list and the omitted readings (design D2.4).
      Result.for_request(request:, text:, notes:, furigana: furigana_for(text, request),
        glosses: glosses_for(text, request), model: MODEL)
    end

    private

    # One reading on the Japanese tag, so the dev and test paths exercise ruby rendering. It
    # follows the kanji it reads, as a real reading does, and the string still strips back to
    # `text` exactly, which is what ClaudeTranslator requires of the real thing.
    sig { params(text: String, request: Request).returns(T.nilable(String)) }
    def furigana_for(text, request)
      return nil unless request.target_language == Language::JA

      text.sub(JA_TAG_WORD, "#{JA_TAG_WORD}《#{JA_TAG_READING}》")
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
        when GlossLevel::NONE then []
        # A couple of entries, standing in for "the ones worth remarking on": the language tag
        # and the last word of the fake translation.
        when GlossLevel::NOTABLE then [ tag(request), T.must(text.split.last) ].uniq
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
        Gloss.new(
          text: word, meaning: is_tag ? "fake target-language tag" : "fake definition of #{word}",
          reading: is_tag && request.target_language == Language::JA ? JA_TAG_READING : nil,
          starts_at:, length: word.length
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
