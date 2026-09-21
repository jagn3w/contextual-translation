# typed: strict
# frozen_string_literal: true

module Diary
  # The seam between the diary and whatever plays the tutor (docs/diary.md), like
  # Translation::Translator for translations. Implementations raise Translation::Error for
  # anticipated failures. The requests carry plain values, not records, so a tutor never touches
  # the database and a test can see exactly what it was asked.
  module Tutor
    extend T::Sig
    extend T::Helpers

    interface!

    class Comment < T::Struct
      const :author, Author
      const :body, String
    end

    # A thread as the tutor sees it: enough to know what it said and whether the learner has
    # dealt with it. `round` is the review that opened a SENTENCE or ENTRY thread (nil for HELP).
    class ContextThread < T::Struct
      const :kind, ThreadKind
      const :verdict, T.nilable(Verdict)
      const :sentence, T.nilable(String)
      const :title, T.nilable(String)
      const :round, T.nilable(Integer)
      const :resolved, T::Boolean
      const :comments, T::Array[Comment]
    end

    class ReviewRequest < T::Struct
      const :text, String
      const :language, Translation::Language
      const :notes_language, Translation::Language
      # The entry's review number this request will become, so the tutor can tell the latest
      # round's threads from older ones.
      const :round, Integer
      const :threads, T::Array[ContextThread]
    end

    class SentenceFeedback < T::Struct
      const :text, String
      const :verdict, Verdict
      const :tip, String
    end

    class EntryNote < T::Struct
      const :title, String
      const :body, String
    end

    class Review < T::Struct
      const :sentences, T::Array[SentenceFeedback]
      const :notes, T::Array[EntryNote]
    end

    # A follow-up in a thread. `thread.comments` ends with the learner's new comment.
    class ReplyRequest < T::Struct
      const :entry_text, String
      const :language, Translation::Language
      const :notes_language, Translation::Language
      const :thread, ContextThread
    end

    # The next general hint for a "Help me say…" question. `comments` are the thread so far (none
    # yet for the first hint).
    class HintRequest < T::Struct
      const :question, String
      const :language, Translation::Language
      const :notes_language, Translation::Language
      const :comments, T::Array[Comment]
      const :level, Integer
    end

    class TopicsRequest < T::Struct
      const :language, Translation::Language
      const :notes_language, Translation::Language
      # Previews of the learner's recent entries, so the ideas can steer away from them.
      const :recent_entries, T::Array[String]
    end

    class Topic < T::Struct
      const :prompt, String
      const :gloss, String
    end

    sig { abstract.params(request: ReviewRequest).returns(Review) }
    def review(request); end

    sig { abstract.params(request: ReplyRequest).returns(String) }
    def reply(request); end

    sig { abstract.params(request: HintRequest).returns(String) }
    def hint(request); end

    sig { abstract.params(request: TopicsRequest).returns(T::Array[Topic]) }
    def suggest_topics(request); end
  end
end
