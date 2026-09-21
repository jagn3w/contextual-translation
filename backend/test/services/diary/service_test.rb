# frozen_string_literal: true

require "test_helper"

class Diary::ServiceTest < ActiveSupport::TestCase
  setup do
    @cache = ActiveSupport::Cache::MemoryStore.new
    @service = Diary::Service.new(tutor: Diary::FakeTutor.new, rate_limiter: Translation::RateLimiter.new(cache: @cache))
    @access_code, = AccessCode.generate!(label: "x")
    @session = Authentication::Current.new(access_code: @access_code, session_key: "s", authenticated_at: Time.current)
    @entry = @service.create_entry(@access_code, language: Translation::Language::ES, notes_language: Translation::Language::EN)
  end

  test "the review context is every open thread plus every thread of the most recent round" do
    @entry.update!(review_count: 3)
    threads = {
      old_open: thread(round: 1),
      old_resolved: thread(round: 1, resolved: true),
      old_entry_open: thread(round: 2, kind: Diary::ThreadKind::ENTRY),
      old_entry_resolved: thread(round: 2, kind: Diary::ThreadKind::ENTRY, resolved: true),
      latest_open: thread(round: 3),
      latest_resolved: thread(round: 3, resolved: true),
      latest_entry_resolved: thread(round: 3, kind: Diary::ThreadKind::ENTRY, resolved: true),
      help_open: thread(round: nil, kind: Diary::ThreadKind::HELP),
      help_resolved: thread(round: nil, kind: Diary::ThreadKind::HELP, resolved: true)
    }

    context = Diary::Service.review_context(@entry.reload)

    assert_equal threads.values_at(:old_open, :old_entry_open, :latest_open, :latest_resolved, :latest_entry_resolved,
      :help_open).map(&:id), context.map(&:id)
  end

  test "before any review the context is just the open help threads" do
    open = thread(round: nil, kind: Diary::ThreadKind::HELP)
    thread(round: nil, kind: Diary::ThreadKind::HELP, resolved: true)

    assert_equal [ open.id ], Diary::Service.review_context(@entry).map(&:id)
  end

  test "the tutor is sent the context threads with their comments and resolved state" do
    recorded = []
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:review) do |request|
      recorded << request
      Diary::FakeTutor.new.review(request)
    end
    service = Diary::Service.new(tutor:, rate_limiter: Translation::RateLimiter.new(cache: @cache))
    @entry.update!(review_count: 1)
    resolved = thread(round: 1, resolved: true)
    resolved.comments.create!(author: "tutor", body: "Look at the verb.")
    resolved.comments.create!(author: "learner", body: "Fixed?")

    service.review(@entry, "Hola.", session: @session)

    request = recorded.sole
    assert_equal 2, request.round
    sent = request.threads.sole
    assert sent.resolved
    assert_equal Diary::Verdict::WRONG, sent.verdict
    assert_equal 1, sent.round
    assert_equal [ [ Diary::Author::TUTOR, "Look at the verb." ], [ Diary::Author::LEARNER, "Fixed?" ] ],
      sent.comments.map { |comment| [ comment.author, comment.body ] }
  end

  test "a review locates sentences in order and keeps an unlocatable one without a span" do
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:review) do |_request|
      feedback = ->(text) { Diary::Tutor::SentenceFeedback.new(text:, verdict: Diary::Verdict::CORRECT, tip: "ok") }
      Diary::Tutor::Review.new(sentences: [ feedback.("Sí."), feedback.("Not in it."), feedback.("Sí.") ], notes: [])
    end
    service = Diary::Service.new(tutor:, rate_limiter: Translation::RateLimiter.new(cache: @cache))

    service.review(@entry, "Sí. Sí.", session: @session)

    spans = @entry.threads.map { |thread| [ thread.sentence, thread.starts_at, thread.length ] }
    assert_equal [ [ "Sí.", 0, 3 ], [ "Not in it.", nil, nil ], [ "Sí.", 4, 3 ] ], spans
    assert_equal [ 1, 1, 1 ], @entry.threads.map(&:review_round)
  end

  test "a review marks earlier sentence threads not current, without resolving them" do
    @service.review(@entry, "Uno. Dos.", session: @session)
    first_round = @entry.threads.to_a

    @service.review(@entry, "Uno.", session: @session)

    first_round.each(&:reload)
    assert first_round.select { |thread| thread.kind == "sentence" }.none?(&:current)
    assert first_round.none?(&:resolved?)
    assert first_round.find { |thread| thread.kind == "entry" }.current, "entry notes are not superseded"
    assert_equal 2, @entry.reload.review_count
    assert_equal [ 2 ], @entry.threads.where(current: true, kind: "sentence").map(&:review_round)
  end

  test "reviews, replies, hints and topics count against the rate limit" do
    travel_to(Time.current.beginning_of_minute + 1.minute + 1.second)
    help = @service.start_help_thread(@entry, "How do I say hi?", session: @session)
    @service.request_hint(help, session: @session)
    @service.reply(help, "Which word?", session: @session)
    @service.review(@entry, "Hola.", session: @session)
    6.times { @service.suggest_topics(@access_code, language: Translation::Language::ES, notes_language: Translation::Language::EN, session: @session) }

    error = assert_raises(Translation::Error) { @service.review(@entry, "Hola.", session: @session) }

    assert_equal Translation::ErrorCode::RATE_LIMITED, error.code
    # The limits are shared by both features, so the message must not talk about translating.
    assert_equal "You're sending requests to Claude quickly.", error.message
  end

  test "input limits" do
    assert_code(:INPUT_TOO_LONG) { @service.update_entry(@entry, body: "a" * 10_001) }
    assert_nothing_raised { @service.update_entry(@entry, body: "a" * 10_000) }
    assert_code(:EMPTY_INPUT) { @service.review(@entry, " \n", session: @session) }
    assert_code(:INPUT_TOO_LONG) { @service.review(@entry, "a" * 10_001, session: @session) }
    assert_code(:INPUT_TOO_LONG) { @service.review(@entry, "a" * 2_001, session: @session) }
    assert_code(:EMPTY_INPUT) { @service.start_help_thread(@entry, "", session: @session) }
    assert_code(:INPUT_TOO_LONG) { @service.start_help_thread(@entry, "q" * 2_001, session: @session) }
    help = @service.start_help_thread(@entry, "q" * 2_000, session: @session)
    assert_code(:EMPTY_INPUT) { @service.reply(help, "  ", session: @session) }
    assert_code(:INPUT_TOO_LONG) { @service.reply(help, "q" * 2_001, session: @session) }
  end

  test "topics steer away from the learner's recent entries" do
    recorded = []
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:suggest_topics) do |request|
      recorded << request
      Diary::FakeTutor.new.suggest_topics(request)
    end
    @entry.update!(body: "Fui a la playa.")
    Diary::Service.new(tutor:, rate_limiter: Translation::RateLimiter.new(cache: @cache))
      .suggest_topics(@access_code, language: Translation::Language::ES, notes_language: Translation::Language::EN, session: @session)

    assert_equal [ "Fui a la playa." ], recorded.sole.recent_entries
    assert_equal "", recorded.sole.entry_text
  end

  test "with text on the page, topics follow on from it instead of steering away" do
    recorded = []
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:suggest_topics) do |request|
      recorded << request
      Diary::FakeTutor.new.suggest_topics(request)
    end
    @entry.update!(body: "Fui a la playa.")
    service = Diary::Service.new(tutor:, rate_limiter: Translation::RateLimiter.new(cache: @cache))
    service.suggest_topics(@access_code, language: Translation::Language::JA, notes_language: Translation::Language::EN,
      body: "  今日はハンバーガーが食べたかった\n", session: @session)

    assert_equal "今日はハンバーガーが食べたかった", recorded.sole.entry_text
    assert_empty recorded.sole.recent_entries, "the entry being written is not a topic to avoid"
    assert_code(:INPUT_TOO_LONG) do
      service.suggest_topics(@access_code, language: Translation::Language::JA,
        notes_language: Translation::Language::EN, body: "あ" * 10_001, session: @session)
    end
  end

  test "a body over the review limit can be saved but not reviewed, and the refusal saves nothing" do
    long = "a" * (Diary::Service::MAX_REVIEW_LENGTH + 1)
    @service.update_entry(@entry, body: "Hola.")

    error = assert_raises(Translation::Error) { @service.review(@entry, long, session: @session) }

    assert_equal Translation::ErrorCode::INPUT_TOO_LONG, error.code
    assert_equal "Feedback works on up to 2,000 characters at a time — shorten the entry, or carry on in a new one, " \
      "and try again.", error.message
    assert_equal [ "Hola.", 0 ], @entry.reload.then { |entry| [ entry.body, entry.review_count ] }
    assert_nothing_raised { @service.update_entry(@entry, body: long) }
    assert_nothing_raised { @service.review(@entry, "a" * Diary::Service::MAX_REVIEW_LENGTH, session: @session) }
  end

  test "the review context leaves out superseded sentence threads the learner never commented on" do
    @entry.update!(review_count: 3)
    silent = thread(round: 1, current: false)
    tutor_only = thread(round: 2, current: false)
    tutor_only.comments.create!(author: "tutor", body: "Look at the verb.")
    discussed = thread(round: 1, current: false)
    discussed.comments.create!(author: "learner", body: "Why?")
    note = thread(round: 1, kind: Diary::ThreadKind::ENTRY, current: false)
    latest = thread(round: 3)

    context = Diary::Service.review_context(@entry.reload)

    assert_equal [ discussed, note, latest ].map(&:id), context.map(&:id)
    assert_not_includes context.map(&:id), silent.id
  end

  test "a superseded sentence thread reaches the tutor marked as no longer current" do
    recorded = []
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:review) do |request|
      recorded << request
      Diary::FakeTutor.new.review(request)
    end
    @entry.update!(review_count: 2)
    discussed = thread(round: 1, current: false)
    discussed.comments.create!(author: "learner", body: "Why?")
    thread(round: 2)

    Diary::Service.new(tutor:, rate_limiter: Translation::RateLimiter.new(cache: @cache))
      .review(@entry.reload, "Hola.", session: @session)

    assert_equal [ false, true ], recorded.sole.threads.map(&:current)
  end

  test "the review context keeps the most recent threads up to the cap and logs how many it dropped" do
    @entry.update!(review_count: 1)
    threads = Array.new(Diary::Service::MAX_CONTEXT_THREADS + 2) { thread(round: 1) }
    log = StringIO.new

    context = Diary::Service.review_context(@entry.reload, logger: ActiveSupport::Logger.new(log))

    assert_equal threads.last(Diary::Service::MAX_CONTEXT_THREADS).map(&:id), context.map(&:id)
    assert_includes log.string, "Diary review context capped: dropped 2 of 62 threads"
  end

  test "a question about what the learner means is not a hint, so the next hint is still the first" do
    answers = [ Diary::Tutor::Hint.new(text: "Eat one, or have one?", clarifying: true),
                Diary::Tutor::Hint.new(text: "Which one again?", clarifying: true),
                Diary::Tutor::Hint.new(text: "Think of 食べる.", clarifying: false) ]
    levels = []
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:hint) do |request|
      levels << request.level
      answers.shift
    end
    service = Diary::Service.new(tutor:, rate_limiter: Translation::RateLimiter.new(cache: @cache))

    thread = service.start_help_thread(@entry, "How do I say I want a hamburger?", session: @session)
    assert_equal 0, thread.hint_level
    assert_equal 0, service.request_hint(thread, session: @session).hint_level
    assert_equal 1, service.request_hint(thread, session: @session).hint_level

    assert_equal [ 1, 1, 1 ], levels
    assert_equal [ "Eat one, or have one?", "Which one again?", "Think of 食べる." ], thread.comments.map(&:body)
  end

  test "the language pair is fixed once the entry has a help thread, even before any review" do
    @service.start_help_thread(@entry, "How do I say hi?", session: @session)

    assert_raises(Diary::Service::Invalid) { @service.update_entry(@entry, language: Translation::Language::JA) }
    assert_nothing_raised { @service.update_entry(@entry, language: Translation::Language::ES, body: "Hola.") }
  end

  test "an entry deleted while the tutor answers is NotFound, whatever the call" do
    doomed = nil
    delete = -> { DiaryEntry.find(doomed.id).destroy! }
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:review) { |request| delete.().then { Diary::FakeTutor.new.review(request) } }
    tutor.define_singleton_method(:reply) { |request| delete.().then { Diary::FakeTutor.new.reply(request) } }
    tutor.define_singleton_method(:hint) { |request| delete.().then { Diary::FakeTutor.new.hint(request) } }
    service = Diary::Service.new(tutor:, rate_limiter: Translation::RateLimiter.new(cache: @cache))
    calls = {
      review: [ "diary entry", ->(entry, _help) { service.review(entry, "Hola.", session: @session) } ],
      help: [ "diary entry", ->(entry, _help) { service.start_help_thread(entry, "How do I say bye?", session: @session) } ],
      reply: [ "diary thread", ->(_entry, help) { service.reply(help, "Why?", session: @session) } ],
      hint: [ "diary thread", ->(_entry, help) { service.request_hint(help, session: @session) } ]
    }

    calls.each do |name, (what, call)|
      doomed = @service.create_entry(@access_code, language: Translation::Language::ES, notes_language: Translation::Language::EN)
      help = @service.start_help_thread(doomed, "How do I say hi?", session: @session)

      error = assert_raises(Diary::Service::NotFound, name.to_s) { call.(doomed, help) }

      assert_equal what, error.message, name
      assert_not DiaryEntry.exists?(doomed.id), name
    end
    assert_equal 0, DiaryThread.count
  end

  test "a reply or hint returns the thread as it is now, including a resolve made during the call" do
    help = @service.start_help_thread(@entry, "How do I say hi?", session: @session)
    resolve = ->(resolved_at) { DiaryThread.find(help.id).update!(resolved_at:) }
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:reply) { |request| resolve.(Time.current).then { Diary::FakeTutor.new.reply(request) } }
    tutor.define_singleton_method(:hint) { |request| resolve.(Time.current).then { Diary::FakeTutor.new.hint(request) } }
    service = Diary::Service.new(tutor:, rate_limiter: Translation::RateLimiter.new(cache: @cache))

    replied = service.reply(help, "Why?", session: @session)
    assert replied.resolved?
    assert_equal %w[tutor learner tutor], replied.comments.map(&:author)

    resolve.(nil)
    help.reload
    hinted = service.request_hint(help, session: @session)
    assert hinted.resolved?
    assert_equal 2, hinted.hint_level
    assert_equal 4, hinted.comments.size
  end

  test "two overlapping reviews get consecutive rounds, not the same one" do
    session = @session
    entry_id = @entry.id
    told = []
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:review) do |request|
      told << request.round
      # A second tab's review of the same entry, saved while this one waits for the tutor.
      if told.size == 1
        Diary::Service.new(tutor: Diary::FakeTutor.new, rate_limiter: Translation::RateLimiter.new)
          .review(DiaryEntry.find(entry_id), "Uno.", session:)
      end
      Diary::FakeTutor.new.review(request)
    end

    service(tutor).review(@entry, "Dos. Tres.", session:)

    assert_equal [ 1 ], told, "the tutor was told round 1; the round saved counts up from the locked row"
    assert_equal 2, @entry.reload.review_count
    rounds = @entry.threads.where(kind: "sentence").group_by(&:review_round).transform_values { |threads| threads.map(&:sentence) }
    assert_equal({ 1 => [ "Uno." ], 2 => [ "Dos.", "Tres." ] }, rounds)
    assert_equal [ 1, 2 ], @entry.threads.where(kind: "entry").map(&:review_round)
    assert_equal [ 2 ], @entry.threads.where(kind: "sentence", current: true).pluck(:review_round).uniq
  end

  test "two overlapping hint requests count two hints, not the same level twice" do
    help = @service.start_help_thread(@entry, "How do I say hi?", session: @session)
    session = @session
    told = []
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:hint) do |request|
      told << request.level
      if told.size == 1
        Diary::Service.new(tutor: Diary::FakeTutor.new, rate_limiter: Translation::RateLimiter.new)
          .request_hint(DiaryThread.find(help.id), session:)
      end
      Diary::FakeTutor.new.hint(request)
    end

    hinted = service(tutor).request_hint(help, session:)

    assert_equal [ 2 ], told
    assert_equal 3, hinted.hint_level, "the level saved counts up from the locked row, not the level asked for"
    assert_equal 3, hinted.comments.size
  end

  test "an overlapping clarifying answer leaves the level another request raised" do
    help = @service.start_help_thread(@entry, "How do I say hi?", session: @session)
    session = @session
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:hint) do |_request|
      Diary::Service.new(tutor: Diary::FakeTutor.new, rate_limiter: Translation::RateLimiter.new)
        .request_hint(DiaryThread.find(help.id), session:)
      Diary::Tutor::Hint.new(text: "Which do you mean?", clarifying: true)
    end

    assert_equal 2, service(tutor).request_hint(help, session:).hint_level
  end

  test "a long thread is sent as its first comment, a marker and the latest comments" do
    help = @service.start_help_thread(@entry, "How do I say hi?", session: @session)
    12.times { |index| help.comments.create!(author: index.even? ? "learner" : "tutor", body: "c#{index}") }
    recorded = []
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:reply) { |request| recorded << request.thread; "ok" }
    tutor.define_singleton_method(:hint) { |request| recorded << request; Diary::FakeTutor.new.hint(request) }
    service = service(tutor)
    first = help.comments.first.body
    kept = Diary::Service::MAX_THREAD_COMMENTS

    # 14 comments with the new one: the first hint, c0..c11 and "new".
    service.reply(help.reload, "new", session: @session)
    sent = recorded.shift
    assert_equal [ first, *(12 - kept + 1..11).map { |index| "c#{index}" }, "new" ], sent.comments.map(&:body)
    assert_equal 14 - 1 - kept, sent.omitted, "every comment between the first and the kept ones is counted"
    assert_includes Diary::Prompt.thread_block(sent, nil), %(<comment author="you">#{first}</comment>\n<omitted count="#{sent.omitted}"/>)

    help.reload
    level = help.hint_level
    total = help.comments.size
    service.request_hint(help, session: @session)
    request = recorded.shift
    assert_equal level + 1, request.level, "the ladder follows hint_level, not the comments still in view"
    assert_equal first, request.comments.first.body
    assert_equal kept + 1, request.comments.size
    assert_equal total - 1 - kept, request.omitted
    assert_includes Diary::Prompt.hint_message(request), %(<omitted count="#{request.omitted}"/>)
  end

  test "a short thread is sent whole, without a marker" do
    help = @service.start_help_thread(@entry, "How do I say hi?", session: @session)
    (Diary::Service::MAX_THREAD_COMMENTS - 1).times { help.comments.create!(author: "learner", body: "more") }

    sent = Diary::Service.context_thread(help.reload, extra: Diary::Tutor::Comment.new(author: Diary::Author::LEARNER, body: "new"))

    assert_equal Diary::Service::MAX_THREAD_COMMENTS + 1, sent.comments.size
    assert_equal 0, sent.omitted
    assert_not_includes Diary::Prompt.thread_block(sent, nil), "<omitted"
  end

  test "the review context drops the oldest threads beyond the character cap and logs only counts" do
    @entry.update!(review_count: 1)
    size = Diary::Service::MAX_CONTEXT_CHARS / 3
    threads = Array.new(4) do
      thread(round: 1).tap { |record| record.comments.create!(author: "tutor", body: "x" * (size - 1)) }
    end
    log = StringIO.new

    context = Diary::Service.review_context(@entry.reload, logger: ActiveSupport::Logger.new(log))

    # Each thread is `size` characters (its one-character sentence and its comment), so three fit.
    assert_equal threads.last(3).map(&:id), context.map(&:id)
    assert_equal "Diary review context over #{Diary::Service::MAX_CONTEXT_CHARS} characters: dropped 1 of 4 threads\n",
      log.string
    assert_not_includes log.string, "xxx"
  end

  test "a review or help answer for a language pair the entry no longer has is refused and saves nothing" do
    entry_id = @entry.id
    switch = -> { DiaryEntry.find(entry_id).update!(language: "ja") }
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:review) { |request| switch.().then { Diary::FakeTutor.new.review(request) } }
    tutor.define_singleton_method(:hint) { |request| switch.().then { Diary::FakeTutor.new.hint(request) } }
    service = service(tutor)

    error = assert_raises(Diary::Service::Invalid) { service.review(@entry, "Hola.", session: @session) }
    assert_equal "The languages changed while Claude was answering — try again.", error.message
    @entry.reload.update!(language: "es")
    assert_raises(Diary::Service::Invalid) { service.start_help_thread(@entry, "How do I say hi?", session: @session) }

    @entry.reload
    assert_equal [ "ja", "", nil, 0 ], [ @entry.language, @entry.body, @entry.reviewed_at, @entry.review_count ]
    assert_empty @entry.threads
    assert_nothing_raised { @service.update_entry(@entry, language: Translation::Language::ES) }
  end

  test "a reply or hint for a language pair the entry no longer has is refused and saves nothing" do
    help = @service.start_help_thread(@entry, "How do I say hi?", session: @session)
    entry_id = @entry.id
    # update_entry refuses this once a thread exists; the check is a backstop for a row changed anyway.
    switch = -> { DiaryEntry.find(entry_id).update_column(:notes_language, "ja") }
    tutor = Diary::FakeTutor.new
    tutor.define_singleton_method(:reply) { |request| switch.().then { Diary::FakeTutor.new.reply(request) } }
    tutor.define_singleton_method(:hint) { |request| switch.().then { Diary::FakeTutor.new.hint(request) } }
    service = service(tutor)

    assert_raises(Diary::Service::Invalid) { service.reply(help, "Why?", session: @session) }
    @entry.update_column(:notes_language, "en")
    assert_raises(Diary::Service::Invalid) { service.request_hint(help.reload, session: @session) }

    help.reload
    assert_equal [ 1, 1 ], [ help.hint_level, help.comments.count ]
  end

  test "deleting an entry locks its row before removing its threads, like a review saving its answer" do
    help = @service.start_help_thread(@entry, "How do I say it rained?", session: @session)
    # What an overlapping delete request would hold: the same entry, loaded before this one landed.
    stale = DiaryEntry.find(@entry.id)
    locked_before_threads_went = nil
    @entry.define_singleton_method(:lock!) do |*args|
      locked_before_threads_went = DiaryThread.exists?(help.id)
      super(*args)
    end

    @service.delete_entry(@entry)

    assert locked_before_threads_went, "the entry is locked while its threads still exist"
    assert_not DiaryEntry.exists?(@entry.id)
    assert_not DiaryThread.exists?(help.id)
    error = assert_raises(Diary::Service::NotFound) { @service.delete_entry(stale) }
    assert_equal "diary entry", error.message
  end

  test "changing the languages checks for feedback under the entry's row lock" do
    locked = false
    @entry.define_singleton_method(:lock!) { |*args| locked = true; super(*args) }

    @service.update_entry(@entry, language: Translation::Language::JA)

    assert locked
    DiaryEntry.find(@entry.id).destroy!
    error = assert_raises(Diary::Service::NotFound) { @service.update_entry(@entry, body: "Hola.") }
    assert_equal "diary entry", error.message
  end

  private

  def service(tutor)
    Diary::Service.new(tutor:, rate_limiter: Translation::RateLimiter.new(cache: @cache))
  end

  def thread(round:, kind: Diary::ThreadKind::SENTENCE, resolved: false, current: true)
    @entry.threads.create!(
      kind: kind.serialize, review_round: round, resolved_at: resolved ? Time.current : nil, current:,
      verdict: kind == Diary::ThreadKind::SENTENCE ? "wrong" : nil, sentence: "s"
    )
  end

  def assert_code(code, &block)
    error = assert_raises(Translation::Error, &block)
    assert_equal Translation::ErrorCode.deserialize(code.to_s), error.code
  end
end
