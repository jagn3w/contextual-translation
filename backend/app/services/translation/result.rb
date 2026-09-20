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
    # for the UI to render as ruby text. nil unless the target is Japanese and it checks out.
    const :furigana, T.nilable(String)
    # The words of the translation worth defining, in the order they appear in it, each with the
    # span it occupies. Empty when there is nothing to gloss — never nil.
    const :glosses, T::Array[Gloss], default: [].freeze
    # True when `glosses` is short of what was on offer because the cap (Prompt::MAX_GLOSSES) cut
    # the list off, so the UI can say the definitions stop part way through rather than let the
    # reader read the silence as "nothing else was worth glossing".
    const :glosses_truncated, T::Boolean, default: false
    # True when the target is Japanese and the source was over Prompt::FURIGANA_LIMIT, so no
    # readings were asked for at all: `furigana` is nil because the request gave it up, not
    # because the translation had no kanji. False for every other target, where readings are not
    # expected in the first place and their absence is nothing to report.
    const :readings_omitted, T::Boolean, default: false
    const :model, String

    # How a Translator turns what it got back into the Result the reader sees: the furigana gate
    # and the gloss cap are applied here, on the one path every implementation takes, rather than
    # by each of them in turn (design D2.4). `furigana` and `glosses` are what the translator has
    # to offer; what survives the gates is what travels, and the two flags say which of them
    # dropped something — a degrade the reader can see explained beats one they have to infer.
    sig do
      params(request: Request, text: String, model: String, notes: T.nilable(String),
             furigana: T.nilable(String), glosses: T::Array[Gloss]).returns(Result)
    end
    def self.for_request(request:, text:, model:, notes: nil, furigana: nil, glosses: [])
      japanese = request.target_language == Language::JA
      readings = japanese && Prompt.furigana?(request)
      kept = glosses.first(Prompt::MAX_GLOSSES)
      new(
        text:, notes:, model:, glosses: kept,
        furigana: readings ? furigana : nil,
        glosses_truncated: kept.size < glosses.size,
        readings_omitted: japanese && !readings
      )
    end

    # `new` is private so that for_request is not merely the habit but the only way in: a
    # Translator that built its own Result would be back to remembering the cap and the flags by
    # hand, which is how the fake came to emit hundreds of glosses where production emits forty.
    private_class_method :new
  end
end
