# typed: strict
# frozen_string_literal: true

module Translation
  # Deterministic stand-in used by tests, CI and frontend development (TRANSLATOR=fake), so none
  # of them need an API key or spend money (design D2.4).
  class FakeTranslator
    extend T::Sig
    include Translator

    MODEL = "fake"

    sig { override.params(request: Request).returns(Result) }
    def translate(request)
      text = "#{tag(request)} #{request.source_text}"
      notes = request.context.present? ? "Fake translation using context: #{request.context}" : nil
      # One annotation on the tag, so the dev and test paths exercise ruby rendering. It still
      # strips back to `text` exactly, which is what ClaudeTranslator requires of the real thing.
      furigana = request.target_language == Language::JA ? text.sub("]", "]《ジェイエー》") : nil
      Result.new(text:, notes:, furigana:, glosses: glosses_for(text, request), model: MODEL)
    end

    private

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
        # Every word, which is visibly more than NOTABLE for anything but a one-word source.
        when GlossLevel::EVERY then text.split
        else T.absurd(level)
        end
      glosses_at(words, text, request)
    end

    # Spans are located in `text` with a cursor — the way ClaudeTranslator locates Claude's, each
    # after the end of the previous — so they really are substrings of it and never overlap,
    # rather than hand-counted offsets that would drift the moment the fake translation changed.
    sig { params(words: T::Array[String], text: String, request: Request).returns(T::Array[Gloss]) }
    def glosses_at(words, text, request)
      cursor = 0
      words.filter_map do |word|
        starts_at = text.index(word, cursor)
        next if starts_at.nil?

        cursor = starts_at + word.length
        is_tag = word == tag(request)
        Gloss.new(
          text: word, meaning: is_tag ? "fake target-language tag" : "fake definition of #{word}",
          reading: is_tag && request.target_language == Language::JA ? "ジェイエー" : nil,
          starts_at:, length: word.length
        )
      end
    end

    sig { params(request: Request).returns(String) }
    def tag(request)
      "[#{request.target_language.serialize.upcase}]"
    end
  end
end
