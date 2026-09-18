# typed: strict
# frozen_string_literal: true

module Types
  class QueryType < Types::BaseObject
    # Placeholder root field so the schema is valid before real fields exist; replaced by
    # `viewer` in the GraphQL schema task (design D3.2).
    field :ping, String, null: false, description: "Liveness check for the GraphQL endpoint."

    sig { returns(String) }
    def ping
      "pong"
    end
  end
end
