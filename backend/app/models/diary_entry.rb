# typed: strict
# frozen_string_literal: true

# One diary entry, private to the access code that wrote it (docs/diary.md). Languages are stored
# as Translation::Language serializations; the *_enum readers are the typed view of them.
class DiaryEntry < ApplicationRecord
  PREVIEW_WORDS = 12
  # For text without spaces between words (Japanese), and as a cap on one enormous "word".
  PREVIEW_CHARACTERS = 40
  PREVIEW_MAX_CHARACTERS = 100
  LANGUAGES = T.let(Translation::Language.values.map(&:serialize).freeze, T::Array[String])

  belongs_to :access_code
  has_many :threads, -> { order(:id) }, class_name: "DiaryThread", inverse_of: :diary_entry, dependent: :delete_all

  validates :language, inclusion: { in: LANGUAGES }
  validates :notes_language, inclusion: { in: LANGUAGES }

  sig { returns(Translation::Language) }
  def language_enum
    Translation::Language.deserialize(language)
  end

  sig { returns(Translation::Language) }
  def notes_language_enum
    Translation::Language.deserialize(notes_language)
  end

  # The first ~12 words for the scrollback, with "…" when there is more. Japanese has no spaces
  # to count words by, so it is cut by characters instead.
  sig { returns(String) }
  def preview
    words = body.split
    text = words.join(" ")
    cut =
      if language_enum.space_delimited?
        words.first(PREVIEW_WORDS).join(" ").truncate(PREVIEW_MAX_CHARACTERS, omission: "")
      else
        text[0, PREVIEW_CHARACTERS].to_s
      end
    cut.length < text.length ? "#{cut}…" : cut
  end
end
