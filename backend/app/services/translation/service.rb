# typed: strict
# frozen_string_literal: true

module Translation
  # The application-level entry point for a translation: validate the input, count it against
  # the per-session and per-code limits, then call the Translator (design D3.4).
  class Service
    extend T::Sig

    MAX_SOURCE_LENGTH = 10_000
    MAX_CONTEXT_LENGTH = 2_000

    sig { params(translator: Translator, rate_limiter: RateLimiter).void }
    def initialize(translator: Translation.translator, rate_limiter: RateLimiter.new)
      @translator = translator
      @rate_limiter = rate_limiter
    end

    # Returns the result, or raises Translation::Error for anticipated failures.
    sig { params(request: Request, session: Authentication::Current).returns(Result) }
    def call(request, session:)
      validate!(request)
      @rate_limiter.check!(session)
      @translator.translate(request)
    end

    private

    sig { params(request: Request).void }
    def validate!(request)
      if request.source_text.strip.empty?
        raise Error.new(ErrorCode::EMPTY_INPUT, "Enter some text to translate.")
      end
      if request.source_text.length > MAX_SOURCE_LENGTH
        raise Error.new(ErrorCode::INPUT_TOO_LONG,
          "Text is over #{MAX_SOURCE_LENGTH.to_fs(:delimited)} characters — shorten it and try again.")
      end
      if request.context.to_s.length > MAX_CONTEXT_LENGTH
        raise Error.new(ErrorCode::INPUT_TOO_LONG,
          "Context is over #{MAX_CONTEXT_LENGTH.to_fs(:delimited)} characters — shorten it and try again.")
      end
      if request.source_language == request.target_language
        raise Error.new(ErrorCode::SAME_LANGUAGE, "Source and target languages are the same.")
      end
    end
  end
end
