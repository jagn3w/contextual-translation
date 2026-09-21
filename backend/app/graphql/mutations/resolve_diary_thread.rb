# typed: strict
# frozen_string_literal: true

module Mutations
  # Marks a thread resolved, or open again.
  class ResolveDiaryThread < Mutations::BaseDiaryMutation
    graphql_name "ResolveDiaryThread"

    argument :input, Types::ResolveDiaryThreadInputType

    type Types::DiaryThreadPayloadType, null: false

    sig { params(input: T.untyped).returns(T::Hash[Symbol, T.untyped]) }
    def resolve(input:)
      thread = find_thread!(input.thread_id)
      { thread: service.resolve(thread, resolved: input.resolved), errors: [] }
    end
  end
end
