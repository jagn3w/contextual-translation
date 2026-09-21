# typed: strict
# frozen_string_literal: true

module Types
  class DeleteDiaryEntryPayloadType < Types::BaseObject
    graphql_name "DeleteDiaryEntryPayload"

    field :deleted_id, ID
  end
end
