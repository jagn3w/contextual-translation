# typed: strict
# frozen_string_literal: true

module Types
  class UpdateDiaryEntryInputType < Types::BaseInputObject
    graphql_name "UpdateDiaryEntryInput"

    argument :id, ID
    argument :body, String, required: false
    argument :language, Types::LanguageType, required: false,
      description: "Only until the entry's first review or thread; afterwards the change raises INVALID."
    argument :notes_language, Types::LanguageType, required: false,
      description: "Only until the entry's first review or thread; afterwards the change raises INVALID."
  end
end
