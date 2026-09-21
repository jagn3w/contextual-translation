# typed: strict
# frozen_string_literal: true

module Translation
  # Per-session and per-access-code limits on Claude calls (design D3.4): every translation and
  # every diary tutor call counts against the same budget, so the messages name neither feature.
  # Enforced here rather than in rack-attack so going over returns the typed RATE_LIMITED error.
  # Counters are fixed windows in Rails.cache (Solid Cache in production), shared by every Puma
  # thread.
  #
  # Deliberate choices: if the cache is unavailable (Solid Cache's failsafe returns nil), the
  # limiter fails open — the Anthropic workspace spend limit is the hard backstop. Every counter
  # is incremented before checking, so an attempt refused by the per-code limit still counts
  # against its session.
  class RateLimiter
    extend T::Sig

    class Limit < T::Struct
      const :name, String
      const :count, Integer
      const :period, ActiveSupport::Duration
      const :message, String
    end

    # Per device: a person using the app normally stays far below these.
    SESSION_LIMITS = T.let(
      [
        Limit.new(name: "session-minute", count: 10, period: 1.minute,
          message: "You're sending requests to Claude quickly."),
        Limit.new(name: "session-day", count: 150, period: 1.day,
          message: "This device has reached today's limit of Claude requests.")
      ].freeze,
      T::Array[Limit]
    )
    # Per access code: a backstop, since signing in again starts a fresh session.
    CODE_LIMITS = T.let(
      [
        Limit.new(name: "code-minute", count: 30, period: 1.minute,
          message: "Too many Claude requests on this access code right now."),
        Limit.new(name: "code-day", count: 500, period: 1.day,
          message: "This access code has reached today's limit of Claude requests.")
      ].freeze,
      T::Array[Limit]
    )

    sig { params(cache: ActiveSupport::Cache::Store).void }
    def initialize(cache: Rails.cache)
      @cache = cache
    end

    # Counts one Claude call (a translation or a tutor call); raises RATE_LIMITED if any limit is
    # exceeded.
    sig { params(session: Authentication::Current).void }
    def check!(session)
      counters = SESSION_LIMITS.map { |limit| [ limit, "session:#{session.session_key}" ] } +
        CODE_LIMITS.map { |limit| [ limit, "code:#{session.access_code.id}" ] }
      # Count the attempt against every limit first, then report the first one exceeded.
      exceeded = counters.filter_map do |limit, subject|
        window, retry_after = window_for(limit.period)
        # The "translate:" prefix predates the diary sharing these limits. Renaming it would reset
        # every live counter on deploy, so it stays.
        count = increment("translate:#{limit.name}:#{subject}:#{window}", limit.period)
        [ limit, retry_after ] if count > limit.count
      end
      # Report the longest wait, so a daily cap isn't disguised as a per-minute one.
      limit, retry_after = exceeded.max_by { |_limit, seconds| seconds }
      return if limit.nil?

      raise Error.new(ErrorCode::RATE_LIMITED, limit.message, retry_after_seconds: retry_after)
    end

    private

    # [window index, seconds until it ends]
    sig { params(period: ActiveSupport::Duration).returns([ Integer, Integer ]) }
    def window_for(period)
      now = Time.current.to_i
      [ now / period.to_i, period.to_i - (now % period.to_i) ]
    end

    sig { params(key: String, period: ActiveSupport::Duration).returns(Integer) }
    def increment(key, period)
      @cache.increment(key, 1, expires_in: period + 1.minute) || 0
    end
  end
end
