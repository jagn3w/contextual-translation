# typed: strict
# frozen_string_literal: true

module Translation
  class Result < T::Struct
    extend T::Sig

    const :text, String
    # Claude's short remark on how it read the text: the meaning it chose, and the formality
    # and regional variety it used (design D2.3).
    const :notes, T.nilable(String)
    # The Japanese translation repeated with a reading after each run of kanji, as 漢字《かんじ》,
    # for the UI to render as ruby text. nil unless the target is Japanese and what the
    # translator offered passes the annotation rules (Furigana).
    const :furigana, T.nilable(String)
    # The words of the translation worth defining, in the order they appear in it, each with the
    # span it occupies. Empty when there is nothing to gloss — never nil.
    const :glosses, T::Array[Gloss], default: [].freeze
    # True when `glosses` is short of what was on offer because the cap (Prompt::MAX_GLOSSES) cut
    # the list off, so the UI can say the definitions stop part way through rather than let the
    # reader read the silence as "nothing else was worth glossing". A reader who asked for no
    # glosses at all is not being cut off, so the NONE level never sets this.
    const :glosses_truncated, T::Boolean, default: false
    # True when the target is Japanese and `furigana` came out nil, for whatever reason: the
    # source was over Prompt::FURIGANA_LIMIT so readings were never asked for, the translation had
    # no kanji to annotate, or what came back was not a usable annotation and was dropped
    # (Furigana). One flag for all three because they are one fact from where the reader sits —
    # this Japanese text is carrying no readings, and not because none were wanted. Which of the
    # three it was is the log's business (ClaudeTranslator#log_furigana_loss), not the reader's.
    # False for every other target, where readings are not expected in the first place and their
    # absence is nothing to report.
    const :readings_omitted, T::Boolean, default: false
    const :model, String

    # How a Translator turns what it got back into the Result the reader sees. Every rule that
    # decides what reaches the reader is applied here, on the one path every implementation takes
    # (design D2.4): the gloss level, the gloss cap, kana readings being the Japanese feature, the
    # furigana length gate, and the annotation rules themselves. `furigana` and `glosses` are what
    # the translator has to offer; what survives the gates is what travels, and the two flags say
    # which of them dropped something — a degrade the reader can see explained beats one they have
    # to infer.
    #
    # They live here rather than in each translator because a rule a translator has to remember is
    # a rule the next translator forgets, and the copies drift silently: the fake has in turn
    # ignored the gloss level, emitted hundreds of glosses where production emitted forty, put
    # kana readings on Spanish glosses and offered furigana its own text could not strip back to —
    # each one wrong on the dev, CI and frontend path only, which is the path least likely to
    # notice. GlossLocator made the same move for where a gloss sits.
    sig do
      params(request: Request, text: String, model: String, notes: T.nilable(String),
             furigana: T.nilable(String), glosses: T::Array[Gloss]).returns(Result)
    end
    def self.for_request(request:, text:, model:, notes: nil, furigana: nil, glosses: [])
      japanese = request.target_language == Language::JA
      # Readings are asked for only for a Japanese target with a source inside the limit, and are
      # kept only if what came back really annotates this translation (Furigana.checked) — a
      # translator that annotates anyway can neither spend the reply on it nor paint a reading
      # over the wrong characters.
      readings = japanese && Prompt.furigana?(request) ? Furigana.checked(furigana, text) : nil
      # The reader who asked for none gets none, whatever the translator offered. That is the
      # reader's own choice rather than the cap cutting a list short, so it is no truncation.
      offered = request.gloss_level == GlossLevel::NONE ? [] : glosses
      kept = offered.first(Prompt::MAX_GLOSSES)
      new(
        text:, notes:, model:, furigana: readings,
        glosses: japanese ? kept : kept.map { |gloss| without_reading(gloss) },
        glosses_truncated: kept.size < offered.size,
        readings_omitted: japanese && readings.nil?
      )
    end

    # The same gloss with its kana reading taken off. Readings are the Japanese feature, so
    # whatever a translator put there for another target is not one, whatever it was built from
    # (see Gloss#reading).
    sig { params(gloss: Gloss).returns(Gloss) }
    def self.without_reading(gloss)
      return gloss if gloss.reading.nil?

      Gloss.new(text: gloss.text, reading: nil, meaning: gloss.meaning, starts_at: gloss.starts_at,
        length: gloss.length)
    end
    private_class_method :without_reading

    # `new` is private so that for_request is not merely the habit but the only way in: a
    # Translator that built its own Result would be back to remembering the cap, the flags and the
    # annotation rules by hand, which is how the fake came to emit hundreds of glosses where
    # production emits forty.
    private_class_method :new
  end
end
