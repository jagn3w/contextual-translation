# typed: strict
# frozen_string_literal: true

module Types
  class SuggestDiaryTopicsInputType < Types::BaseInputObject
    graphql_name "SuggestDiaryTopicsInput"

    argument :language, Types::LanguageType
    argument :notes_language, Types::LanguageType
  end
end
