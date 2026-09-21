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
  end

  test "input limits" do
    assert_code(:INPUT_TOO_LONG) { @service.update_entry(@entry, body: "a" * 10_001) }
    assert_nothing_raised { @service.update_entry(@entry, body: "a" * 10_000) }
    assert_code(:EMPTY_INPUT) { @service.review(@entry, " \n", session: @session) }
    assert_code(:INPUT_TOO_LONG) { @service.review(@entry, "a" * 10_001, session: @session) }
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
  end

  private

  def thread(round:, kind: Diary::ThreadKind::SENTENCE, resolved: false)
    @entry.threads.create!(
      kind: kind.serialize, review_round: round, resolved_at: resolved ? Time.current : nil,
      verdict: kind == Diary::ThreadKind::SENTENCE ? "wrong" : nil, sentence: "s"
    )
  end

  def assert_code(code, &block)
    error = assert_raises(Translation::Error, &block)
    assert_equal Translation::ErrorCode.deserialize(code.to_s), error.code
  end
end
