# frozen_string_literal: true

require "test_helper"
require "rake"

class AccessCodesRakeTest < ActiveSupport::TestCase
  setup do
    Rails.application.load_tasks if Rake::Task.tasks.none? { |task| task.name == "access_codes:create" }
  end

  test "create prints a working code once and list never shows it" do
    output = run_task("access_codes:create", "LABEL" => "Side project", "EXPIRES_IN" => "30d")
    plaintext = output[/ctx(-[0-9A-Z]{4}){6}/]

    assert plaintext, output
    record = AccessCode.authenticate(plaintext)
    assert_equal "Side project", record&.label
    assert_in_delta 30.days.from_now, record&.expires_at, 5.seconds

    listing = run_task("access_codes:list")
    assert_includes listing, "Side project"
    assert_includes listing, "active"
    assert_not_includes listing, plaintext
  end

  test "revoke ends a code" do
    record, plaintext = AccessCode.generate!(label: "x")

    run_task("access_codes:revoke", "ID" => record.id.to_s)

    assert_nil AccessCode.authenticate(plaintext)
    assert_includes run_task("access_codes:list"), "revoked"
  end

  private

  def run_task(name, env = {})
    original = env.keys.index_with { |key| ENV[key] }
    env.each { |key, value| ENV[key] = value }
    task = Rake::Task[name]
    task.reenable
    capture_io { task.invoke }.first
  ensure
    original&.each { |key, value| ENV[key] = value }
  end
end
