# typed: strict
# frozen_string_literal: true

module Diary
  # What a thread is about (docs/diary.md): one sentence of a review, a note on the whole entry,
  # or a "Help me say…" question. Serialized as stored in diary_threads.kind.
  class ThreadKind < T::Enum
    enums do
      SENTENCE = new("sentence")
      ENTRY = new("entry")
      HELP = new("help")
    end
  end
end
