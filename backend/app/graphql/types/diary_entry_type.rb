# typed: strict
# frozen_string_literal: true

module Types
  class DiaryEntryType < Types::BaseObject
    graphql_name "DiaryEntry"
    description "One diary entry, private to the access code that wrote it."

    field :id, ID, null: false
    field :language, Types::LanguageType, null: false, description: "The language the entry is written in."
    field :notes_language, Types::LanguageType, null: false,
      description: "The learner's own language: feedback, tips, hints and replies are written in it."
    field :body, String, null: false
    field :preview, String, null: false,
      description: "The first ~12 words of `body` (~40 characters for Japanese), with \"…\" when cut. " \
                   "Empty when the body is."
    field :reviewed_body, String,
      description: "The body as it was last reviewed; thread spans point into it. Null until the first review."
    field :reviewed_at, GraphQL::Types::ISO8601DateTime
    field :created_at, GraphQL::Types::ISO8601DateTime, null: false
    field :updated_at, GraphQL::Types::ISO8601DateTime, null: false
    field :threads, [ Types::DiaryThreadType ], null: false, description: "In creation order."

    sig { returns(Translation::Language) }
    def language
      entry.language_enum
    end

    sig { returns(Translation::Language) }
    def notes_language
      entry.notes_language_enum
    end

    # Batched across every entry in the response, like DiaryThread.comments.
    sig { returns(T.untyped) }
    def threads
      dataload_association(entry, :threads)
    end

    private

    sig { returns(DiaryEntry) }
    def entry
      T.cast(object, DiaryEntry)
    end
  end
end
