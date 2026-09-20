# typed: strict
# frozen_string_literal: true

module Translation
  # One word of the translation with a short definition, so the UI can explain it where the
  # reader hovers it (design D2.3). Glosses overlap furigana's ruby spans, so they travel as a
  # list beside the translation rather than as markup inside it.
  class Gloss < T::Struct
    # The word exactly as it appears in the translation: `text[starts_at, length]` is this string.
    const :text, String
    # The word's kana reading for Japanese; nil for every other target, and whenever Claude
    # left it blank.
    const :reading, T.nilable(String)
    # A short definition written in the source text's language, the same language as the notes.
    const :meaning, String
    # Where the word sits in the translation, counted in Unicode code points — what Ruby's
    # String#index and String#length count, and what the frontend counts (codePointLength).
    const :starts_at, Integer
    const :length, Integer
  end
end
