# typed: strict
# frozen_string_literal: true

module Types
  class ViewerType < Types::BaseObject
    graphql_name "Viewer"
    description "The signed-in session."

    field :access_code_label, String, null: false
    field :access_code_expires_at, GraphQL::Types::ISO8601DateTime
    field :session_expires_at, GraphQL::Types::ISO8601DateTime, null: false

    sig { returns(String) }
    def access_code_label
      current.access_code.label
    end

    sig { returns(T.nilable(ActiveSupport::TimeWithZone)) }
    def access_code_expires_at
      current.access_code.expires_at
    end

    sig { returns(ActiveSupport::TimeWithZone) }
    def session_expires_at
      current.authenticated_at + Authentication::SESSION_TTL
    end

    private

    sig { returns(Authentication::Current) }
    def current
      T.cast(object, Authentication::Current)
    end
  end
end
