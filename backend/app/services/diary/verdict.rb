# typed: strict
# frozen_string_literal: true

module Diary
  # The tutor's verdict on one sentence (docs/diary.md). Serialized as stored in
  # diary_threads.verdict; the GraphQL DiaryVerdict enum spells them in capitals.
  class Verdict < T::Enum
    enums do
      CORRECT = new("correct")
      IMPROVABLE = new("improvable")
      WRONG = new("wrong")
    end
  end
end
