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

    # A review repeats the entry sentence by sentence (up to 10,000 characters, ~1 token each in
    # Japanese) and adds a tip per sentence, so it gets the translator's budget; the other
    # operations return a paragraph at most.
    REVIEW_MAX_TOKENS = 32_000
    SHORT_MAX_TOKENS = 4_000

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
      text_field("diary reply", Prompt::REPLY_SYSTEM, Prompt.reply_message(request), Prompt::REPLY_SCHEMA, "reply")
    end

    sig { override.params(request: HintRequest).returns(String) }
    def hint(request)
      text_field("diary hint", Prompt::HINT_SYSTEM, Prompt.hint_message(request), Prompt::HINT_SCHEMA, "hint")
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

    sig do
      params(label: String, system: String, message: String, schema: T::Hash[Symbol, T.untyped], field: String)
        .returns(String)
    end
    def text_field(label, system, message, schema, field)
      value = ask(label, system, message, schema, max_tokens: SHORT_MAX_TOKENS)[field]
      unreadable!("no #{field}") unless value.is_a?(String) && value.present?
      value.strip
    end

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
      parsed
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
