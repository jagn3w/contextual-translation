# typed: strict
# frozen_string_literal: true

module Types
  class TranslationType < Types::BaseObject
    graphql_name "Translation"

    field :text, String, null: false
    field :notes, String, description: "Claude's note on the meaning, formality and regional variety it chose."
    field :furigana, String,
      description: "For Japanese, `text` repeated with a reading in double angle brackets after each run of " \
                   "kanji (漢字《かんじ》); removing every 《…》 group gives back `text`. Null when there is none."
    field :glosses, [ Types::GlossType ], null: false,
      description: "Words of `text` worth defining, in the order they appear in it, with " \
                   "non-overlapping spans. Empty when there is nothing to gloss."
    field :source_language, Types::LanguageType, null: false
    field :target_language, Types::LanguageType, null: false
  end
end
