# typed: strict
# frozen_string_literal: true

module Mutations
  # The learner's follow-up in a thread and the tutor's reply (one tutor call).
  class ReplyToDiaryThread < Mutations::BaseDiaryMutation
    graphql_name "ReplyToDiaryThread"

    argument :input, Types::ReplyToDiaryThreadInputType

    type Types::DiaryThreadPayloadType, null: false

    sig { params(input: T.untyped).returns(T::Hash[Symbol, T.untyped]) }
    def resolve(input:)
      thread = find_thread!(input.thread_id)
      { thread: service.reply(thread, input.body, session:), errors: [] }
    rescue Translation::Error => e
      { thread: nil, errors: [ e ] }
    rescue Diary::Service::NotFound => e
      not_found!(e.message)
    end
  end
end
