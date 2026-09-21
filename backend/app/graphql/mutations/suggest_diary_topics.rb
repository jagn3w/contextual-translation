# typed: strict
# frozen_string_literal: true

module Mutations
  # Three ideas to write about, or to write next about what is already there (one tutor call).
  # Ephemeral: nothing is stored.
  class SuggestDiaryTopics < Mutations::BaseDiaryMutation
    graphql_name "SuggestDiaryTopics"

    argument :input, Types::SuggestDiaryTopicsInputType

    type Types::DiaryTopicsPayloadType, null: false

    sig { params(input: T.untyped).returns(T::Hash[Symbol, T.untyped]) }
    def resolve(input:)
      topics = service.suggest_topics(session.access_code, language: input.language,
        notes_language: input.notes_language, body: input.body.to_s, session:)
      { topics:, errors: [] }
    rescue Translation::Error => e
      { topics: [], errors: [ e ] }
    end
  end
end
