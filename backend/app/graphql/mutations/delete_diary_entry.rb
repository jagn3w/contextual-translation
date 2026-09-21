# typed: strict
# frozen_string_literal: true

module Mutations
  # Deletes an entry with its threads and comments.
  class DeleteDiaryEntry < Mutations::BaseDiaryMutation
    graphql_name "DeleteDiaryEntry"

    argument :input, Types::DeleteDiaryEntryInputType

    type Types::DeleteDiaryEntryPayloadType, null: false

    sig { params(input: T.untyped).returns(T::Hash[Symbol, T.untyped]) }
    def resolve(input:)
      entry = find_entry!(input.id)
      entry.destroy!
      { deleted_id: entry.public_id }
    end
  end
end
