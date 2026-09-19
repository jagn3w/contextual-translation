# typed: strict
# frozen_string_literal: true

# Session-cookie authentication against access codes (design D4.2). The session stores which
# code was used and when; every request re-checks the code, so revoking or expiring it takes
# effect immediately.
module Authentication
  extend T::Sig
  extend T::Helpers
  extend ActiveSupport::Concern

  requires_ancestor { ActionController::API }

  SESSION_TTL = T.let(12.hours, ActiveSupport::Duration)

  # A signed-in browser session: the code it was opened with, plus a random key identifying
  # this device's session (the key for per-session rate limits, D3.4).
  class Current < T::Struct
    const :access_code, AccessCode
    const :session_key, String
    const :authenticated_at, ActiveSupport::TimeWithZone
  end

  private

  sig { returns(T.nilable(Current)) }
  def current_session
    return @current_session if defined?(@current_session)

    @current_session = T.let(load_current_session, T.nilable(Current))
  end

  sig { params(access_code: AccessCode).void }
  def start_session(access_code)
    reset_session # new session id and contents: no session fixation
    authenticated_at = Time.current
    session[:access_code_id] = access_code.id
    session[:authenticated_at] = authenticated_at.to_i
    session[:session_key] = SecureRandom.hex(16)
    @current_session = Current.new(access_code:, session_key: session[:session_key], authenticated_at:)
  end

  sig { void }
  def end_session
    reset_session
    @current_session = nil
  end

  sig { returns(T.nilable(Current)) }
  def load_current_session
    access_code_id = session[:access_code_id]
    authenticated_at = session[:authenticated_at]
    session_key = session[:session_key]
    return nil unless access_code_id.is_a?(Integer) && authenticated_at.is_a?(Integer) && session_key.is_a?(String)

    # authenticated_at lives inside the encrypted cookie, so the client cannot extend it.
    signed_in_at = Time.zone.at(authenticated_at)
    if signed_in_at < SESSION_TTL.ago
      reset_session
      return nil
    end

    access_code = AccessCode.find_by(id: access_code_id)
    unless access_code&.active?
      reset_session
      return nil
    end

    Current.new(access_code:, session_key:, authenticated_at: signed_in_at)
  end
end
