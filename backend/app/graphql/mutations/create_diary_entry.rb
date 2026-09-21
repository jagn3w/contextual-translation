# typed: strict
# frozen_string_literal: true

module Mutations
  # A new, empty entry. Always a fresh one: many entries a day are fine (docs/diary.md).
  class CreateDiaryEntry < Mutations::BaseDiaryMutation
    graphql_name "CreateDiaryEntry"

    argument :input, Types::CreateDiaryEntryInputType

    type Types::DiaryEntryPayloadType, null: false

    sig { params(input: T.untyped).returns(T::Hash[Symbol, T.untyped]) }
    def resolve(input:)
      entry = service.create_entry(session.access_code, language: input.language, notes_language: input.notes_language)
      { entry:, errors: [] }
    rescue Translation::Error => e
      { entry: nil, errors: [ e ] }
    end
  end
end
