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
      notes = request.context.present? ? "Fake translation using context: #{request.context}" : nil
      Result.new(text: "[#{tag}] #{request.source_text}", notes:, model: MODEL)
    end
  end
end
