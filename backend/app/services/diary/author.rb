# typed: strict
# frozen_string_literal: true

module Diary
  # Who wrote a comment. Serialized as stored in diary_comments.author.
  class Author < T::Enum
    enums do
      LEARNER = new("learner")
      TUTOR = new("tutor")
    end
  end
end
