# typed: strict
# frozen_string_literal: true

module Diary
  # Deterministic stand-in for tests, CI and frontend development (TRANSLATOR=fake), like
  # Translation::FakeTranslator: no API key, no cost, and output that is obviously not a tutor.
  class FakeTutor
    extend T::Sig
    include Tutor

    # A sentence runs to its closing punctuation (Western or Japanese) or to the end of the text.
    SENTENCE = /[^.!?。！？]+(?:[.!?。！？]+|\z)/
    # Verdicts cycle in this order, so a three-sentence entry shows every colour.
    VERDICTS = T.let([ Verdict::WRONG, Verdict::IMPROVABLE, Verdict::CORRECT ].freeze, T::Array[Verdict])
    HINT_STAGES = T.let(
      [ "broad hint", "key vocabulary", "partial sentence", "full sentence" ].freeze, T::Array[String]
    )
    TOPICS = T.let(
      {
        Translation::Language::EN => [ "What did you eat today?", "Describe your morning.", "A place you want to visit." ],
        Translation::Language::ES => [ "¿Qué comiste hoy?", "Describe tu mañana.", "Un lugar que quieres visitar." ],
        Translation::Language::JA => [ "今日は何を食べましたか？", "朝のことを書いてください。", "行ってみたい場所。" ]
      }.freeze,
      T::Hash[Translation::Language, T::Array[String]]
    )

    sig { override.params(request: ReviewRequest).returns(Review) }
    def review(request)
      # No capture groups in SENTENCE, so every match is a String.
      sentences = T.cast(request.text.scan(SENTENCE), T::Array[String]).map(&:strip).reject(&:empty?)
      feedback = sentences.each_with_index.map do |sentence, index|
        verdict = VERDICTS.fetch(index % VERDICTS.size)
        SentenceFeedback.new(text: sentence, verdict:, tip: "Fake tip (#{verdict.serialize}) for sentence #{index + 1}.")
      end
      notes = [
        EntryNote.new(
          title: "Fake note",
          body: "Fake entry note for round #{request.round}: #{sentences.size} sentences, " \
                "#{request.threads.size} earlier threads in view."
        )
      ]
      Review.new(sentences: feedback, notes:)
    end

    sig { override.params(request: ReplyRequest).returns(String) }
    def reply(request)
      last = request.thread.comments.last&.body.to_s
      "Fake reply (#{request.notes_language.serialize}) to: #{last.truncate(60)}"
    end

    sig { override.params(request: HintRequest).returns(String) }
    def hint(request)
      stage = HINT_STAGES.fetch([ request.level, HINT_STAGES.size ].min - 1)
      "Fake hint #{request.level} (#{stage}) for: #{request.question.truncate(60)}"
    end

    sig { override.params(request: TopicsRequest).returns(T::Array[Topic]) }
    def suggest_topics(request)
      TOPICS.fetch(request.language).map do |prompt|
        Topic.new(prompt:, gloss: "Fake gloss (#{request.notes_language.serialize}) of: #{prompt}")
      end
    end
  end
end
