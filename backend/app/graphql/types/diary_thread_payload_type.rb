# typed: strict
# frozen_string_literal: true

module Types
  class DiaryThreadPayloadType < Types::BaseObject
    graphql_name "DiaryThreadPayload"

    field :thread, Types::DiaryThreadType, description: "Null when errors is non-empty."
    field :errors, [ Types::TranslateErrorType ], null: false
  end
end
