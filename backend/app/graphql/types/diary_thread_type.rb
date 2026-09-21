# typed: strict
# frozen_string_literal: true

module Types
  class DiaryThreadType < Types::BaseObject
    graphql_name "DiaryThread"
    description "A tutor thread on a diary entry: a sentence's verdict, an entry-wide note, or a " \
                "\"Help me say…\" question."

    field :id, ID, null: false, method: :public_id,
      description: "A random UUID; internal ids are never exposed."
    field :kind, Types::DiaryThreadKindType, null: false
    field :verdict, Types::DiaryVerdictType, description: "SENTENCE only."
    field :sentence, String, description: "SENTENCE: the sentence as reviewed. HELP: the question."
    field :starts_at, Integer,
      description: "SENTENCE: where the sentence starts in `reviewedBody`, in Unicode code points. " \
                   "Null when it could not be located."
    field :length, Integer, description: "The sentence's length in Unicode code points, with `startsAt`."
    field :title, String, description: "ENTRY only."
    field :current, Boolean, null: false,
      description: "False for SENTENCE threads superseded by a later review."
    field :hint_level, Integer, null: false, description: "HELP: how many general hints have been given."
    field :resolved, Boolean, null: false
    field :created_at, GraphQL::Types::ISO8601DateTime, null: false
    field :comments, [ Types::DiaryCommentType ], null: false, description: "Oldest first."

    sig { returns(Diary::ThreadKind) }
    def kind
      thread.kind_enum
    end

    sig { returns(T.nilable(Diary::Verdict)) }
    def verdict
      thread.verdict_enum
    end

    sig { returns(T::Boolean) }
    def resolved
      thread.resolved?
    end

    # Batched across every thread in the response, so a list of entries costs one query here.
    sig { returns(T.untyped) }
    def comments
      dataload_association(thread, :comments)
    end

    private

    sig { returns(DiaryThread) }
    def thread
      T.cast(object, DiaryThread)
    end
  end
end
