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
    # The output budget for one reply. The reply is the translation, plus up to
    # Prompt::MAX_GLOSSES gloss entries whatever the source's length, plus — when the source is
    # short enough for readings (Prompt::FURIGANA_LIMIT) — the furigana, which is the translation
    # over again with readings at ~1.6x its length, plus the notes. Counting a Japanese character
    # as ~1 token, the two worst cases are:
    #   with readings, at the 2,000-character furigana limit:
    #     2,000 (translation) + 3,200 (1.6 x furigana) + 40 x ~60 chars (glosses) + ~100 (notes)
    #     ≈ 7,700 tokens
    #   without, at the 10,000-character source limit (Service::MAX_SOURCE_LENGTH):
    #     10,000 (translation) + 2,400 (glosses) + ~100 (notes) ≈ 12,500 tokens
    # 32,000 is the larger of the two about two and a half times over, which leaves room for JSON
    # escaping and for the kanji that cost more than a token each. It is a ceiling, not a target:
    # the reply still has to arrive inside the 30 s SDK timeout and the 55 s deadline, and keeping
    # it inside those is Prompt::FURIGANA_LIMIT's job, not this number's (design D2.2).
    MAX_TOKENS = 32_000
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
    # A character that counts as part of a word when deciding whether a gloss's text sits inside a
    # longer one. Unicode-aware, so it covers accented Spanish as well as English.
    WORD_CHARACTER = /[[:word:]]/

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
      located = glosses_from(fields["glosses"], translation, request)
      # Result.for_request applies the cap and the furigana gate, so what it returns — not what
      # was located above — is what the reader gets, and what the log below has to count against.
      result = Result.for_request(
        request:, text: translation, notes: notes.is_a?(String) ? notes.presence : nil,
        furigana: furigana_from(fields["furigana"], translation),
        glosses: located, model: message.model.to_s
      )
      log_gloss_loss(fields["glosses"], located, result, request)
      result
    end

    # Furigana is only useful if it is the translation with readings added, so check it rather
    # than trust it: strip every 《…》 group and the translation must come back character for
    # character. Anything else (an empty or reworded string, no readings at all) becomes nil and
    # the UI shows plain text. Whether readings were wanted for this request at all — a Japanese
    # target, a source inside Prompt::FURIGANA_LIMIT — is Result.for_request's question, asked of
    # every translator rather than of this one.
    sig { params(value: T.untyped, translation: String).returns(T.nilable(String)) }
    def furigana_from(value, translation)
      return nil unless value.is_a?(String) && value.match?(FURIGANA_READING)
      return value if value.gsub(FURIGANA_READING, "") == translation

      # Never log either string: both are the user's text (design D4.2).
      @logger.warn("Claude returned furigana that doesn't match the translation " \
                   "(#{value.bytesize} bytes vs #{translation.bytesize}); dropping it")
      nil
    end

    # A gloss is only usable if the UI can find the word it describes, so locate every entry in
    # the translation rather than trusting the offsets to be there: each "text" must occur at or
    # after the end of the previous match, which keeps repeated words on successive occurrences
    # and the spans in order and non-overlapping. Entries that don't fit — not a string, not in
    # the translation any more, no meaning — are dropped one by one; a malformed list is simply
    # no glosses. The translation still comes back either way: hover definitions are a bonus.
    # Returns every entry that could be placed, in order, the ones past the cap included:
    # Result.for_request is what cuts the list to Prompt::MAX_GLOSSES and tells the reader it was
    # cut, so this only has to say which entries are usable at all.
    sig { params(value: T.untyped, translation: String, request: Request).returns(T::Array[Gloss]) }
    def glosses_from(value, translation, request)
      # The reader asked for none, so nothing Claude sent is wanted — don't even look at it.
      return [] if request.gloss_level == GlossLevel::NONE
      return [] unless value.is_a?(Array)

      cursor = 0
      value.filter_map do |entry|
        gloss = gloss_from(entry, translation, cursor, request)
        next if gloss.nil?

        cursor = gloss.starts_at + gloss.length
        gloss
      end
    end

    # What the reader lost, counted against what Claude offered: entries that couldn't be placed
    # plus the ones the cap threw away. Counting only the unplaceable ones undercounted the loss
    # every time Claude overran the cap. Never log the words themselves: they are the user's text
    # (design D4.2).
    sig { params(value: T.untyped, located: T::Array[Gloss], result: Result, request: Request).void }
    def log_gloss_loss(value, located, result, request)
      return if request.gloss_level == GlossLevel::NONE
      return unless value.is_a?(Array)
      return unless (lost = value.size - result.glosses.size).positive?

      over_cap = located.size - result.glosses.size
      @logger.debug("Dropped #{lost} of #{value.size} glosses Claude returned " \
                    "(#{over_cap} of them over the #{Prompt::MAX_GLOSSES} cap)")
    end

    # nil for anything unusable. Offsets count Unicode code points, which is what String#index
    # and String#length return, and what the UI counts too.
    sig do
      params(entry: T.untyped, translation: String, cursor: Integer, request: Request)
        .returns(T.nilable(Gloss))
    end
    def gloss_from(entry, translation, cursor, request)
      return nil unless entry.is_a?(Hash)

      text = entry["text"]
      meaning = entry["meaning"]
      return nil unless text.is_a?(String) && !text.empty? && meaning.is_a?(String) && meaning.present?

      starts_at = locate(text, translation, cursor, request)
      return nil if starts_at.nil?

      # Kana readings are the Japanese feature; for any other target whatever Claude put in
      # "reading" is not one, so it doesn't travel (see Gloss#reading).
      reading = request.target_language == Language::JA ? entry["reading"] : nil
      Gloss.new(text:, reading: reading.is_a?(String) ? reading.presence : nil, meaning:,
        starts_at:, length: text.length)
    end

    # Where to underline the gloss: the first occurrence at or after `cursor`. In a space-delimited
    # target that has to be a whole word — a gloss of "age" belongs to "the age of consent", not to
    # the "age" inside "message", and pinning it to the wrong one underlines the wrong characters
    # and pushes the cursor past the real word, dropping the glosses that follow. Japanese writes
    # no boundaries, so a gloss there is legitimately inside a longer run and plain substring
    # search is the only thing that can be meant (design D2.3). If no whole-word occurrence is
    # left, the raw index still beats losing the entry.
    sig { params(text: String, translation: String, cursor: Integer, request: Request).returns(T.nilable(Integer)) }
    def locate(text, translation, cursor, request)
      raw = translation.index(text, cursor)
      return raw unless request.target_language.space_delimited?

      whole_word_index(text, translation, cursor) || raw
    end

    # The first occurrence at or after `from` with no word character against either end.
    sig { params(text: String, translation: String, from: Integer).returns(T.nilable(Integer)) }
    def whole_word_index(text, translation, from)
      at = T.let(translation.index(text, from), T.nilable(Integer))
      while at
        before = at.zero? ? nil : translation[at - 1]
        return at unless word_character?(before) || word_character?(translation[at + text.length])

        at = translation.index(text, at + 1)
      end
      nil
    end

    sig { params(character: T.nilable(String)).returns(T::Boolean) }
    def word_character?(character)
      !character.nil? && character.match?(WORD_CHARACTER)
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
