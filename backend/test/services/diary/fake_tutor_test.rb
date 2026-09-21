# frozen_string_literal: true

require "test_helper"

class Diary::FakeTutorTest < ActiveSupport::TestCase
  setup { @tutor = Diary::FakeTutor.new }

  test "splits on Western and Japanese sentence punctuation and cycles the verdicts" do
    review = @tutor.review(request("今日は晴れ。公園に行った！楽しかった？ Then I went home... The end"))

    assert_equal [ "今日は晴れ。", "公園に行った！", "楽しかった？", "Then I went home...", "The end" ], review.sentences.map(&:text)
    assert_equal %w[wrong improvable correct wrong improvable], review.sentences.map { |sentence| sentence.verdict.serialize }
    assert review.sentences.all? { |sentence| sentence.tip.start_with?("Fake tip") }
    assert_equal [ "Fake note" ], review.notes.map(&:title)
  end

  test "is deterministic" do
    assert_equal @tutor.review(request("Uno. Dos.")).serialize, @tutor.review(request("Uno. Dos.")).serialize
  end

  test "hints get more revealing with the level" do
    hint = ->(level) do
      @tutor.hint(Diary::Tutor::HintRequest.new(question: "How do I say hi?", language: Translation::Language::ES,
        notes_language: Translation::Language::EN, comments: [], level:))
    end

    assert_equal "Fake hint 1 (broad hint) for: How do I say hi?", hint.(1)
    assert_equal "Fake hint 2 (key vocabulary) for: How do I say hi?", hint.(2)
    assert_includes hint.(7), "(full sentence)"
  end

  test "replies and topics look fake" do
    thread = Diary::Tutor::ContextThread.new(kind: Diary::ThreadKind::SENTENCE, verdict: nil, sentence: "Hola.",
      title: nil, round: 1, resolved: false, comments: [ Diary::Tutor::Comment.new(author: Diary::Author::LEARNER, body: "Why?") ])
    reply = @tutor.reply(Diary::Tutor::ReplyRequest.new(entry_text: "Hola.", language: Translation::Language::ES,
      notes_language: Translation::Language::EN, thread:))
    topics = @tutor.suggest_topics(Diary::Tutor::TopicsRequest.new(language: Translation::Language::JA,
      notes_language: Translation::Language::EN, recent_entries: []))

    assert_equal "Fake reply (en) to: Why?", reply
    assert_equal 3, topics.size
    assert topics.all? { |topic| topic.gloss.start_with?("Fake gloss") }
  end

  private

  def request(text)
    Diary::Tutor::ReviewRequest.new(text:, language: Translation::Language::JA, notes_language: Translation::Language::EN,
      round: 1, threads: [])
  end
end
