# typed: strict
# frozen_string_literal: true

module Types
  class TranslatePayloadType < Types::BaseObject
    graphql_name "TranslatePayload"

    field :translation, Types::TranslationType, description: "Null when errors is non-empty."
    field :errors, [ Types::TranslateErrorType ], null: false
  end
end
