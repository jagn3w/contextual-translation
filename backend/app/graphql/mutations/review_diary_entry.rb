# typed: strict
# frozen_string_literal: true

module Mutations
  # Saves the body and asks the tutor to review it (one tutor call).
  class ReviewDiaryEntry < Mutations::BaseDiaryMutation
    graphql_name "ReviewDiaryEntry"

    argument :input, Types::ReviewDiaryEntryInputType

    type Types::DiaryEntryPayloadType, null: false

    sig { params(input: T.untyped).returns(T::Hash[Symbol, T.untyped]) }
    def resolve(input:)
      entry = find_entry!(input.id)
      { entry: service.review(entry, input.body, session:), errors: [] }
    rescue Translation::Error => e
      { entry: nil, errors: [ e ] }
    rescue Diary::Service::NotFound => e
      not_found!(e.message)
    end
  end
end
