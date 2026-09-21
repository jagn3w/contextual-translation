# typed: strict
# frozen_string_literal: true

module Claude
  # One Claude Messages call with the app's rules around it: wait for WIF credentials, retry once
  # on 401/429/5xx inside the overall deadline, map failures to Translation::Error, and log usage
  # and failures without the user's words (design D2.2, D2.4). ClaudeTranslator and
  # Diary::ClaudeTutor build the request; this owns everything around it, so the two cannot drift.
  class MessageCaller
    extend T::Sig

    # Server-side refusal fallbacks: if the model declines, Anthropic retries on a substitute
    # model chosen by refusal category.
    FALLBACK_BETA = "server-side-fallback-2026-07-01"
    # The whole call, including the one retry, must finish inside CapRover's 60 s proxy timeout
    # (design D2.2); a retry is only attempted if at least MIN_RETRY_SECONDS remain.
    DEADLINE_SECONDS = 55.0
    MIN_RETRY_SECONDS = 10.0
    # Time kept back for the Claude call itself when waiting for credentials.
    MIN_CALL_SECONDS = 10.0

    Logger = T.type_alias { T.any(::Logger, ActiveSupport::BroadcastLogger) }

    sig { returns(Anthropic::Client) }
    attr_reader :client

    sig do
      params(
        client: Anthropic::Client,
        logger: Logger,
        sleeper: T.proc.params(seconds: Float).void,
        clock: T.proc.returns(Float)
      ).void
    end
    def initialize(client:, logger: Rails.logger, sleeper: ->(seconds) { sleep(seconds) },
                   clock: -> { Process.clock_gettime(Process::CLOCK_MONOTONIC).to_f })
      @client = client
      @logger = logger
      @sleeper = sleeper
      @clock = clock
    end

    # Starts background credential refresh (WIF) so the first call doesn't wait on it. The
    # refresher belongs to the shared client, so warming it once warms it for every caller.
    sig { void }
    def warm_up
      credentials.start if credentials.respond_to?(:start)
    end

    # Yields the timeout the request must carry and returns the message. `label` names the
    # operation in the logs ("translation", "diary review"). The block's result is parsed by the
    # caller afterwards, outside this method, so a parse failure raises what the caller chooses.
    sig do
      params(label: String, block: T.proc.params(timeout: Float).returns(Anthropic::Models::Beta::BetaMessage))
        .returns(Anthropic::Models::Beta::BetaMessage)
    end
    def call(label, &block)
      started = @clock.call
      message = create_with_one_retry(started, &block)
      log_usage(label, message, started)
      message
    rescue StandardError => e
      raise if e.is_a?(Translation::Error)

      mapped = Translation::ClaudeErrorMapper.map(e)
      raise e if mapped.nil?

      log_failure(label, e, mapped)
      raise mapped
    end

    private

    # One retry for rate limits and server errors, never for timeouts: a timed-out request is
    # already as slow as the user will tolerate (design D2.2). The retry only happens if it can
    # finish inside the overall deadline, and gets just the time that's left. The SDK's own
    # retries are off.
    #
    # A 401 also gets that one retry with WIF credentials: the token was revoked or rotated, so
    # the refresher fetches a newer one than the token this request actually sent (unless it
    # already has), and the retry sends that. If the refresh fails, nothing is left pending for
    # the next request. If Claude rejects the replacement too, the refresher backs off and
    # requests fail fast, rather than each forcing another exchange.
    sig do
      params(started: Float, block: T.proc.params(timeout: Float).returns(Anthropic::Models::Beta::BetaMessage))
        .returns(Anthropic::Models::Beta::BetaMessage)
    end
    def create_with_one_retry(started, &block)
      refresher = token_refresher
      await_credentials(started)
      begin
        block.call(call_timeout(started))
      rescue Anthropic::Errors::AuthenticationError => e
        rejected = refresher&.generation_sent
        raise e if rejected.nil? || remaining_seconds(started) < MIN_RETRY_SECONDS

        @logger.warn("Claude 401 (request_id=#{e.request_id}); refreshing credentials and retrying once")
        await_credentials(started, after: rejected)
        block.call(call_timeout(started))
      rescue Anthropic::Errors::RateLimitError, Anthropic::Errors::InternalServerError => e
        raise e if e.is_a?(Anthropic::Errors::RateLimitError) &&
          Translation::ClaudeErrorMapper.error_code(e) == Translation::ClaudeErrorMapper::TIER_SPEND_CAP_CODE

        delay = retry_delay(e)
        raise e if remaining_seconds(started) - delay < MIN_RETRY_SECONDS

        @logger.warn("Claude #{e.status} (request_id=#{e.request_id}); retrying once")
        @sleeper.call(delay)
        await_credentials(started)
        block.call(call_timeout(started))
      end
    end

    # With WIF credentials, waits for a usable token (keeping MIN_CALL_SECONDS of the deadline
    # for the Claude call); with `after`, for a newer token than that generation. A no-op for
    # API-key clients.
    sig { params(started: Float, after: T.nilable(Integer)).void }
    def await_credentials(started, after: nil)
      token_refresher&.await_token(timeout: remaining_seconds(started) - MIN_CALL_SECONDS, after:)
    end

    sig { returns(T.nilable(Claude::TokenRefresher)) }
    def token_refresher
      refresher = credentials
      refresher.is_a?(Claude::TokenRefresher) ? refresher : nil
    end

    # Always pass an explicit timeout: with empty request options the beta endpoint ignores the
    # client's 30 s and uses 600 s (anthropic 1.71, Beta::Messages#create).
    sig { params(started: Float).returns(Float) }
    def call_timeout(started)
      [ remaining_seconds(started), ClientFactory::TIMEOUT_SECONDS ].min
    end

    sig { params(started: Float).returns(Float) }
    def remaining_seconds(started)
      DEADLINE_SECONDS - (@clock.call - started)
    end

    sig { returns(T.untyped) }
    def credentials
      T.unsafe(@client).credentials
    end

    sig { params(error: Anthropic::Errors::APIStatusError).returns(Float) }
    def retry_delay(error)
      [ Translation::ClaudeErrorMapper.retry_after(error) || 1, 5 ].min.to_f
    end

    sig { params(label: String, message: Anthropic::Models::Beta::BetaMessage, started: Float).void }
    def log_usage(label, message, started)
      elapsed_ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round
      usage = message.usage
      @logger.info(
        "Claude #{label} model=#{message.model} stop=#{message.stop_reason} ms=#{elapsed_ms} " \
        "input_tokens=#{usage.input_tokens} output_tokens=#{usage.output_tokens}"
      )
    end

    sig { params(label: String, error: StandardError, mapped: Translation::Error).void }
    def log_failure(label, error, mapped)
      request_id = error.respond_to?(:request_id) ? error.public_send(:request_id) : nil
      level = [ Translation::ErrorCode::SERVICE_MISCONFIGURED,
                Translation::ErrorCode::BUDGET_EXCEEDED ].include?(mapped.code) ? :error : :warn
      @logger.public_send(level, "Claude #{label} failed code=#{mapped.code.serialize} " \
                                 "error=#{error.class} request_id=#{request_id.inspect}: #{error.message.truncate(300)}")
    end
  end
end
