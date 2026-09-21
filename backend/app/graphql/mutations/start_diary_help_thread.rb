# typed: strict
# frozen_string_literal: true

module Mutations
  # Opens a "Help me say…" thread with the learner's question and the first hint (one tutor call).
  class StartDiaryHelpThread < Mutations::BaseDiaryMutation
    graphql_name "StartDiaryHelpThread"

    argument :input, Types::StartDiaryHelpThreadInputType

    type Types::DiaryThreadPayloadType, null: false

    sig { params(input: T.untyped).returns(T::Hash[Symbol, T.untyped]) }
    def resolve(input:)
      entry = find_entry!(input.entry_id)
      { thread: service.start_help_thread(entry, input.question, session:), errors: [] }
    rescue Translation::Error => e
      { thread: nil, errors: [ e ] }
    rescue Diary::Service::NotFound => e
      not_found!(e.message)
    rescue Diary::Service::Invalid => e
      invalid!(e.message)
    end
  end
end
