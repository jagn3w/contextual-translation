# typed: strict
# frozen_string_literal: true

module Types
  class MutationType < Types::BaseObject
    # Each translate costs one Claude call (seconds, real money); with the schema's
    # max_complexity this allows exactly one per request, so aliases can't batch them.
    field :translate, mutation: Mutations::Translate, complexity: 100

    # The diary (docs/diary.md). The ones that call the tutor cost 100 like translate, so one
    # request makes at most one Claude call of any kind.
    field :create_diary_entry, mutation: Mutations::CreateDiaryEntry
    field :update_diary_entry, mutation: Mutations::UpdateDiaryEntry
    field :delete_diary_entry, mutation: Mutations::DeleteDiaryEntry
    field :review_diary_entry, mutation: Mutations::ReviewDiaryEntry, complexity: 100
    field :start_diary_help_thread, mutation: Mutations::StartDiaryHelpThread, complexity: 100
    field :reply_to_diary_thread, mutation: Mutations::ReplyToDiaryThread, complexity: 100
    field :request_diary_hint, mutation: Mutations::RequestDiaryHint, complexity: 100
    field :resolve_diary_thread, mutation: Mutations::ResolveDiaryThread
    field :suggest_diary_topics, mutation: Mutations::SuggestDiaryTopics, complexity: 100
  end
end
