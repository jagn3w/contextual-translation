# frozen_string_literal: true

require "test_helper"

class AccessCodes::DurationTest < ActiveSupport::TestCase
  test "parses days, hours and minutes" do
    assert_equal 30.days, AccessCodes::Duration.parse("30d")
    assert_equal 12.hours, AccessCodes::Duration.parse(" 12h ")
    assert_equal 90.minutes, AccessCodes::Duration.parse("90m")
  end

  test "rejects other formats and zero" do
    [ "30", "d", "1w", "-1d", "1.5h", "" ].each do |text|
      assert_raises(ArgumentError, text) { AccessCodes::Duration.parse(text) }
    end
    assert_raises(ArgumentError) { AccessCodes::Duration.parse("0d") }
  end
end
