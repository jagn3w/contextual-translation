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
      tag = request.target_language.serialize.upcase
      text = "[#{tag}] #{request.source_text}"
      notes = request.context.present? ? "Fake translation using context: #{request.context}" : nil
      # One annotation on the tag, so the dev and test paths exercise ruby rendering. It still
      # strips back to `text` exactly, which is what ClaudeTranslator requires of the real thing.
      furigana = request.target_language == Language::JA ? text.sub("]", "]《ジェイエー》") : nil
      Result.new(text:, notes:, furigana:, glosses: glosses_for(text, request), model: MODEL)
    end

    private

    # Two glosses for a Japanese target, so the dev path and the frontend's fixtures show hover
    # definitions: the language tag, and the last word of the fake translation. Both spans are
    # located in `text` — the second after the end of the first, the way ClaudeTranslator locates
    # Claude's — so they really are substrings of it and never overlap, rather than hand-counted
    # offsets that would drift the moment the fake translation changed.
    sig { params(text: String, request: Request).returns(T::Array[Gloss]) }
    def glosses_for(text, request)
      return [] unless request.target_language == Language::JA

      tag = "[#{Language::JA.serialize.upcase}]"
      glosses = [ Gloss.new(text: tag, reading: "ジェイエー", meaning: "fake target-language tag",
        starts_at: 0, length: tag.length) ]
      last_word = T.must(text.split.last)
      last_at = text.index(last_word, tag.length)
      return glosses if last_at.nil?

      glosses << Gloss.new(text: last_word, reading: nil, meaning: "fake gloss of the last word",
        starts_at: last_at, length: last_word.length)
    end
  end
end
