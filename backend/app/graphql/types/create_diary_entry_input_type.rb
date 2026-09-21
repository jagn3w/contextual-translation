# typed: strict
# frozen_string_literal: true

module Types
  class CreateDiaryEntryInputType < Types::BaseInputObject
    graphql_name "CreateDiaryEntryInput"

    argument :language, Types::LanguageType
    argument :notes_language, Types::LanguageType
  end
end
