# typed: strict
# frozen_string_literal: true

module Types
  class TranslateInputType < Types::BaseInputObject
    extend T::Sig

    graphql_name "TranslateInput"

    argument :source_text, String
    argument :source_language, Types::LanguageType
    argument :target_language, Types::LanguageType
    argument :context, String, required: false,
      description: "The situation: where you are, who is speaking to whom, the desired formality or region."
    argument :gloss_level, Types::GlossLevelType, required: false, default_value: Translation::GlossLevel::NOTABLE,
      description: "How much of the translation to gloss with per-word definitions."

    # The default this schema publishes for `glossLevel`, read from the argument rather than
    # re-spelled. The mutation needs it to coerce an explicit `glossLevel: null` (see there), and
    # a second spelling of it would mean changing the published default while a null request
    # quietly kept the old one.
    sig { returns(Translation::GlossLevel) }
    def self.gloss_level_default
      T.cast(arguments.fetch("glossLevel").default_value, Translation::GlossLevel)
    end
  end
end
