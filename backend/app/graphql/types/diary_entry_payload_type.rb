# typed: strict
# frozen_string_literal: true

module Types
  class DiaryEntryPayloadType < Types::BaseObject
    graphql_name "DiaryEntryPayload"

    field :entry, Types::DiaryEntryType, description: "Null when errors is non-empty."
    field :errors, [ Types::TranslateErrorType ], null: false
  end
end
