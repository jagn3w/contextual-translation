# typed: strict
# frozen_string_literal: true

module Types
  class DeleteDiaryEntryInputType < Types::BaseInputObject
    graphql_name "DeleteDiaryEntryInput"

    argument :id, ID
  end
end
