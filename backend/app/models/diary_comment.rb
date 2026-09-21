# typed: strict
# frozen_string_literal: true

# One comment in a diary thread, by the learner or the tutor.
class DiaryComment < ApplicationRecord
  belongs_to :diary_thread

  validates :author, inclusion: { in: Diary::Author.values.map(&:serialize) }

  sig { returns(Diary::Author) }
  def author_enum
    Diary::Author.deserialize(author)
  end
end
