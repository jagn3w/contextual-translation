# typed: strict
# frozen_string_literal: true

module Translation
  # Maps failures from the Anthropic SDK (and, for Workload Identity Federation, AWS STS) to our
  # error codes, in one place (design D2.4, D3.3). Returns nil for anything unanticipated — the
  # caller re-raises those as unexpected errors.
  module ClaudeErrorMapper
    extend T::Sig

    # Our own org/workspace spend limit: 400 invalid_request_error with this message prefix.
    USAGE_LIMIT_MESSAGE = /\AYou have reached your specified (workspace )?API usage limits/
    # The account tier's spend cap: 429 with this error_code and no retry-after.
    TIER_SPEND_CAP_CODE = "enforced_spend_limit_reached"

    sig { params(error: StandardError).returns(T.nilable(Error)) }
    def self.map(error)
      case error
      when Claude::TokenRefresher::TokenUnavailable
        # Named for why no token could be had: a WIF misconfiguration, or an unreachable STS or
        # token endpoint. With no fetch failure behind it, the fetch is just slow.
        cause = error.cause
        (map(cause) if cause.is_a?(StandardError)) || unreachable
      when Anthropic::Errors::APITimeoutError # before APIConnectionError: it's a subclass
        Error.new(ErrorCode::TIMEOUT, "The translation took too long.")
      when Anthropic::Errors::APIConnectionError
        Error.new(ErrorCode::UPSTREAM_UNREACHABLE, "Couldn't reach Claude.")
      when Anthropic::Errors::RateLimitError
        if error_code(error) == TIER_SPEND_CAP_CODE
          budget_exceeded
        else
          Error.new(ErrorCode::UPSTREAM_RATE_LIMITED, "Claude is busy.", retry_after_seconds: retry_after(error))
        end
      when Anthropic::Errors::InternalServerError
        if error.status == 529 || error.type.to_s == "overloaded_error"
          Error.new(ErrorCode::UPSTREAM_OVERLOADED, "Claude is temporarily overloaded.")
        else
          Error.new(ErrorCode::UPSTREAM_ERROR, "Claude had a problem.")
        end
      when Anthropic::Errors::BadRequestError
        budget_exceeded if USAGE_LIMIT_MESSAGE.match?(error_message(error))
      when Anthropic::Errors::AuthenticationError, Anthropic::Errors::PermissionDeniedError,
           Anthropic::Errors::NotFoundError, Anthropic::Credentials::WorkloadIdentityError,
           Aws::Errors::MissingCredentialsError, Aws::Errors::ServiceError
        Error.new(ErrorCode::SERVICE_MISCONFIGURED, "The translation service isn't configured correctly.")
      when Anthropic::Errors::APIStatusError
        budget_exceeded if error.status == 402 || error.type.to_s == "billing_error"
      when Seahorse::Client::NetworkingError, Timeout::Error, SocketError, SystemCallError, IOError,
           OpenSSL::SSL::SSLError, Net::ProtocolError, Net::HTTPBadResponse
        # Raised outside the SDK's transport: the WIF token refresher's STS call and token
        # exchange (Net::HTTP). They arrive as the cause of a TokenUnavailable.
        unreachable
      end
    end

    sig { returns(Error) }
    def self.unreachable
      Error.new(ErrorCode::UPSTREAM_UNREACHABLE, "Couldn't reach Claude.")
    end

    sig { returns(Error) }
    def self.budget_exceeded
      Error.new(ErrorCode::BUDGET_EXCEEDED, "This demo has reached its usage budget.")
    end

    sig { params(error: Anthropic::Errors::APIStatusError).returns(String) }
    def self.error_message(error)
      body = T.let(error.body, T.untyped)
      body.is_a?(Hash) ? body.dig(:error, :message).to_s : ""
    end

    sig { params(error: Anthropic::Errors::APIStatusError).returns(T.nilable(String)) }
    def self.error_code(error)
      body = T.let(error.body, T.untyped)
      body.is_a?(Hash) ? body.dig(:error, :details, :error_code)&.to_s : nil
    end

    sig { params(error: Anthropic::Errors::APIStatusError).returns(T.nilable(Integer)) }
    def self.retry_after(error)
      value = error.headers&.[]("retry-after")
      Integer(value, exception: false) if value
    end
  end
end
