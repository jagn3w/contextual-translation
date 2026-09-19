# typed: strict
# frozen_string_literal: true

module Types
  class QueryType < Types::BaseObject
    field :viewer, Types::ViewerType, null: false, description: "The signed-in session."

    sig { returns(Authentication::Current) }
    def viewer
      context.fetch(:current_session)
    end
  end
end
