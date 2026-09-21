# typed: strict
# frozen_string_literal: true

module Types
  class ResolveDiaryThreadInputType < Types::BaseInputObject
    graphql_name "ResolveDiaryThreadInput"

    argument :thread_id, ID
    argument :resolved, Boolean
  end
end
