# typed: strict
# frozen_string_literal: true

module Types
  class TranslateErrorType < Types::BaseObject
    graphql_name "TranslateError"
    description "An anticipated failure of a translation or a diary tutor call."

    field :code, Types::TranslateErrorCodeType, null: false
    field :message, String, null: false, description: "Safe, user-facing English text."
    field :retryable, Boolean, null: false, description: "Whether trying again may succeed."
    field :retry_after_seconds, Integer, description: "Seconds to wait before retrying, when known."

    sig { returns(T::Boolean) }
    def retryable
      object.code.retryable?
    end

    sig { returns(Translation::Error) }
    def object
      T.cast(super, Translation::Error)
    end
  end
end
