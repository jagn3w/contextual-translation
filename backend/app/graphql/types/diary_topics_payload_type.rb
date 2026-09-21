# typed: strict
# frozen_string_literal: true

module Types
  class DiaryTopicsPayloadType < Types::BaseObject
    graphql_name "DiaryTopicsPayload"

    field :topics, [ Types::DiaryTopicType ], null: false, description: "Empty when errors is non-empty."
    field :errors, [ Types::TranslateErrorType ], null: false
  end
end
