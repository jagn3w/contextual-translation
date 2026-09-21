# typed: strict
# frozen_string_literal: true

module Types
  class ReplyToDiaryThreadInputType < Types::BaseInputObject
    graphql_name "ReplyToDiaryThreadInput"

    argument :thread_id, ID
    argument :body, String
  end
end
