# typed: strict
# frozen_string_literal: true

module Translation
  # Every failure we can anticipate has its own code (design D3.3); anything else is raised as
  # an ordinary exception and surfaces as the INTERNAL catch-all. Serialized values match the
  # GraphQL TranslateErrorCode enum.
  class ErrorCode < T::Enum
    extend T::Sig

    enums do
      # Input problems: no Claude call made.
      EMPTY_INPUT = new("EMPTY_INPUT")
      INPUT_TOO_LONG = new("INPUT_TOO_LONG")
      SAME_LANGUAGE = new("SAME_LANGUAGE")
      # Our own per-session / per-code limits (D3.4).
      RATE_LIMITED = new("RATE_LIMITED")
      # Claude call outcomes.
      TIMEOUT = new("TIMEOUT")
      UPSTREAM_RATE_LIMITED = new("UPSTREAM_RATE_LIMITED")
      UPSTREAM_OVERLOADED = new("UPSTREAM_OVERLOADED")
      UPSTREAM_ERROR = new("UPSTREAM_ERROR")
      UPSTREAM_UNREACHABLE = new("UPSTREAM_UNREACHABLE")
      BUDGET_EXCEEDED = new("BUDGET_EXCEEDED")
      SERVICE_MISCONFIGURED = new("SERVICE_MISCONFIGURED")
      REFUSED = new("REFUSED")
      OUTPUT_TOO_LONG = new("OUTPUT_TOO_LONG")
    end

    sig { returns(T::Boolean) }
    def retryable?
      case self
      when RATE_LIMITED, TIMEOUT, UPSTREAM_RATE_LIMITED, UPSTREAM_OVERLOADED, UPSTREAM_ERROR,
           UPSTREAM_UNREACHABLE
        true
      else
        false
      end
    end
  end

  class Error < StandardError
    extend T::Sig

    sig { returns(ErrorCode) }
    attr_reader :code

    sig { returns(T.nilable(Integer)) }
    attr_reader :retry_after_seconds

    sig { params(code: ErrorCode, message: String, retry_after_seconds: T.nilable(Integer)).void }
    def initialize(code, message, retry_after_seconds: nil)
      super(message)
      @code = code
      @retry_after_seconds = retry_after_seconds
    end
  end
end
