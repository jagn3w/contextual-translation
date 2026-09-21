# typed: strict
# frozen_string_literal: true

module Types
  class DiaryVerdictType < Types::BaseEnum
    graphql_name "DiaryVerdict"
    description "The tutor's verdict on one sentence of a diary entry."

    value "CORRECT", "Right, and reads naturally.", value: Diary::Verdict::CORRECT
    value "IMPROVABLE", "Understandable but unnatural or not quite the right word.", value: Diary::Verdict::IMPROVABLE
    value "WRONG", "Has a mistake of grammar, vocabulary, spelling or meaning.", value: Diary::Verdict::WRONG
  end
end
