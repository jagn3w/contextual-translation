# typed: strict
# frozen_string_literal: true

module Translation
  # Translates with the Claude Messages API, using structured outputs so the response always
  # parses (design D2.1–D2.3).
  class ClaudeTranslator
    extend T::Sig
    include Translator

    DEFAULT_MODEL = "claude-opus-5"
    DEFAULT_EFFORT = "medium"
    MAX_TOKENS = 16_000
    # Server-side refusal fallbacks: if the model declines, Anthropic retries on a substitute
    # model chosen by refusal category.
    FALLBACK_BETA = "server-side-fallback-2026-07-01"
    # The whole translation, including the one retry, must finish inside CapRover's 60 s proxy
    # timeout (design D2.2); a retry is only attempted if at least MIN_RETRY_SECONDS remain.
    DEADLINE_SECONDS = 55.0
    MIN_RETRY_SECONDS = 10.0
    # Time kept back for the Claude call itself when waiting for credentials.
    MIN_CALL_SECONDS = 10.0
    # Furigana notation: a reading in double angle brackets follows the run of kanji it reads,
    # 漢字《かんじ》 (design D2.3).
    FURIGANA_READING = /《[^》]*》/

    sig do
      params(
        client: Anthropic::Client,
        model: String,
        effort: String,
        logger: T.any(::Logger, ActiveSupport::BroadcastLogger),
        sleeper: T.proc.params(seconds: Float).void,
        clock: T.proc.returns(Float)
      ).void
    end
    def initialize(client:, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, logger: Rails.logger,
                   sleeper: ->(seconds) { sleep(seconds) },
                   clock: -> { Process.clock_gettime(Process::CLOCK_MONOTONIC).to_f })
      @client = client
      @model = model
      @effort = effort
      @logger = logger
      @sleeper = sleeper
      @clock = clock
    end

    # Starts background credential refresh (WIF) so the first translation doesn't wait on it.
    # Called from Puma's after_booted hook in production.
    sig { void }
    def warm_up
      credentials.start if credentials.respond_to?(:start)
    end

    sig { override.params(request: Request).returns(Result) }
    def translate(request)
      started = @clock.call
      message = create_with_one_retry(request, started)
      log_usage(message, started)
      result_from(message, request)
    rescue StandardError => e
      raise if e.is_a?(Translation::Error)

      mapped = ClaudeErrorMapper.map(e)
      raise e if mapped.nil?

      log_failure(e, mapped)
      raise mapped
    end

    private

    # Always pass an explicit timeout: with empty request options the beta endpoint ignores the
    # client's 30 s and uses 600 s (anthropic 1.71, Beta::Messages#create).
    sig { params(request: Request, timeout: Float).returns(Anthropic::Models::Beta::BetaMessage) }
    def create_message(request, timeout:)
      @client.beta.messages.create(
        model: @model,
        max_tokens: MAX_TOKENS,
        system_: Prompt::SYSTEM,
        messages: [ { role: "user", content: Prompt.user_message(request) } ],
        output_config: {
          effort: @effort.to_sym,
          format: { type: :json_schema, schema: Prompt::OUTPUT_SCHEMA }
        },
        fallbacks: :default,
        betas: [ FALLBACK_BETA ],
        request_options: { timeout: }
      )
    end

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
    sig { params(request: Request, started: Float).returns(Anthropic::Models::Beta::BetaMessage) }
    def create_with_one_retry(request, started)
      refresher = token_refresher
      await_credentials(started)
      begin
        create_message(request, timeout: call_timeout(started))
      rescue Anthropic::Errors::AuthenticationError => e
        rejected = refresher&.generation_sent
        raise e if rejected.nil? || remaining_seconds(started) < MIN_RETRY_SECONDS

        @logger.warn("Claude 401 (request_id=#{e.request_id}); refreshing credentials and retrying once")
        await_credentials(started, after: rejected)
        create_message(request, timeout: call_timeout(started))
      rescue Anthropic::Errors::RateLimitError, Anthropic::Errors::InternalServerError => e
        raise e if e.is_a?(Anthropic::Errors::RateLimitError) &&
          ClaudeErrorMapper.error_code(e) == ClaudeErrorMapper::TIER_SPEND_CAP_CODE

        delay = retry_delay(e)
        raise e if remaining_seconds(started) - delay < MIN_RETRY_SECONDS

        @logger.warn("Claude #{e.status} (request_id=#{e.request_id}); retrying once")
        @sleeper.call(delay)
        await_credentials(started)
        create_message(request, timeout: call_timeout(started))
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

    sig { params(started: Float).returns(Float) }
    def call_timeout(started)
      [ remaining_seconds(started), Claude::ClientFactory::TIMEOUT_SECONDS ].min
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
      [ ClaudeErrorMapper.retry_after(error) || 1, 5 ].min.to_f
    end

    sig { params(message: Anthropic::Models::Beta::BetaMessage, request: Request).returns(Result) }
    def result_from(message, request)
      case message.stop_reason
      when :refusal
        raise Error.new(ErrorCode::REFUSED, "Claude declined to translate this text.")
      when :max_tokens
        raise Error.new(ErrorCode::OUTPUT_TOO_LONG, "The translation was too long to finish.")
      end

      text = message.content.filter_map { |block| block.text if block.is_a?(Anthropic::Models::Beta::BetaTextBlock) }.join
      parsed = begin
        JSON.parse(text)
      rescue JSON::ParserError
        nil
      end
      translation = parsed.is_a?(Hash) ? parsed["translation"] : nil
      unless translation.is_a?(String)
        # Structured outputs should make this impossible. Never log the text: it may contain
        # the user's words (design D4.2).
        @logger.error("Claude returned unparseable structured output (#{text.bytesize} bytes, stop=#{message.stop_reason})")
        raise Error.new(ErrorCode::UPSTREAM_ERROR, "Claude returned an unreadable response.")
      end

      fields = T.cast(parsed, T::Hash[String, T.untyped])
      notes = fields["notes"]
      Result.new(
        text: translation, notes: notes.is_a?(String) ? notes.presence : nil,
        furigana: furigana_from(fields["furigana"], translation, request), model: message.model.to_s
      )
    end

    # Furigana is only useful if it is the translation with readings added, so check it rather
    # than trust it: strip every 《…》 group and the translation must come back character for
    # character. Anything else (a non-Japanese target, an empty or reworded string, no readings
    # at all) becomes nil and the UI shows plain text.
    sig { params(value: T.untyped, translation: String, request: Request).returns(T.nilable(String)) }
    def furigana_from(value, translation, request)
      return nil unless request.target_language == Language::JA
      return nil unless value.is_a?(String) && value.match?(FURIGANA_READING)
      return value if value.gsub(FURIGANA_READING, "") == translation

      # Never log either string: both are the user's text (design D4.2).
      @logger.warn("Claude returned furigana that doesn't match the translation " \
                   "(#{value.bytesize} bytes vs #{translation.bytesize}); dropping it")
      nil
    end

    sig { params(message: Anthropic::Models::Beta::BetaMessage, started: Float).void }
    def log_usage(message, started)
      elapsed_ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round
      usage = message.usage
      @logger.info(
        "Claude translation model=#{message.model} stop=#{message.stop_reason} ms=#{elapsed_ms} " \
        "input_tokens=#{usage.input_tokens} output_tokens=#{usage.output_tokens}"
      )
    end

    sig { params(error: StandardError, mapped: Error).void }
    def log_failure(error, mapped)
      request_id = error.respond_to?(:request_id) ? error.public_send(:request_id) : nil
      level = [ ErrorCode::SERVICE_MISCONFIGURED, ErrorCode::BUDGET_EXCEEDED ].include?(mapped.code) ? :error : :warn
      @logger.public_send(level, "Claude translation failed code=#{mapped.code.serialize} " \
                                 "error=#{error.class} request_id=#{request_id.inspect}: #{error.message.truncate(300)}")
    end
  end
end
