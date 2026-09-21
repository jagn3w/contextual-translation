# frozen_string_literal: true

require "test_helper"

class DiaryTest < ActiveSupport::TestCase
  test "builds the fake tutor by default and the Claude tutor for TRANSLATOR=claude" do
    assert_instance_of Diary::FakeTutor, Diary.build_tutor({}, production: false)
    assert_instance_of Diary::ClaudeTutor, Diary.build_tutor(
      { "TRANSLATOR" => "claude", "CLAUDE_AUTH" => "api_key", "ANTHROPIC_API_KEY" => "k" }, production: false
    )
  end

  test "rejects an unknown tutor, and anything but claude in production" do
    assert_raises(ArgumentError) { Diary.build_tutor({ "TRANSLATOR" => "gpt" }, production: false) }
    [ {}, { "TRANSLATOR" => "fake" } ].each do |env|
      error = assert_raises(ArgumentError) { Diary.build_tutor(env, production: true) }
      assert_includes error.message, "must be claude in production"
    end
  end

  test "the app's translator and tutor share one Anthropic client, so one WIF refresher per process" do
    saved = ENV.to_h.slice("TRANSLATOR", "ANTHROPIC_API_KEY")
    ENV["TRANSLATOR"] = "claude"
    ENV["ANTHROPIC_API_KEY"] = "k"
    reset_clients

    translator_client = Translation.translator.instance_variable_get(:@caller).client
    tutor_client = Diary.tutor.instance_variable_get(:@caller).client

    assert_same translator_client, tutor_client
    assert_same Claude.client, tutor_client
  ensure
    ENV["TRANSLATOR"] = saved["TRANSLATOR"]
    ENV["ANTHROPIC_API_KEY"] = saved["ANTHROPIC_API_KEY"]
    reset_clients
  end

  private

  def reset_clients
    Translation.translator = nil
    Diary.tutor = nil
    Claude.instance_variable_set(:@client, nil)
  end
end
