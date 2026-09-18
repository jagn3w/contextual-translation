# frozen_string_literal: true

# Throttles and bans that run ahead of the Rails router (design D4.3). Counters live in
# Rails.cache (Solid Cache → Postgres in production), so they are shared across Puma threads and
# survive restarts.
#
# Client IPs come from Rack's `req.ip`, which trusts X-Forwarded-For only from private-range
# proxies — the default we rely on behind CapRover's nginx. Do not set
# config.action_dispatch.trusted_proxies: rack-attack doesn't read it (D4.3).
#
# Paths: rack-attack canonicalizes PATH_INFO with the router's own normalizer before any rule
# runs, so "/api/session/", "//api/session" and "/api//session" match the exact-path rules
# below (verified in rack-attack 6.8; guarded by rack_attack_test.rb).
#
# Translation limits are NOT here: they are per session and per access code, enforced inside the
# translate mutation so they can return a typed RATE_LIMITED error (D3.4).
class Rack::Attack
  SESSION_PATH = "/api/session"

  Rack::Attack.cache.store = Rails.cache

  # Health checks (load balancer / uptime monitor) are never throttled.
  safelist("health-check") { |req| req.path == "/up" }

  # Sign-in: 5 attempts per minute and 20 per hour per IP.
  throttle("sign-in/ip/minute", limit: 5, period: 1.minute) do |req|
    req.ip if req.post? && req.path == SESSION_PATH
  end
  throttle("sign-in/ip/hour", limit: 20, period: 1.hour) do |req|
    req.ip if req.post? && req.path == SESSION_PATH
  end

  # IPs with 10 failed codes in 10 minutes can't sign in for 10 minutes (see LoginBan).
  blocklist("sign-in/banned") do |req|
    req.post? && req.path == SESSION_PATH && LoginBan.banned?(req.ip)
  end

  # A coarse cap on the GraphQL endpoint per IP; the real translation limits live in the mutation.
  throttle("graphql/ip/minute", limit: 60, period: 1.minute) do |req|
    req.ip if req.path == "/graphql"
  end

  self.throttled_responder = lambda do |request|
    match_data = request.env["rack.attack.match_data"] || {}
    retry_after = match_data[:period].to_i - (match_data[:epoch_time].to_i % match_data[:period].to_i)
    [
      429,
      { "content-type" => "application/json", "retry-after" => retry_after.to_s },
      [ { error: "rate_limited", retryAfterSeconds: retry_after }.to_json ]
    ]
  end

  self.blocklisted_responder = lambda do |_request|
    [
      429,
      { "content-type" => "application/json", "retry-after" => LoginBan::BAN_TIME.to_i.to_s },
      [ { error: "too_many_failed_attempts", retryAfterSeconds: LoginBan::BAN_TIME.to_i }.to_json ]
    ]
  end
end

ActiveSupport::Notifications.subscribe(/rack_attack/) do |name, _start, _finish, _id, payload|
  request = payload[:request]
  next unless %w[throttle.rack_attack blocklist.rack_attack].include?(name)

  Rails.logger.warn(
    "Rack::Attack #{request.env['rack.attack.match_type']} #{request.env['rack.attack.matched']} " \
    "ip=#{request.ip} path=#{request.path}"
  )
end
