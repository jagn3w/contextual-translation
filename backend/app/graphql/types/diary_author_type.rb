# typed: strict
# frozen_string_literal: true

module Types
  class DiaryAuthorType < Types::BaseEnum
    graphql_name "DiaryAuthor"
    description "Who wrote a diary comment."

    value "LEARNER", "The person writing the diary.", value: Diary::Author::LEARNER
    value "TUTOR", "Claude, as the tutor.", value: Diary::Author::TUTOR
  end
end
