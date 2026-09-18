# frozen_string_literal: true

require "test_helper"

class AccessCodeTest < ActiveSupport::TestCase
  test "generate! returns a grouped Crockford base32 code and stores only its digest" do
    record, plaintext = AccessCode.generate!(label: "Side project")

    assert_match(/\Actx(-[0-9A-HJKMNP-TV-Z]{4}){6}\z/, plaintext)
    assert_not_includes record.code_digest, plaintext.delete("-")
    assert_equal 64, record.code_digest.length
    assert_equal record, AccessCode.authenticate(plaintext)
  end

  test "codes are unique across generations" do
    codes = Array.new(20) { AccessCode.generate!(label: "x").last }

    assert_equal codes.uniq.size, codes.size
  end

  test "authenticate ignores case, whitespace, dashes and the prefix, and decodes look-alikes" do
    _record, plaintext = AccessCode.generate!(label: "x")
    body = plaintext.delete_prefix("ctx-").delete("-")

    assert AccessCode.authenticate(plaintext.downcase)
    assert AccessCode.authenticate(" #{body} ")
    assert AccessCode.authenticate(body.scan(/.{4}/).join(" "))
    assert AccessCode.authenticate(body.tr("0", "O").tr("1", "l"))
  end

  test "authenticate rejects unknown, malformed, revoked and expired codes" do
    record, plaintext = AccessCode.generate!(label: "x")
    expired, expired_plaintext = AccessCode.generate!(label: "old", expires_at: 1.minute.from_now)
    expired.update!(expires_at: 1.second.ago)

    assert_nil AccessCode.authenticate("ctx-0000-0000-0000-0000-0000-0000")
    assert_nil AccessCode.authenticate("")
    assert_nil AccessCode.authenticate("not a code")
    assert_nil AccessCode.authenticate(plaintext + "0")
    assert_nil AccessCode.authenticate(expired_plaintext)

    record.revoke!
    assert_nil AccessCode.authenticate(plaintext)
  end

  test "authenticate records last use" do
    record, plaintext = AccessCode.generate!(label: "x")

    assert_nil record.last_used_at
    AccessCode.authenticate(plaintext)
    assert_not_nil record.reload.last_used_at
  end

  test "the digest depends on the pepper" do
    body = "0123456789ABCDEFGHJKMNPQ"
    original = AccessCode.digest(body)

    with_pepper("a-different-pepper") do
      assert_not_equal original, AccessCode.digest(body)
    end
  end

  test "active? reflects revocation and expiry" do
    record, = AccessCode.generate!(label: "x", expires_at: 1.hour.from_now)

    assert record.active?
    record.update!(expires_at: 1.second.ago)
    assert_not record.active?
    record.update!(expires_at: nil, revoked_at: Time.current)
    assert_not record.active?
  end

  test "revoke! keeps the first revocation time" do
    record, = AccessCode.generate!(label: "x")
    record.revoke!
    first = record.revoked_at

    travel 1.hour do
      record.revoke!
    end

    assert_equal first, record.reload.revoked_at
  end

  private

  def with_pepper(value)
    config = Rails.application.config.x
    original = config.access_code_pepper
    config.access_code_pepper = value
    yield
  ensure
    config.access_code_pepper = original
  end
end
