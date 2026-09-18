# frozen_string_literal: true

require "test_helper"

class ViewerQueryTest < ActionDispatch::IntegrationTest
  test "describes the signed-in session" do
    freeze_time
    record, = sign_in(label: "Side project")
    record.update!(expires_at: 30.days.from_now)

    viewer = graphql("{ viewer { accessCodeLabel accessCodeExpiresAt sessionExpiresAt } }").dig("data", "viewer")

    assert_equal "Side project", viewer["accessCodeLabel"]
    assert_equal 30.days.from_now.iso8601, viewer["accessCodeExpiresAt"]
    assert_equal 12.hours.from_now.iso8601, viewer["sessionExpiresAt"]
  end
end
