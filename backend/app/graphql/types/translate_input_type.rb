# typed: strict
# frozen_string_literal: true

module Types
  class TranslateInputType < Types::BaseInputObject
    graphql_name "TranslateInput"

    argument :source_text, String
    argument :source_language, Types::LanguageType
    argument :target_language, Types::LanguageType
    argument :context, String, required: false,
      description: "The situation: where you are, who is speaking to whom, the desired formality or region."
    argument :gloss_level, Types::GlossLevelType, required: false, default_value: Translation::GlossLevel::NOTABLE,
      description: "How much of the translation to gloss with per-word definitions."
  end
end
