# typed: strict
# frozen_string_literal: true

module Types
  class GlossType < Types::BaseObject
    graphql_name "Gloss"
    description "A word of the translation with a short definition, for the UI to show on hover (design D2.3)."

    field :text, String, null: false, description: "The word exactly as it appears in the translation."
    field :reading, String, description: "For Japanese, the word's kana reading. Null when there is none."
    field :meaning, String, null: false,
      description: "A short definition, written in the source text's language — the language the notes use."
    field :starts_at, Integer, null: false,
      description: "Where the word starts in `Translation.text`, counted in Unicode code points."
    field :length, Integer, null: false, description: "The word's length in Unicode code points."
  end
end
