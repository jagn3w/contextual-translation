# typed: strict
# frozen_string_literal: true

module Types
  class DiaryThreadKindType < Types::BaseEnum
    graphql_name "DiaryThreadKind"
    description "What a diary thread is about."

    value "SENTENCE", "The tutor's verdict on one sentence of a review.", value: Diary::ThreadKind::SENTENCE
    value "ENTRY", "An entry-wide note from a review.", value: Diary::ThreadKind::ENTRY
    value "HELP", "A \"Help me say…\" question and its hints.", value: Diary::ThreadKind::HELP
  end
end
