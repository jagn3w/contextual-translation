# frozen_string_literal: true

require "test_helper"

class DiaryGraphqlTest < ActionDispatch::IntegrationTest
  ENTRY_FIELDS = <<~GRAPHQL
    id language notesLanguage body preview reviewedBody reviewedAt createdAt updatedAt
    threads { ...ThreadFields }
  GRAPHQL
  THREAD_FIELDS = <<~GRAPHQL
    fragment ThreadFields on DiaryThread {
      id kind verdict sentence startsAt length title current hintLevel resolved createdAt
      comments { id author body createdAt }
    }
  GRAPHQL
  ERRORS = "errors { code message retryable retryAfterSeconds }"

  LIST = "query { diaryEntries { #{ENTRY_FIELDS} } }\n#{THREAD_FIELDS}".freeze
  SHOW = "query($id: ID!) { diaryEntry(id: $id) { #{ENTRY_FIELDS} } }\n#{THREAD_FIELDS}".freeze
  CREATE = "mutation($input: CreateDiaryEntryInput!) { createDiaryEntry(input: $input) { entry { #{ENTRY_FIELDS} } #{ERRORS} } }\n#{THREAD_FIELDS}".freeze
  UPDATE = "mutation($input: UpdateDiaryEntryInput!) { updateDiaryEntry(input: $input) { entry { #{ENTRY_FIELDS} } #{ERRORS} } }\n#{THREAD_FIELDS}".freeze
  DELETE = "mutation($input: DeleteDiaryEntryInput!) { deleteDiaryEntry(input: $input) { deletedId } }"
  REVIEW = "mutation($input: ReviewDiaryEntryInput!) { reviewDiaryEntry(input: $input) { entry { #{ENTRY_FIELDS} } #{ERRORS} } }\n#{THREAD_FIELDS}".freeze
  HELP = "mutation($input: StartDiaryHelpThreadInput!) { startDiaryHelpThread(input: $input) { thread { ...ThreadFields } #{ERRORS} } }\n#{THREAD_FIELDS}".freeze
  REPLY = "mutation($input: ReplyToDiaryThreadInput!) { replyToDiaryThread(input: $input) { thread { ...ThreadFields } #{ERRORS} } }\n#{THREAD_FIELDS}".freeze
  HINT = "mutation($input: RequestDiaryHintInput!) { requestDiaryHint(input: $input) { thread { ...ThreadFields } #{ERRORS} } }\n#{THREAD_FIELDS}".freeze
  RESOLVE = "mutation($input: ResolveDiaryThreadInput!) { resolveDiaryThread(input: $input) { thread { ...ThreadFields } #{ERRORS} } }\n#{THREAD_FIELDS}".freeze
  TOPICS = "mutation($input: SuggestDiaryTopicsInput!) { suggestDiaryTopics(input: $input) { topics { prompt gloss } #{ERRORS} } }"

  # Records every review request, then answers like the fake tutor.
  class RecordingTutor < Diary::FakeTutor
    attr_reader :reviews

    def initialize
      super
      @reviews = []
    end

    def review(request)
      @reviews << request
      super
    end
  end

  class RaisingTutor < Diary::FakeTutor
    def initialize(error)
      super()
      @error = error
    end

    def review(_request) = raise(@error)
  end

  # Deletes the entry being reviewed while "answering", as a learner deleting it mid-call would.
  class DeletingTutor < Diary::FakeTutor
    def review(request)
      DiaryEntry.sole.destroy!
      super
    end
  end

  setup { @access_code, = sign_in }
  teardown { Diary.tutor = nil }

  test "creates, lists, shows, updates and deletes an entry" do
    created = create_entry(language: "JA", notesLanguage: "EN")
    assert_equal({ "language" => "JA", "notesLanguage" => "EN", "body" => "", "preview" => "", "reviewedBody" => nil,
                   "reviewedAt" => nil, "threads" => [] },
      created.slice("language", "notesLanguage", "body", "preview", "reviewedBody", "reviewedAt", "threads"))

    updated = mutate(UPDATE, "updateDiaryEntry", id: created["id"], body: "今日は公園に行きました。")
    assert_empty updated["errors"]
    assert_equal "今日は公園に行きました。", updated.dig("entry", "body")
    assert_nil updated.dig("entry", "reviewedBody"), "saving a draft is not a review"

    assert_equal [ created["id"] ], graphql(LIST).dig("data", "diaryEntries").pluck("id")
    assert_equal "今日は公園に行きました。", graphql(SHOW, variables: { id: created["id"] }).dig("data", "diaryEntry", "body")

    assert_equal created["id"], graphql(DELETE, variables: { input: { id: created["id"] } }).dig("data", "deleteDiaryEntry", "deletedId")
    assert_empty graphql(LIST).dig("data", "diaryEntries")
    assert_nil graphql(SHOW, variables: { id: created["id"] }).dig("data", "diaryEntry")
  end

  test "an unreviewed entry's languages can change on their own, leaving the body alone" do
    entry = create_entry(language: "ES", notesLanguage: "EN")
    mutate(UPDATE, "updateDiaryEntry", id: entry["id"], body: "Hola.")

    updated = mutate(UPDATE, "updateDiaryEntry", id: entry["id"], language: "JA")["entry"]
    assert_equal [ "JA", "EN", "Hola." ], updated.values_at("language", "notesLanguage", "body")

    updated = mutate(UPDATE, "updateDiaryEntry", id: entry["id"], notesLanguage: "ES", body: nil)["entry"]
    assert_equal [ "JA", "ES", "Hola." ], updated.values_at("language", "notesLanguage", "body"), "null leaves the body"
  end

  test "a reviewed entry's languages are fixed" do
    entry = create_entry(language: "ES", notesLanguage: "EN")
    mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "Hola.")

    body = graphql(UPDATE, variables: { input: { id: entry["id"], language: "JA" } })

    assert_equal "INVALID", body.dig("errors", 0, "extensions", "code")
    assert_equal "es", DiaryEntry.find_by!(public_id: entry["id"]).language
    same = mutate(UPDATE, "updateDiaryEntry", id: entry["id"], language: "ES", body: "Hola otra vez.")
    assert_empty same["errors"], "restating the same pair is not a change"
  end

  test "a help thread fixes the languages, even before any review" do
    entry = create_entry(language: "ES", notesLanguage: "EN")
    mutate(HELP, "startDiaryHelpThread", entryId: entry["id"], question: "How do I say hi?")

    body = graphql(UPDATE, variables: { input: { id: entry["id"], language: "JA" } })

    assert_equal "INVALID", body.dig("errors", 0, "extensions", "code")
    assert_equal "es", DiaryEntry.find_by!(public_id: entry["id"]).language
  end

  test "an entry's language and notes language must differ" do
    created = mutate(CREATE, "createDiaryEntry", language: "EN", notesLanguage: "EN")
    assert_nil created["entry"]
    assert_equal [ "SAME_LANGUAGE" ], created["errors"].pluck("code")
    assert_equal 0, DiaryEntry.count

    entry = create_entry(language: "ES", notesLanguage: "EN")
    updated = mutate(UPDATE, "updateDiaryEntry", id: entry["id"], language: "EN", body: "changed")
    assert_nil updated["entry"]
    assert_equal [ "SAME_LANGUAGE" ], updated["errors"].pluck("code")
    assert_equal [ "es", "" ], DiaryEntry.find_by!(public_id: entry["id"]).then { |record| [ record.language, record.body ] }
  end

  test "two entries on the same day both exist, newest first" do
    travel_to Time.zone.local(2026, 9, 21, 9, 0)
    first = create_entry
    travel 3.hours
    second = create_entry

    assert_equal [ second["id"], first["id"] ], graphql(LIST).dig("data", "diaryEntries").pluck("id")
  end

  test "another access code cannot see, change or talk about this code's diary" do
    entry = create_entry
    reviewed = mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "Hola. Me llamo Ana.")
    thread_id = reviewed.dig("entry", "threads", 0, "id")
    help_id = mutate(HELP, "startDiaryHelpThread", entryId: entry["id"], question: "How do I say hi?").dig("thread", "id")

    delete_json "/api/session"
    sign_in(label: "Someone else")

    assert_empty graphql(LIST).dig("data", "diaryEntries")
    assert_nil graphql(SHOW, variables: { id: entry["id"] }).dig("data", "diaryEntry")
    [
      [ UPDATE, { id: entry["id"], body: "mine now" } ],
      [ DELETE, { id: entry["id"] } ],
      [ REVIEW, { id: entry["id"], body: "mine now" } ],
      [ HELP, { entryId: entry["id"], question: "q" } ],
      [ REPLY, { threadId: thread_id, body: "q" } ],
      [ HINT, { threadId: help_id } ],
      [ RESOLVE, { threadId: thread_id, resolved: true } ]
    ].each do |mutation, input|
      body = graphql(mutation, variables: { input: })
      assert_equal "NOT_FOUND", body.dig("errors", 0, "extensions", "code"), mutation.lines.first
    end

    assert_equal "Hola. Me llamo Ana.", DiaryEntry.find_by!(public_id: entry["id"]).body
    assert_not DiaryThread.find_by!(public_id: thread_id).resolved?
  end

  test "a missing id is NOT_FOUND, not INTERNAL" do
    body = graphql(UPDATE, variables: { input: { id: "999999", body: "x" } })

    assert_equal "NOT_FOUND", body.dig("errors", 0, "extensions", "code")
    assert_equal "No such diary entry.", body.dig("errors", 0, "message")
  end

  UUID = /\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/

  test "every id in a response is a random UUID, never the internal id" do
    entry = create_entry
    reviewed = mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "Hola. Me llamo Ana.")["entry"]
    thread = reviewed["threads"].first
    comment = thread["comments"].first

    record = DiaryEntry.find_by!(public_id: entry["id"])
    [
      [ entry["id"], record ],
      [ thread["id"], record.threads.first ],
      [ comment["id"], DiaryComment.find_by!(diary_thread: record.threads.first) ]
    ].each do |id, model|
      assert_match UUID, id
      assert_equal model.public_id, id
      assert_not_equal model.id.to_s, id
    end
    assert_equal entry["id"], graphql(DELETE, variables: { input: { id: entry["id"] } }).dig("data", "deleteDiaryEntry", "deletedId")
  end

  test "an internal id does not find a record" do
    entry = create_entry
    thread_id = mutate(HELP, "startDiaryHelpThread", entryId: entry["id"], question: "How do I say hi?").dig("thread", "id")
    internal_entry_id = DiaryEntry.find_by!(public_id: entry["id"]).id.to_s
    internal_thread_id = DiaryThread.find_by!(public_id: thread_id).id.to_s

    assert_nil graphql(SHOW, variables: { id: internal_entry_id }).dig("data", "diaryEntry")
    [
      [ UPDATE, { id: internal_entry_id, body: "x" } ],
      [ DELETE, { id: internal_entry_id } ],
      [ HELP, { entryId: internal_entry_id, question: "q" } ],
      [ HINT, { threadId: internal_thread_id } ]
    ].each do |mutation, input|
      assert_equal "NOT_FOUND", graphql(mutation, variables: { input: }).dig("errors", 0, "extensions", "code"), mutation.lines.first
    end
    assert DiaryEntry.exists?(public_id: entry["id"])
  end

  test "a malformed or unknown id is null or NOT_FOUND, not INTERNAL" do
    create_entry
    [ "123", "someone-elses", "", "#{SecureRandom.uuid}x", SecureRandom.uuid ].each do |id|
      show = graphql(SHOW, variables: { id: })
      assert_nil show["errors"], id
      assert_nil show.dig("data", "diaryEntry"), id
      [
        [ UPDATE, { id:, body: "x" } ],
        [ DELETE, { id: } ],
        [ REVIEW, { id:, body: "x" } ],
        [ HELP, { entryId: id, question: "q" } ],
        [ REPLY, { threadId: id, body: "q" } ],
        [ HINT, { threadId: id } ],
        [ RESOLVE, { threadId: id, resolved: true } ]
      ].each do |mutation, input|
        body = graphql(mutation, variables: { input: })
        assert_equal "NOT_FOUND", body.dig("errors", 0, "extensions", "code"), "#{id.inspect} #{mutation.lines.first}"
      end
    end
  end

  test "an id is found whatever its letter case" do
    entry = create_entry

    assert_equal entry["id"], graphql(SHOW, variables: { id: entry["id"].upcase }).dig("data", "diaryEntry", "id")
  end

  test "a review saves the body and opens a located thread per sentence plus entry notes" do
    entry = create_entry
    body = "Ayer fui al cine.  Me gustó mucho! ¿Y tú?"

    reviewed = mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body:)

    assert_empty reviewed["errors"]
    result = reviewed["entry"]
    assert_equal body, result["body"]
    assert_equal body, result["reviewedBody"]
    assert_not_nil result["reviewedAt"]
    sentences = result["threads"].select { |thread| thread["kind"] == "SENTENCE" }
    assert_equal [ "Ayer fui al cine.", "Me gustó mucho!", "¿Y tú?" ], sentences.pluck("sentence")
    assert_equal %w[WRONG IMPROVABLE CORRECT], sentences.pluck("verdict")
    sentences.each do |thread|
      assert_equal thread["sentence"], body[thread["startsAt"], thread["length"]]
      assert thread["current"]
      assert_equal [ "TUTOR" ], thread["comments"].pluck("author")
    end
    note = result["threads"].find { |thread| thread["kind"] == "ENTRY" }
    assert_equal "Fake note", note["title"]
    assert_nil note["verdict"]
  end

  test "spans count code points in Japanese" do
    entry = create_entry(language: "JA", notesLanguage: "EN")
    body = "😀今日は晴れ。公園に行きました！"

    threads = mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body:).dig("entry", "threads")

    assert_equal [ [ 0, 7 ], [ 7, 9 ] ], threads.first(2).map { |thread| [ thread["startsAt"], thread["length"] ] }
  end

  test "a second review supersedes the sentence threads and sends the tutor the context rule's threads" do
    tutor = RecordingTutor.new
    Diary.tutor = tutor
    entry = create_entry
    first = mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "Uno. Dos.")["entry"]
    one, two, note = first["threads"]
    mutate(RESOLVE, "resolveDiaryThread", threadId: one["id"], resolved: true)
    mutate(REPLY, "replyToDiaryThread", threadId: two["id"], body: "Why?")

    second = mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "Uno. Dos. Tres.")["entry"]

    old = second["threads"].select { |thread| [ one["id"], two["id"] ].include?(thread["id"]) }
    assert_equal [ false, false ], old.pluck("current")
    assert_equal [ true, false ], old.pluck("resolved"), "superseded is not resolved"
    assert_equal 3, second["threads"].count { |thread| thread["kind"] == "SENTENCE" && thread["current"] }
    assert_equal note["id"], second["threads"].find { |thread| thread["kind"] == "ENTRY" }["id"]

    context = tutor.reviews.last.threads
    assert_equal 2, tutor.reviews.last.round
    assert_equal [ "Uno.", "Dos.", nil ], context.map(&:sentence)
    assert_equal [ true, false, false ], context.map(&:resolved)
    assert_equal %w[Why? Fake], context[1].comments.last(2).map { |comment| comment.body.split.first }
  end

  test "resolve and unresolve a thread" do
    entry = create_entry
    thread_id = mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "Hola.").dig("entry", "threads", 0, "id")

    assert mutate(RESOLVE, "resolveDiaryThread", threadId: thread_id, resolved: true).dig("thread", "resolved")
    assert_not mutate(RESOLVE, "resolveDiaryThread", threadId: thread_id, resolved: false).dig("thread", "resolved")
  end

  test "a help thread starts at hint level 1 and each requested hint goes one further" do
    entry = create_entry
    started = mutate(HELP, "startDiaryHelpThread", entryId: entry["id"], question: "How do I say I went hiking?")

    thread = started["thread"]
    assert_equal "HELP", thread["kind"]
    assert_equal "How do I say I went hiking?", thread["sentence"]
    assert_equal 1, thread["hintLevel"]
    assert_equal [ "TUTOR" ], thread["comments"].pluck("author")
    assert_match(/\AFake hint 1 /, thread.dig("comments", 0, "body"))

    hinted = mutate(HINT, "requestDiaryHint", threadId: thread["id"])["thread"]
    assert_equal 2, hinted["hintLevel"]
    assert_match(/\AFake hint 2 /, hinted["comments"].last["body"])

    replied = mutate(REPLY, "replyToDiaryThread", threadId: thread["id"], body: "Which verb?")["thread"]
    assert_equal %w[TUTOR TUTOR LEARNER TUTOR], replied["comments"].pluck("author")
    assert_equal 2, replied["hintLevel"], "a reply is not a general hint"
  end

  test "a help thread that opens with a question about the learner's meaning is at hint level 0" do
    entry = create_entry(language: "JA", notesLanguage: "EN")
    thread = mutate(HELP, "startDiaryHelpThread", entryId: entry["id"], question: "How do I say I want a hamburger?")["thread"]

    assert_equal 0, thread["hintLevel"]
    assert_match(/\AFake question: which do you mean\?/, thread.dig("comments", 0, "body"))

    hinted = mutate(HINT, "requestDiaryHint", threadId: thread["id"])["thread"]
    assert_equal 1, hinted["hintLevel"]
    assert_match(/\AFake hint 1 \(broad hint\)/, hinted["comments"].last["body"])
  end

  test "hints are only for help threads" do
    entry = create_entry
    thread_id = mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "Hola.").dig("entry", "threads", 0, "id")

    assert_equal "NOT_FOUND", graphql(HINT, variables: { input: { threadId: thread_id } }).dig("errors", 0, "extensions", "code")
  end

  test "suggests three topics" do
    topics = mutate(TOPICS, "suggestDiaryTopics", language: "ES", notesLanguage: "EN")["topics"]

    assert_equal 3, topics.size
    assert topics.all? { |topic| topic["prompt"].present? && topic["gloss"].present? }
  end

  test "suggests follow-ups to the text already written" do
    topics = mutate(TOPICS, "suggestDiaryTopics", language: "JA", notesLanguage: "EN",
      body: "今日はハンバーガーが食べたかった")["topics"]

    assert_equal 3, topics.size
    assert topics.all? { |topic| topic["prompt"].start_with?("Fake follow-up") }
  end

  test "validation failures come back as typed errors and change nothing" do
    entry = create_entry

    assert_equal "EMPTY_INPUT", mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "  ").dig("errors", 0, "code")
    assert_equal "INPUT_TOO_LONG",
      mutate(UPDATE, "updateDiaryEntry", id: entry["id"], body: "a" * 10_001).dig("errors", 0, "code")
    assert_equal "EMPTY_INPUT",
      mutate(HELP, "startDiaryHelpThread", entryId: entry["id"], question: " ").dig("errors", 0, "code")
    assert_equal "INPUT_TOO_LONG",
      mutate(HELP, "startDiaryHelpThread", entryId: entry["id"], question: "q" * 2_001).dig("errors", 0, "code")
    assert_equal "", DiaryEntry.find_by!(public_id: entry["id"]).body
    assert_empty DiaryThread.where(diary_entry: DiaryEntry.find_by!(public_id: entry["id"]))
  end

  test "a body over the review limit is INPUT_TOO_LONG and saves nothing" do
    entry = create_entry
    mutate(UPDATE, "updateDiaryEntry", id: entry["id"], body: "a" * 2_001)

    result = mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "b" * 2_001)

    assert_nil result["entry"]
    assert_equal "INPUT_TOO_LONG", result.dig("errors", 0, "code")
    assert_match(/\AFeedback works on up to 2,000 characters at a time/, result.dig("errors", 0, "message"))
    assert_equal [ "a" * 2_001, 0 ], DiaryEntry.find_by!(public_id: entry["id"]).then { |record| [ record.body, record.review_count ] }
  end

  test "an entry deleted while the tutor reviews it is NOT_FOUND, not INTERNAL" do
    Diary.tutor = DeletingTutor.new
    entry = create_entry

    body = graphql(REVIEW, variables: { input: { id: entry["id"], body: "Hola." } })

    assert_equal "NOT_FOUND", body.dig("errors", 0, "extensions", "code")
    assert_equal "No such diary entry.", body.dig("errors", 0, "message")
    assert_not DiaryEntry.exists?(public_id: entry["id"])
  end

  test "a tutor failure is a TranslateError and saves nothing" do
    Diary.tutor = RaisingTutor.new(
      Translation::Error.new(Translation::ErrorCode::UPSTREAM_OVERLOADED, "Claude is temporarily overloaded.")
    )
    entry = create_entry

    result = mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "Hola.")

    assert_nil result["entry"]
    assert_equal [ { "code" => "UPSTREAM_OVERLOADED", "message" => "Claude is temporarily overloaded.",
                     "retryable" => true, "retryAfterSeconds" => nil } ], result["errors"]
    assert_equal "", DiaryEntry.find_by!(public_id: entry["id"]).body
  end

  test "tutor calls count against the translation rate limit" do
    original = Rails.cache
    Rails.cache = ActiveSupport::Cache::MemoryStore.new
    travel_to(Time.current.beginning_of_minute + 1.minute + 1.second)
    input = { language: "ES", notesLanguage: "EN" }
    10.times { assert_empty mutate(TOPICS, "suggestDiaryTopics", **input)["errors"] }

    result = mutate(TOPICS, "suggestDiaryTopics", **input)

    assert_empty result["topics"]
    assert_equal "RATE_LIMITED", result.dig("errors", 0, "code")
    assert result.dig("errors", 0, "retryable")
  ensure
    Rails.cache = original
  end

  test "one request can make only one tutor call" do
    entry = create_entry
    input = "{ id: \"#{entry['id']}\", body: \"Hola.\" }"

    body = graphql("mutation { a: reviewDiaryEntry(input: #{input}) { errors { code } } " \
                   "b: reviewDiaryEntry(input: #{input}) { errors { code } } }")

    assert_match(/complexity/, body.dig("errors", 0, "message"))
    assert_equal 0, DiaryEntry.find_by!(public_id: entry["id"]).review_count
  end

  test "the full selection of a tutor mutation and of the list stays inside the complexity and depth limits" do
    entry = create_entry
    assert_nil graphql(REVIEW, variables: { input: { id: entry["id"], body: "Hola." } })["errors"]
    assert_nil graphql(LIST)["errors"]
  end

  test "the list loads threads and comments without a query per entry" do
    3.times do
      entry = create_entry
      mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "Uno. Dos.")
    end

    queries = count_queries { graphql(LIST) }
    3.times do
      entry = create_entry
      mutate(REVIEW, "reviewDiaryEntry", id: entry["id"], body: "Uno. Dos.")
    end

    assert_equal queries, count_queries { graphql(LIST) }
  end

  private

  def create_entry(language: "ES", notesLanguage: "EN") # rubocop:disable Naming/VariableName
    mutate(CREATE, "createDiaryEntry", language:, notesLanguage:)["entry"]
  end

  def mutate(document, field, **input)
    body = graphql(document, variables: { input: })
    assert_nil body["errors"], body["errors"].to_json
    body.dig("data", field)
  end

  def count_queries(&block)
    count = 0
    counter = ->(*, payload) { count += 1 unless payload[:name] == "SCHEMA" || payload[:sql].start_with?("BEGIN", "COMMIT") }
    ActiveSupport::Notifications.subscribed(counter, "sql.active_record", &block)
    count
  end
end
