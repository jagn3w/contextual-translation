# typed: strict
# frozen_string_literal: true

# Bans an IP from signing in after repeated failed access codes (design D4.3). Failures are only
# known after the controller checks the code, so the controller records them here and
# rack-attack's blocklist consults the ban before the next request reaches Rails.
#
# The ban is short on purpose: everyone sharing a code may be behind one network, and one mistyped
# code must not lock everyone out for long.
module LoginBan
  extend T::Sig

  MAX_FAILURES = 10
  FIND_TIME = T.let(10.minutes, ActiveSupport::Duration)
  BAN_TIME = T.let(10.minutes, ActiveSupport::Duration)

  sig { params(ip: String).void }
  def self.record_failure(ip)
    Rack::Attack::Fail2Ban.filter(discriminator(ip), maxretry: MAX_FAILURES, findtime: FIND_TIME, bantime: BAN_TIME) { true }
  end

  sig { params(ip: String).returns(T::Boolean) }
  def self.banned?(ip)
    !!Rack::Attack::Fail2Ban.banned?(discriminator(ip))
  end

  sig { params(ip: String).returns(String) }
  def self.discriminator(ip)
    "login-failures:#{ip}"
  end
end
