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

    sig do
      params(
        client: Anthropic::Client,
        model: String,
        effort: String,
        logger: ActiveSupport::Logger,
        sleeper: T.proc.params(seconds: Float).void
      ).void
    end
    def initialize(client:, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, logger: Rails.logger,
                   sleeper: ->(seconds) { sleep(seconds) })
      @client = client
      @model = model
      @effort = effort
      @logger = logger
      @sleeper = sleeper
    end

    sig { override.params(request: Request).returns(Result) }
    def translate(request)
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC).to_f
      message = with_one_retry { create_message(request) }
      log_usage(message, started)
      result_from(message)
    rescue StandardError => e
      raise if e.is_a?(Translation::Error)

      mapped = ClaudeErrorMapper.map(e)
      raise e if mapped.nil?

      log_failure(e, mapped)
      raise mapped
    end

    private

    sig { params(request: Request).returns(Anthropic::Models::Beta::BetaMessage) }
    def create_message(request)
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
        betas: [ FALLBACK_BETA ]
      )
    end

    # One retry for rate limits and server errors, never for timeouts: a timed-out request is
    # already as slow as the user will tolerate (design D2.2). The SDK's own retries are off.
    sig { params(block: T.proc.returns(Anthropic::Models::Beta::BetaMessage)).returns(Anthropic::Models::Beta::BetaMessage) }
    def with_one_retry(&block)
      block.call
    rescue Anthropic::Errors::RateLimitError, Anthropic::Errors::InternalServerError => e
      raise e if e.is_a?(Anthropic::Errors::RateLimitError) &&
        ClaudeErrorMapper.error_code(e) == ClaudeErrorMapper::TIER_SPEND_CAP_CODE

      @logger.warn("Claude #{e.status} (request_id=#{e.request_id}); retrying once")
      @sleeper.call(retry_delay(e))
      block.call
    end

    sig { params(error: Anthropic::Errors::APIStatusError).returns(Float) }
    def retry_delay(error)
      [ ClaudeErrorMapper.retry_after(error) || 1, 5 ].min.to_f
    end

    sig { params(message: Anthropic::Models::Beta::BetaMessage).returns(Result) }
    def result_from(message)
      case message.stop_reason
      when :refusal
        raise Error.new(ErrorCode::REFUSED, "Claude declined to translate this text.")
      when :max_tokens
        raise Error.new(ErrorCode::OUTPUT_TOO_LONG, "The translation was too long to finish.")
      end

      text = message.content.filter_map { |block| block.text if block.is_a?(Anthropic::Models::Beta::BetaTextBlock) }.join
      parsed = JSON.parse(text)
      translation = parsed["translation"]
      raise TypeError, "structured output missing translation" unless translation.is_a?(String)

      notes = parsed["notes"]
      Result.new(text: translation, notes: notes.is_a?(String) ? notes.presence : nil, model: message.model.to_s)
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
