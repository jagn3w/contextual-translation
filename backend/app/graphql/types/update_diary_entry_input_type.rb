# typed: strict
# frozen_string_literal: true

module Types
  class UpdateDiaryEntryInputType < Types::BaseInputObject
    graphql_name "UpdateDiaryEntryInput"

    argument :id, ID
    argument :body, String, required: false
    argument :language, Types::LanguageType, required: false,
      description: "Only while the entry has never been reviewed."
    argument :notes_language, Types::LanguageType, required: false,
      description: "Only while the entry has never been reviewed."
  end
end
