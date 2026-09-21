# typed: strict
# frozen_string_literal: true

# A tutor thread on an entry: a sentence's verdict, an entry-wide note, or a "Help me say…"
# question (docs/diary.md). The *_enum readers are the typed view of the stored strings.
class DiaryThread < ApplicationRecord
  belongs_to :diary_entry
  has_many :comments, -> { order(:id) }, class_name: "DiaryComment", inverse_of: :diary_thread, dependent: :delete_all

  validates :kind, inclusion: { in: Diary::ThreadKind.values.map(&:serialize) }
  validates :verdict, inclusion: { in: Diary::Verdict.values.map(&:serialize) }, allow_nil: true

  sig { returns(Diary::ThreadKind) }
  def kind_enum
    Diary::ThreadKind.deserialize(kind)
  end

  sig { returns(T.nilable(Diary::Verdict)) }
  def verdict_enum
    value = verdict
    value.nil? ? nil : Diary::Verdict.deserialize(value)
  end

  sig { returns(T::Boolean) }
  def resolved?
    !resolved_at.nil?
  end
end
