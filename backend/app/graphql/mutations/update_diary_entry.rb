# typed: strict
# frozen_string_literal: true

module Mutations
  # Saves the body as a draft and/or changes the language pair; no tutor call. Omitted or null
  # fields are left as they are.
  class UpdateDiaryEntry < Mutations::BaseDiaryMutation
    graphql_name "UpdateDiaryEntry"

    argument :input, Types::UpdateDiaryEntryInputType

    type Types::DiaryEntryPayloadType, null: false

    sig { params(input: T.untyped).returns(T::Hash[Symbol, T.untyped]) }
    def resolve(input:)
      entry = find_entry!(input.id)
      updated = service.update_entry(entry, body: input.body, language: input.language,
        notes_language: input.notes_language)
      { entry: updated, errors: [] }
    rescue Translation::Error => e
      { entry: nil, errors: [ e ] }
    rescue Diary::Service::Invalid => e
      raise GraphQL::ExecutionError.new(e.message, extensions: { "code" => "INVALID" })
    end
  end
end
