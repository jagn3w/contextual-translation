# typed: strict
# frozen_string_literal: true

module Types
  class ReviewDiaryEntryInputType < Types::BaseInputObject
    graphql_name "ReviewDiaryEntryInput"

    argument :id, ID
    argument :body, String
  end
end
