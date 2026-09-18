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
end
