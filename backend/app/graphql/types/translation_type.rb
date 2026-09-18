# typed: strict
# frozen_string_literal: true

module Types
  class TranslationType < Types::BaseObject
    graphql_name "Translation"

    field :text, String, null: false
    field :notes, String, description: "Claude's note on the meaning, formality and regional variety it chose."
    field :source_language, Types::LanguageType, null: false
    field :target_language, Types::LanguageType, null: false
  end
end
