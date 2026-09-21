# frozen_string_literal: true

require "test_helper"

class DiaryEntryTest < ActiveSupport::TestCase
  setup { @access_code, = AccessCode.generate!(label: "x") }

  test "the preview is the first twelve words, marked when cut" do
    assert_equal "", entry("").preview
    assert_equal "One two three.", entry("One  two\nthree.").preview
    assert_equal "#{(1..12).map(&:to_s).join(' ')}…", entry((1..13).map(&:to_s).join(" ")).preview
    assert_equal (1..12).map(&:to_s).join(" "), entry((1..12).map(&:to_s).join(" ")).preview
  end

  test "Japanese previews are cut by characters" do
    text = "今日は" * 20

    assert_equal "#{text[0, 40]}…", entry(text, language: "ja").preview
    assert_equal "今日は晴れ。", entry("今日は晴れ。", language: "ja").preview
  end

  test "one enormous word is still capped" do
    assert_equal "#{'a' * 100}…", entry("a" * 500).preview
  end

  test "deleting an entry, or its access code, deletes its threads and comments" do
    record = entry("Hola.")
    record.save!
    thread = record.threads.create!(kind: "help", sentence: "q")
    thread.comments.create!(author: "tutor", body: "hint")

    record.destroy!
    assert_equal 0, DiaryThread.count
    assert_equal 0, DiaryComment.count

    other = entry("Hola.")
    other.save!
    other.threads.create!(kind: "help", sentence: "q").comments.create!(author: "tutor", body: "hint")
    @access_code.destroy!
    assert_equal [ 0, 0, 0 ], [ DiaryEntry.count, DiaryThread.count, DiaryComment.count ]
  end

  test "rejects unknown languages, kinds, verdicts and authors" do
    assert_not entry("x", language: "fr").valid?
    record = entry("x")
    record.save!
    assert_not record.threads.build(kind: "other").valid?
    assert_not record.threads.build(kind: "sentence", verdict: "meh").valid?
    assert_not DiaryComment.new(diary_thread: record.threads.create!(kind: "help"), author: "bot", body: "x").valid?
  end

  private

  def entry(body, language: "es")
    DiaryEntry.new(access_code: @access_code, language:, notes_language: "en", body:)
  end
end
