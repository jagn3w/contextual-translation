# typed: strict
# frozen_string_literal: true

module Mutations
  # The next, more revealing hint on a HELP thread (one tutor call).
  class RequestDiaryHint < Mutations::BaseDiaryMutation
    graphql_name "RequestDiaryHint"

    argument :input, Types::RequestDiaryHintInputType

    type Types::DiaryThreadPayloadType, null: false

    sig { params(input: T.untyped).returns(T::Hash[Symbol, T.untyped]) }
    def resolve(input:)
      thread = find_thread!(input.thread_id)
      # Only HELP threads have hints; any other thread is not one this mutation can find.
      not_found!("help thread") unless thread.kind_enum == Diary::ThreadKind::HELP

      { thread: service.request_hint(thread, session:), errors: [] }
    rescue Translation::Error => e
      { thread: nil, errors: [ e ] }
    rescue Diary::Service::NotFound => e
      not_found!(e.message)
    rescue Diary::Service::Invalid => e
      invalid!(e.message)
    end
  end
end
