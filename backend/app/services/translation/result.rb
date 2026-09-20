# typed: strict
# frozen_string_literal: true

module Translation
  class Result < T::Struct
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
    const :model, String
  end
end
