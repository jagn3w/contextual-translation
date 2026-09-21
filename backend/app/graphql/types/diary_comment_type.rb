# typed: strict
# frozen_string_literal: true

module Types
  class DiaryCommentType < Types::BaseObject
    graphql_name "DiaryComment"

    field :id, ID, null: false
    field :author, Types::DiaryAuthorType, null: false
    field :body, String, null: false
    field :created_at, GraphQL::Types::ISO8601DateTime, null: false

    sig { returns(Diary::Author) }
    def author
      comment.author_enum
    end

    private

    sig { returns(DiaryComment) }
    def comment
      T.cast(object, DiaryComment)
    end
  end
end
