# typed: strict
# frozen_string_literal: true

module Translation
  # The application-level entry point for a translation: everything around the Translator call
  # (validation and per-session limits arrive with the limits task, design D3.4).
  class Service
    extend T::Sig

    sig { params(translator: Translator).void }
    def initialize(translator: Translation.translator)
      @translator = translator
    end

    # Returns the result, or raises Translation::Error for anticipated failures.
    sig { params(request: Request, session: Authentication::Current).returns(Result) }
    def call(request, session:) # rubocop:disable Lint/UnusedMethodArgument -- used by the limits task
      @translator.translate(request)
    end
  end
end
