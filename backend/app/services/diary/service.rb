# typed: strict
# frozen_string_literal: true

module Diary
  # The application-level diary operations (docs/diary.md): validate, count tutor calls against
  # the translation rate limits, call the Tutor, then persist. Records arrive already scoped to
  # the session's access code (the GraphQL layer finds them through it). Anticipated failures
  # raise Translation::Error, so they surface as the same TranslateError the Phrases page shows.
  class Service
    extend T::Sig

    MAX_BODY_LENGTH = 10_000
    MAX_COMMENT_LENGTH = 2_000
    # The longest body a review works on. A review's reply repeats the entry sentence by sentence
    # with a tip for each (see ClaudeTutor::REVIEW_MAX_TOKENS for the arithmetic), so its length
    # grows with the entry and has to arrive inside the 30 s SDK timeout; a longer body can still
    # be saved as a draft, just not reviewed in one go.
    #
    # 2,000 characters is an ESTIMATE that has NOT been measured against the real API, borrowed
    # from Translation::Prompt::FURIGANA_LIMIT, which bounds a reply of much the same size (the
    # text over again plus annotations). To measure it, review Japanese entries of several lengths
    # made of short sentences (the costliest shape: one tip per sentence) with TRANSLATOR=claude,
    # and read the duration and output_tokens that Claude::MessageCaller#log_usage writes for each
    # "diary review" call; the limit is where the slowest one starts to approach the timeout.
    MAX_REVIEW_LENGTH = 2_000
    # The most threads one review sends the tutor as context, most recent first. Unresolved threads
    # from every round are kept, so without a cap the request would grow with the entry's history.
    MAX_CONTEXT_THREADS = 60
    # How many recent entries the topic ideas steer away from.
    RECENT_ENTRIES = 5

    sig { params(tutor: Tutor, rate_limiter: Translation::RateLimiter).void }
    def initialize(tutor: Diary.tutor, rate_limiter: Translation::RateLimiter.new)
      @tutor = tutor
      @rate_limiter = rate_limiter
    end

    # An operation the entry's state does not allow (not a failure the learner can fix by
    # editing their text), which the GraphQL layer reports as a top-level INVALID error.
    class Invalid < StandardError; end

    # The entry or thread was deleted while the tutor was answering, so there is nothing left to
    # save the answer to. The message names what is gone ("diary entry"); the GraphQL layer reports
    # it as the same NOT_FOUND error a missing id gets.
    class NotFound < StandardError; end

    sig do
      params(access_code: AccessCode, language: Translation::Language, notes_language: Translation::Language)
        .returns(DiaryEntry)
    end
    def create_entry(access_code, language:, notes_language:)
      validate_languages!(language, notes_language)
      access_code.diary_entries.create!(language: language.serialize, notes_language: notes_language.serialize)
    end

    # Saving a draft, and/or changing the language pair: no tutor call, and an empty body is fine.
    # Nil leaves a field as it is. The pair is fixed once the entry has any thread — feedback or
    # a "Help me say…" question, which can come before any review — because they were written for it.
    sig do
      params(entry: DiaryEntry, body: T.nilable(String), language: T.nilable(Translation::Language),
        notes_language: T.nilable(Translation::Language)).returns(DiaryEntry)
    end
    def update_entry(entry, body: nil, language: nil, notes_language: nil)
      validate_body!(body) if body
      new_language = language || entry.language_enum
      new_notes_language = notes_language || entry.notes_language_enum
      changes_languages = new_language != entry.language_enum || new_notes_language != entry.notes_language_enum
      if changes_languages && (entry.reviewed_at || entry.threads.exists?)
        raise Invalid, "An entry's languages can't be changed once it has had feedback or help."
      end

      validate_languages!(new_language, new_notes_language)
      entry.update!({ body:, language: language&.serialize, notes_language: notes_language&.serialize }.compact)
      entry
    end

    # Saves the body and asks the tutor to review it. Nothing is written unless the tutor
    # succeeds, so a failed review leaves the entry and its threads as they were. A body over
    # MAX_REVIEW_LENGTH is refused without saving it either: the draft autosave has its own call.
    sig { params(entry: DiaryEntry, body: String, session: Authentication::Current).returns(DiaryEntry) }
    def review(entry, body, session:)
      validate_body!(body)
      raise Translation::Error.new(Translation::ErrorCode::EMPTY_INPUT, "Write something to get feedback on.") if body.strip.empty?
      if body.length > MAX_REVIEW_LENGTH
        raise Translation::Error.new(Translation::ErrorCode::INPUT_TOO_LONG,
          "Feedback works on up to #{MAX_REVIEW_LENGTH.to_fs(:delimited)} characters at a time — " \
          "shorten the entry, or carry on in a new one, and try again.")
      end

      @rate_limiter.check!(session)
      round = entry.review_count + 1
      review = @tutor.review(
        Tutor::ReviewRequest.new(
          text: body, language: entry.language_enum, notes_language: entry.notes_language_enum,
          round:, threads: self.class.review_context(entry).map { |thread| context_thread(thread) }
        )
      )
      persist_review(entry, body, round, review)
      entry
    end

    # The threads the tutor sees on a new review (docs/diary.md): every unresolved thread from any
    # round, plus every thread from the most recent round, resolved or not. Resolved threads from
    # older rounds are left out, and so are superseded sentence threads the learner never replied
    # to: a later round's feedback replaced them, and nobody resolves those, so they would
    # otherwise be sent on every review for good. At most MAX_CONTEXT_THREADS, the most recent,
    # in creation order.
    sig { params(entry: DiaryEntry, logger: Claude::MessageCaller::Logger).returns(T::Array[DiaryThread]) }
    def self.review_context(entry, logger: Rails.logger)
      latest = entry.review_count
      scope = entry.threads
      scope = latest.positive? ? scope.where(resolved_at: nil).or(scope.where(review_round: latest)) : scope.where(resolved_at: nil)
      replied = DiaryComment.where(author: Author::LEARNER.serialize).select(:diary_thread_id)
      superseded = entry.threads.where(kind: ThreadKind::SENTENCE.serialize, current: false).where.not(id: replied)
      scope = scope.where.not(id: superseded.select(:id))

      total = scope.count
      if total > MAX_CONTEXT_THREADS
        # Counts only: thread text is the learner's and is never logged.
        logger.warn("Diary review context capped: dropped #{total - MAX_CONTEXT_THREADS} of #{total} threads")
      end
      scope.reorder(id: :desc).limit(MAX_CONTEXT_THREADS).includes(:comments).to_a.reverse
    end

    # A "Help me say…" thread: the learner's question and the first, broad hint.
    sig { params(entry: DiaryEntry, question: String, session: Authentication::Current).returns(DiaryThread) }
    def start_help_thread(entry, question, session:)
      validate_comment!(question, empty_message: "Write what you want to say first.")
      @rate_limiter.check!(session)
      hint = @tutor.hint(
        Tutor::HintRequest.new(
          question:, language: entry.language_enum, notes_language: entry.notes_language_enum, comments: [], level: 1
        )
      )
      DiaryThread.transaction do
        lock_or_not_found!(entry, "diary entry")
        # A question about what they mean is not the first hint, so the next one still is.
        thread = entry.threads.create!(kind: ThreadKind::HELP.serialize, sentence: question,
          hint_level: hint.clarifying ? 0 : 1)
        thread.comments.create!(author: Author::TUTOR.serialize, body: hint.text)
        thread
      end
    end

    # The learner's follow-up and the tutor's answer, saved together once the tutor has replied.
    sig { params(thread: DiaryThread, body: String, session: Authentication::Current).returns(DiaryThread) }
    def reply(thread, body, session:)
      validate_comment!(body, empty_message: "Write your question first.")
      @rate_limiter.check!(session)
      entry = T.must(thread.diary_entry)
      context = context_thread(thread, extra: Tutor::Comment.new(author: Author::LEARNER, body:))
      answer = @tutor.reply(
        Tutor::ReplyRequest.new(
          # A HELP question is about what they are writing now; feedback is about what was reviewed.
          entry_text: thread.kind_enum == ThreadKind::HELP ? entry.body : entry.reviewed_body || entry.body,
          language: entry.language_enum,
          notes_language: entry.notes_language_enum, thread: context
        )
      )
      DiaryThread.transaction do
        lock_or_not_found!(thread, "diary thread")
        thread.comments.create!(author: Author::LEARNER.serialize, body:)
        thread.comments.create!(author: Author::TUTOR.serialize, body: answer)
      end
      # lock_or_not_found! reloaded the thread, so it carries anything that changed during the
      # call (a resolve) rather than the state it was read in.
      thread
    end

    # The next, more revealing hint on a HELP thread. Only HELP threads have hints; the caller
    # checks the kind before asking.
    sig { params(thread: DiaryThread, session: Authentication::Current).returns(DiaryThread) }
    def request_hint(thread, session:)
      @rate_limiter.check!(session)
      entry = T.must(thread.diary_entry)
      level = thread.hint_level + 1
      hint = @tutor.hint(
        Tutor::HintRequest.new(
          question: thread.sentence.to_s, language: entry.language_enum, notes_language: entry.notes_language_enum,
          comments: thread.comments.map { |comment| comment_for(comment) }, level:
        )
      )
      DiaryThread.transaction do
        lock_or_not_found!(thread, "diary thread")
        thread.comments.create!(author: Author::TUTOR.serialize, body: hint.text)
        # A question about what they mean leaves the level where it was: the hint it replaced
        # is still to come.
        thread.update!(hint_level: level) unless hint.clarifying
      end
      # Reloaded by lock_or_not_found!, as in #reply.
      thread
    end

    sig { params(thread: DiaryThread, resolved: T::Boolean).returns(DiaryThread) }
    def resolve(thread, resolved:)
      if resolved
        thread.update!(resolved_at: Time.current) unless thread.resolved?
      else
        thread.update!(resolved_at: nil)
      end
      thread
    end

    sig do
      params(access_code: AccessCode, language: Translation::Language, notes_language: Translation::Language,
        session: Authentication::Current, body: String).returns(T::Array[Tutor::Topic])
    end
    def suggest_topics(access_code, language:, notes_language:, session:, body: "")
      validate_body!(body)
      @rate_limiter.check!(session)
      # With text on the page the ideas follow on from it, so the recent entries — this one among
      # them — are not topics to avoid; without, they are what keeps the ideas fresh.
      recent =
        if body.strip.empty?
          access_code.diary_entries.order(created_at: :desc).limit(RECENT_ENTRIES).map(&:preview).reject(&:empty?)
        else
          []
        end
      @tutor.suggest_topics(Tutor::TopicsRequest.new(language:, notes_language:, recent_entries: recent,
        entry_text: body.strip))
    end

    private

    sig { params(entry: DiaryEntry, body: String, round: Integer, review: Tutor::Review).void }
    def persist_review(entry, body, round, review)
      now = Time.current
      DiaryEntry.transaction do
        lock_or_not_found!(entry, "diary entry")
        entry.update!(body:, reviewed_body: body, reviewed_at: now, review_count: round)
        # Superseded, not resolved: the learner never said they had dealt with them.
        entry.threads.where(kind: ThreadKind::SENTENCE.serialize, current: true).update_all(current: false, updated_at: now)
        # Spans are placed the way glosses are (Translation::GlossLocator): verbatim, in order,
        # never overlapping. A sentence it cannot place keeps its thread, without a span.
        locator = Translation::GlossLocator.new(translation: body, language: entry.language_enum)
        review.sentences.each do |sentence|
          starts_at = locator.locate(sentence.text)
          thread = entry.threads.create!(
            kind: ThreadKind::SENTENCE.serialize, verdict: sentence.verdict.serialize, sentence: sentence.text,
            starts_at:, length: starts_at && sentence.text.length, review_round: round
          )
          thread.comments.create!(author: Author::TUTOR.serialize, body: sentence.tip)
        end
        review.notes.each do |note|
          thread = entry.threads.create!(kind: ThreadKind::ENTRY.serialize, title: note.title, review_round: round)
          thread.comments.create!(author: Author::TUTOR.serialize, body: note.body)
        end
      end
      entry.threads.reset
    end

    # A tutor call takes seconds, and the learner can delete the entry meanwhile (taking its
    # threads with it). Called first inside the transaction that saves the answer: it reloads the
    # record under a row lock, so the delete either happened already (NotFound, not a foreign-key
    # error) or waits until the answer is saved and then removes it along with the rest.
    sig { params(record: T.any(DiaryEntry, DiaryThread), what: String).void }
    def lock_or_not_found!(record, what)
      record.lock!
    rescue ActiveRecord::RecordNotFound
      raise NotFound, what
    end

    sig { params(thread: DiaryThread, extra: T.nilable(Tutor::Comment)).returns(Tutor::ContextThread) }
    def context_thread(thread, extra: nil)
      comments = thread.comments.map { |comment| comment_for(comment) }
      comments << extra if extra
      Tutor::ContextThread.new(
        kind: thread.kind_enum, verdict: thread.verdict_enum, sentence: thread.sentence, title: thread.title,
        round: thread.review_round, resolved: thread.resolved?, comments:
      )
    end

    sig { params(comment: DiaryComment).returns(Tutor::Comment) }
    def comment_for(comment)
      Tutor::Comment.new(author: comment.author_enum, body: comment.body)
    end

    sig { params(body: String).void }
    def validate_body!(body)
      return if body.length <= MAX_BODY_LENGTH

      raise Translation::Error.new(Translation::ErrorCode::INPUT_TOO_LONG,
        "The entry is over #{MAX_BODY_LENGTH.to_fs(:delimited)} characters — shorten it and try again.")
    end

    # Writing and notes in one language would leave the tutor nothing to teach across.
    sig { params(language: Translation::Language, notes_language: Translation::Language).void }
    def validate_languages!(language, notes_language)
      return unless language == notes_language

      raise Translation::Error.new(Translation::ErrorCode::SAME_LANGUAGE,
        "The entry's language and the notes language are the same.")
    end

    sig { params(text: String, empty_message: String).void }
    def validate_comment!(text, empty_message:)
      raise Translation::Error.new(Translation::ErrorCode::EMPTY_INPUT, empty_message) if text.strip.empty?
      return if text.length <= MAX_COMMENT_LENGTH

      raise Translation::Error.new(Translation::ErrorCode::INPUT_TOO_LONG,
        "That's over #{MAX_COMMENT_LENGTH.to_fs(:delimited)} characters — shorten it and try again.")
    end
  end
end
