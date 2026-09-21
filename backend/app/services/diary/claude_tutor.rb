# typed: strict
# frozen_string_literal: true

module Diary
  # The tutor, played by Claude with structured outputs so every reply parses (docs/diary.md).
  # The call itself — credentials, the one retry, the deadline, error mapping, usage logs — goes
  # through Claude::MessageCaller, exactly as ClaudeTranslator's does, on the shared client.
  # Never log the learner's text or Claude's feedback on it.
  class ClaudeTutor
    extend T::Sig
    include Tutor

    # The output budget for a review. The reply repeats the entry sentence by sentence and adds a
    # verdict and a tip to each, plus up to Prompt::MAX_ENTRY_NOTES notes. Counting a Japanese
    # character as ~1 token, the worst case is an entry at Service::MAX_REVIEW_LENGTH (2,000
    # characters) cut into short sentences of ~20 characters:
    #   2,000 (the sentences echoed) + 100 sentences x (~60 tip + ~15 verdict and JSON keys)
    #   + 3 x ~100 (notes) ≈ 9,800 tokens
    # 32,000, the translator's budget, is about three times that, which leaves room for JSON
    # escaping and kanji that cost more than a token each. It is a ceiling, not a target: the
    # reply still has to arrive inside the 30 s SDK timeout, and keeping it inside that is
    # Service::MAX_REVIEW_LENGTH's job, not this number's.
    REVIEW_MAX_TOKENS = 32_000
    # The output budget for a reply in a thread. Usually a paragraph, but the student may ask for
    # the correct version, and REPLY_SYSTEM then has Claude write out the thread's sentence (never
    # the whole entry, whose 10,000 characters a HELP thread's <entry> can hold). The worst case,
    # again counting a Japanese character as ~1 token, is a sentence thread whose sentence is a
    # whole reviewed body of Service::MAX_REVIEW_LENGTH (2,000) characters, or a HELP question of
    # Service::MAX_COMMENT_LENGTH (2,000), answering a new comment of MAX_COMMENT_LENGTH that itself
    # needs correcting:
    #   ~2,000 (the corrected sentence) + ~2,000 (their comment's text, corrected) + ~500
    #   (explanation) ≈ 4,500 tokens
    # 8,000 leaves almost twice that for JSON escaping and costly kanji. Like the others it is an
    # estimate, not a measurement: the "diary reply" usage lines show the real output_tokens.
    REPLY_MAX_TOKENS = 8_000
    # Hints and topics are a paragraph or two. The longest is a level-4 hint, which writes out the
    # full sentence for a question of up to Service::MAX_COMMENT_LENGTH (2,000) characters:
    #   ~2,000 (the sentence, if the question was that long) + ~300 (its explanation) ≈ 2,300 tokens
    # Three topics with glosses are ~200 tokens.
    SHORT_MAX_TOKENS = 4_000
    # A run of \uXXXX escapes written out as text. Claude sometimes JSON-escapes a character twice
    # ("\\u306b" in the JSON), so after parsing, the learner would read the escape, not the kana.
    LITERAL_ESCAPES = T.let(/(?:\\u\h{4})+/, Regexp)

    sig do
      params(
        client: Anthropic::Client,
        model: String,
        effort: String,
        logger: Claude::MessageCaller::Logger,
        sleeper: T.proc.params(seconds: Float).void,
        clock: T.proc.returns(Float)
      ).void
    end
    def initialize(client:, model: Translation::ClaudeTranslator::DEFAULT_MODEL,
                   effort: Translation::ClaudeTranslator::DEFAULT_EFFORT, logger: Rails.logger,
                   sleeper: ->(seconds) { sleep(seconds) },
                   clock: -> { Process.clock_gettime(Process::CLOCK_MONOTONIC).to_f })
      @caller = T.let(Claude::MessageCaller.new(client:, logger:, sleeper:, clock:), Claude::MessageCaller)
      @model = model
      @effort = effort
      @logger = logger
    end

    sig { override.params(request: ReviewRequest).returns(Review) }
    def review(request)
      fields = ask("diary review", Prompt::REVIEW_SYSTEM, Prompt.review_message(request), Prompt::REVIEW_SCHEMA,
        max_tokens: REVIEW_MAX_TOKENS)
      sentences = fields["sentences"]
      notes = fields["notes"]
      unreadable!("a review without its lists") unless sentences.is_a?(Array) && notes.is_a?(Array)

      Review.new(
        sentences: sentences.filter_map { |entry| sentence_from(entry) },
        notes: notes.filter_map { |entry| note_from(entry) }.first(Prompt::MAX_ENTRY_NOTES)
      )
    end

    sig { override.params(request: ReplyRequest).returns(String) }
    def reply(request)
      value = ask("diary reply", Prompt::REPLY_SYSTEM, Prompt.reply_message(request), Prompt::REPLY_SCHEMA,
        max_tokens: REPLY_MAX_TOKENS)["reply"]
      unreadable!("no reply") unless value.is_a?(String) && value.present?
      value.strip
    end

    sig { override.params(request: HintRequest).returns(Hint) }
    def hint(request)
      fields = ask("diary hint", Prompt::HINT_SYSTEM, Prompt.hint_message(request), Prompt::HINT_SCHEMA,
        max_tokens: SHORT_MAX_TOKENS)
      text = fields["hint"]
      clarifying = fields["clarifying"]
      unreadable!("no hint") unless text.is_a?(String) && text.present?
      unreadable!("a hint without its clarifying flag") unless [ true, false ].include?(clarifying)

      Hint.new(text: text.strip, clarifying:)
    end

    sig { override.params(request: TopicsRequest).returns(T::Array[Topic]) }
    def suggest_topics(request)
      fields = ask("diary topics", Prompt::TOPICS_SYSTEM, Prompt.topics_message(request), Prompt::TOPICS_SCHEMA,
        max_tokens: SHORT_MAX_TOKENS)
      topics = fields["topics"]
      unreadable!("topics without a list") unless topics.is_a?(Array)

      found = topics.filter_map { |entry| topic_from(entry) }.first(Prompt::TOPIC_COUNT)
      unreadable!("no usable topics") if found.empty?
      found
    end

    private

    # One structured-output call; returns the parsed JSON object.
    sig do
      params(label: String, system: String, message: String, schema: T::Hash[Symbol, T.untyped], max_tokens: Integer)
        .returns(T::Hash[String, T.untyped])
    end
    def ask(label, system, message, schema, max_tokens:)
      response = @caller.call(label) do |timeout|
        @caller.client.beta.messages.create(
          model: @model,
          max_tokens:,
          system_: system,
          messages: [ { role: "user", content: message } ],
          output_config: { effort: @effort.to_sym, format: { type: :json_schema, schema: } },
          fallbacks: :default,
          betas: [ Claude::MessageCaller::FALLBACK_BETA ],
          request_options: { timeout: }
        )
      end
      parse(response)
    end

    sig { params(message: Anthropic::Models::Beta::BetaMessage).returns(T::Hash[String, T.untyped]) }
    def parse(message)
      case message.stop_reason
      when :refusal
        raise Translation::Error.new(Translation::ErrorCode::REFUSED, "Claude declined to help with this.")
      when :max_tokens
        raise Translation::Error.new(Translation::ErrorCode::OUTPUT_TOO_LONG, "Claude's answer was too long to finish.")
      end

      text = message.content.filter_map { |block| block.text if block.is_a?(Anthropic::Models::Beta::BetaTextBlock) }.join
      parsed = begin
        JSON.parse(text)
      rescue JSON::ParserError
        nil
      end
      unreadable!("unparseable (#{text.bytesize} bytes, stop=#{message.stop_reason})") unless parsed.is_a?(Hash)
      T.cast(unescape(parsed), T::Hash[String, T.untyped])
    end

    # Decodes the literal \uXXXX escapes left in every string of the parsed reply. A run is decoded
    # whole, so a surrogate pair becomes its one character; a run that does not decode (a lone
    # surrogate) is left as it was.
    sig { params(value: T.untyped).returns(T.untyped) }
    def unescape(value)
      case value
      when Hash then value.transform_values { |inner| unescape(inner) }
      when Array then value.map { |inner| unescape(inner) }
      when String
        value.gsub(LITERAL_ESCAPES) do |run|
          decoded = JSON.parse(%("#{run}"))
          decoded.valid_encoding? ? decoded : run
        rescue JSON::ParserError
          run
        end
      else value
      end
    end

    sig { params(entry: T.untyped).returns(T.nilable(SentenceFeedback)) }
    def sentence_from(entry)
      return nil unless entry.is_a?(Hash)

      text = entry["text"]
      tip = entry["tip"]
      verdict = entry["verdict"].is_a?(String) ? Verdict.try_deserialize(entry["verdict"]) : nil
      return nil unless text.is_a?(String) && text.strip.present? && tip.is_a?(String) && tip.present? && verdict

      SentenceFeedback.new(text: text.strip, verdict:, tip: tip.strip)
    end

    sig { params(entry: T.untyped).returns(T.nilable(EntryNote)) }
    def note_from(entry)
      return nil unless entry.is_a?(Hash)

      title = entry["title"]
      body = entry["body"]
      return nil unless title.is_a?(String) && title.present? && body.is_a?(String) && body.present?

      EntryNote.new(title: title.strip, body: body.strip)
    end

    sig { params(entry: T.untyped).returns(T.nilable(Topic)) }
    def topic_from(entry)
      return nil unless entry.is_a?(Hash)

      prompt = entry["prompt"]
      gloss = entry["gloss"]
      return nil unless prompt.is_a?(String) && prompt.present? && gloss.is_a?(String) && gloss.present?

      Topic.new(prompt: prompt.strip, gloss: gloss.strip)
    end

    # Structured outputs should make this impossible. The reason names the shape, never the text.
    sig { params(reason: String).returns(T.noreturn) }
    def unreadable!(reason)
      @logger.error("Claude returned unusable diary output: #{reason}")
      raise Translation::Error.new(Translation::ErrorCode::UPSTREAM_ERROR, "Claude returned an unreadable response.")
    end
  end
end
