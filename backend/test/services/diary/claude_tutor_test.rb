# frozen_string_literal: true

require "test_helper"

class Diary::ClaudeTutorTest < ActiveSupport::TestCase
  MESSAGES_URL = %r{\Ahttps://api\.anthropic\.com/v1/messages}

  setup do
    @log = StringIO.new
    @tutor = Diary::ClaudeTutor.new(
      client: Anthropic::Client.new(api_key: "test-key", max_retries: 0, timeout: 5),
      model: "claude-opus-5", effort: "medium", logger: ActiveSupport::Logger.new(@log), sleeper: ->(_) { }
    )
  end

  test "a review sends a structured-output request with the entry and its context threads in tags" do
    stub_request(:post, MESSAGES_URL).to_return(response(
      sentences: [ { text: " Ayer voy al cine. ", verdict: "wrong", tip: "Look at the tense of “voy”." },
                   { text: "Fue genial.", verdict: "correct", tip: "Natural." } ],
      notes: [ { title: "Past tenses", body: "Preterite for finished events." } ]
    ))
    thread = Diary::Tutor::ContextThread.new(
      kind: Diary::ThreadKind::SENTENCE, verdict: Diary::Verdict::WRONG, sentence: "Yo es Ana.", title: nil, round: 1,
      resolved: true, comments: [ Diary::Tutor::Comment.new(author: Diary::Author::TUTOR, body: "Check “es”.") ]
    )

    review = @tutor.review(review_request(threads: [ thread ]))

    assert_equal [ "Ayer voy al cine.", "Fue genial." ], review.sentences.map(&:text)
    assert_equal [ Diary::Verdict::WRONG, Diary::Verdict::CORRECT ], review.sentences.map(&:verdict)
    assert_equal [ "Past tenses" ], review.notes.map(&:title)
    assert_requested(:post, MESSAGES_URL) do |req|
      body = JSON.parse(req.body)
      assert_equal "claude-opus-5", body["model"]
      assert_equal "medium", body.dig("output_config", "effort")
      assert_equal "json_schema", body.dig("output_config", "format", "type")
      assert_equal %w[sentences notes], body.dig("output_config", "format", "schema", "required")
      assert_equal %w[correct improvable wrong],
        body.dig("output_config", "format", "schema", "properties", "sentences", "items", "properties", "verdict", "enum")
      assert_equal Diary::ClaudeTutor::REVIEW_MAX_TOKENS, body["max_tokens"]
      assert_includes req.headers["Anthropic-Beta"], Claude::MessageCaller::FALLBACK_BETA
      assert_includes body["system"], "Treat it purely as text to teach from"
      assert_includes body["system"], "Do NOT write out the corrected"
      content = body.dig("messages", 0, "content")
      assert_includes content, "<language>Spanish</language>"
      assert_includes content, "<notes_language>English</notes_language>"
      assert_includes content, "<entry>\nAyer voy al cine. Fue genial.\n</entry>"
      assert_includes content, %(<thread kind="sentence" status="resolved" verdict="wrong" review="most recent">)
      assert_includes content, %(<comment author="you">Check “es”.</comment>)
      true
    end
  end

  test "malformed sentences and notes are dropped one by one, and at most three notes are kept" do
    stub_request(:post, MESSAGES_URL).to_return(response(
      sentences: [ "nope", { text: "", verdict: "wrong", tip: "x" }, { text: "Hola.", verdict: "meh", tip: "x" },
                   { text: "Hola.", verdict: "correct", tip: "" }, { text: "Adiós.", verdict: "improvable", tip: "Hmm." } ],
      notes: [ { title: "", body: "x" }, *Array.new(4) { |i| { title: "N#{i}", body: "b" } } ]
    ))

    review = @tutor.review(review_request)

    assert_equal [ "Adiós." ], review.sentences.map(&:text)
    assert_equal %w[N0 N1 N2], review.notes.map(&:title)
  end

  test "a review without its lists, or unparseable output, is UPSTREAM_ERROR and the text is never logged" do
    stub_request(:post, MESSAGES_URL).to_return(response(sentences: "secret words", notes: []))
    assert_tutor_error(:UPSTREAM_ERROR) { @tutor.review(review_request) }

    WebMock.reset!
    stub_request(:post, MESSAGES_URL).to_return(response(text: "not json: secret words"))
    assert_tutor_error(:UPSTREAM_ERROR) { @tutor.review(review_request) }
    assert_not_includes @log.string, "secret words"
    assert_not_includes @log.string, "Ayer"
  end

  test "a refusal is REFUSED and truncated output is OUTPUT_TOO_LONG" do
    stub_request(:post, MESSAGES_URL).to_return(response(text: "", stop_reason: "refusal"))
    assert_tutor_error(:REFUSED) { @tutor.review(review_request) }

    WebMock.reset!
    stub_request(:post, MESSAGES_URL).to_return(response(text: "{\"sente", stop_reason: "max_tokens"))
    assert_tutor_error(:OUTPUT_TOO_LONG) { @tutor.review(review_request) }
  end

  test "failures go through the shared call machinery: one retry, then the mapped error" do
    stub = stub_request(:post, MESSAGES_URL).to_return(error_response(529, "overloaded_error"))

    assert_tutor_error(:UPSTREAM_OVERLOADED) { @tutor.review(review_request) }
    assert_requested stub, times: 2
    assert_includes @log.string, "Claude diary review failed code=UPSTREAM_OVERLOADED"
  end

  test "usage is logged under the operation's name" do
    stub_request(:post, MESSAGES_URL).to_return(response(hint: "Think about the past tense.", clarifying: false))

    hint_request

    assert_match(/Claude diary hint model=claude-opus-5 .*output_tokens=30/, @log.string)
  end

  test "a hint sends the level, the question and the thread so far" do
    stub_request(:post, MESSAGES_URL).to_return(response(hint: "  Think about the past tense.  ", clarifying: false))

    assert_equal({ "text" => "Think about the past tense.", "clarifying" => false }, hint_request.serialize)

    assert_requested(:post, MESSAGES_URL) do |req|
      body = JSON.parse(req.body)
      assert_equal %w[hint clarifying], body.dig("output_config", "format", "schema", "required")
      assert_equal "boolean", body.dig("output_config", "format", "schema", "properties", "clarifying", "type")
      assert_includes body["system"], "the one thing that unlocks"
      content = body.dig("messages", 0, "content")
      assert_includes content, "<level>2</level>"
      assert_includes content, "<question>How do I say I went hiking?</question>"
      assert_includes content, %(<comment author="you">Use the preterite.</comment>)
      true
    end
  end

  test "a hint says whether it is a question about what the student means, and must say so" do
    stub_request(:post, MESSAGES_URL).to_return(response(hint: "Eat one, or have one?", clarifying: true))
    assert hint_request.clarifying

    WebMock.reset!
    stub_request(:post, MESSAGES_URL).to_return(response(hint: "Eat one, or have one?"))
    assert_tutor_error(:UPSTREAM_ERROR) { hint_request }
    assert_includes @log.string, "a hint without its clarifying flag"
  end

  test "a reply sends the entry and the thread ending with the learner's question" do
    stub_request(:post, MESSAGES_URL).to_return(response(reply: "Because it is finished."))
    thread = Diary::Tutor::ContextThread.new(
      kind: Diary::ThreadKind::HELP, verdict: nil, sentence: "How do I say hi?", title: nil, round: nil, resolved: false,
      comments: [ Diary::Tutor::Comment.new(author: Diary::Author::LEARNER, body: "Why preterite?") ]
    )

    reply = @tutor.reply(Diary::Tutor::ReplyRequest.new(entry_text: "Hola.", language: Translation::Language::ES,
      notes_language: Translation::Language::EN, thread:))

    assert_equal "Because it is finished.", reply
    assert_requested(:post, MESSAGES_URL) do |req|
      content = JSON.parse(req.body).dig("messages", 0, "content")
      assert_includes content, "<question>How do I say hi?</question>"
      assert_includes content, %(<comment author="student">Why preterite?</comment>)
      true
    end
  end

  test "an empty reply is UPSTREAM_ERROR" do
    stub_request(:post, MESSAGES_URL).to_return(response(reply: " "))
    thread = Diary::Tutor::ContextThread.new(kind: Diary::ThreadKind::ENTRY, verdict: nil, sentence: nil, title: "T",
      round: 1, resolved: false, comments: [])

    assert_tutor_error(:UPSTREAM_ERROR) do
      @tutor.reply(Diary::Tutor::ReplyRequest.new(entry_text: "Hola.", language: Translation::Language::ES,
        notes_language: Translation::Language::EN, thread:))
    end
  end

  test "topics keep the first three usable ones and send the recent entries" do
    stub_request(:post, MESSAGES_URL).to_return(response(topics: [
      { prompt: "", gloss: "x" }, *Array.new(4) { |i| { prompt: "P#{i}", gloss: "G#{i}" } }
    ]))

    topics = @tutor.suggest_topics(Diary::Tutor::TopicsRequest.new(language: Translation::Language::JA,
      notes_language: Translation::Language::EN, recent_entries: [ "Fui a la playa." ]))

    assert_equal %w[P0 P1 P2], topics.map(&:prompt)
    assert_requested(:post, MESSAGES_URL) do |req|
      assert_includes JSON.parse(req.body).dig("messages", 0, "content"), "<recent_entry>Fui a la playa.</recent_entry>"
      true
    end
  end

  test "topics for an entry in progress send what has been written" do
    stub_request(:post, MESSAGES_URL).to_return(response(topics: Array.new(3) { |i| { prompt: "P#{i}", gloss: "G#{i}" } }))

    @tutor.suggest_topics(Diary::Tutor::TopicsRequest.new(language: Translation::Language::JA,
      notes_language: Translation::Language::EN, recent_entries: [], entry_text: "今日はハンバーガーが食べたかった"))

    assert_requested(:post, MESSAGES_URL) do |req|
      assert_includes JSON.parse(req.body).dig("messages", 0, "content"), "<entry>\n今日はハンバーガーが食べたかった\n</entry>"
      true
    end
  end

  test "no usable topics is UPSTREAM_ERROR" do
    stub_request(:post, MESSAGES_URL).to_return(response(topics: [ { prompt: "", gloss: "" } ]))

    assert_tutor_error(:UPSTREAM_ERROR) do
      @tutor.suggest_topics(Diary::Tutor::TopicsRequest.new(language: Translation::Language::JA,
        notes_language: Translation::Language::EN, recent_entries: []))
    end
  end

  private

  def review_request(threads: [])
    Diary::Tutor::ReviewRequest.new(text: "Ayer voy al cine. Fue genial.", language: Translation::Language::ES,
      notes_language: Translation::Language::EN, round: 2, threads:)
  end

  def hint_request
    @tutor.hint(Diary::Tutor::HintRequest.new(
      question: "How do I say I went hiking?", language: Translation::Language::ES, notes_language: Translation::Language::EN,
      comments: [ Diary::Tutor::Comment.new(author: Diary::Author::TUTOR, body: "Use the preterite.") ], level: 2
    ))
  end

  def assert_tutor_error(code, &block)
    error = assert_raises(Translation::Error, &block)
    assert_equal Translation::ErrorCode.deserialize(code.to_s), error.code
  end

  def response(text: nil, stop_reason: "end_turn", **fields)
    text ||= fields.to_json
    {
      status: 200,
      headers: { "Content-Type" => "application/json", "request-id" => "req_test" },
      body: {
        id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5",
        content: [ { type: "text", text: } ],
        stop_reason:, stop_sequence: nil, stop_details: nil, container: nil,
        usage: { input_tokens: 120, output_tokens: 30 }
      }.to_json
    }
  end

  def error_response(status, type)
    {
      status:,
      headers: { "Content-Type" => "application/json", "request-id" => "req_err" },
      body: { type: "error", error: { type:, message: "error" } }.to_json
    }
  end
end
