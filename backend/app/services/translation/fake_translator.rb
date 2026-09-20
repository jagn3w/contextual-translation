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
      Result.new(text:, notes:, furigana:, model: MODEL)
    end
  end
end
