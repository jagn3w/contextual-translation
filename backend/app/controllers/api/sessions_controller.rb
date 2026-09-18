# typed: strict
# frozen_string_literal: true

module Api
  # Exchanges an access code for a session cookie (design D3.1). A REST endpoint rather than a
  # GraphQL mutation so rack-attack can throttle it by path (D4.3).
  class SessionsController < ApplicationController
    MAX_CODE_LENGTH = 100

    sig { void }
    def create
      code = params[:code]
      access_code = AccessCode.authenticate(code) if code.is_a?(String) && code.length <= MAX_CODE_LENGTH

      if access_code
        start_session(access_code)
        head :no_content
      else
        Rails.logger.info("Failed access-code sign-in from #{request.ip}")
        LoginBan.record_failure(request.ip)
        render json: { error: "invalid_code" }, status: :unauthorized
      end
    end

    sig { void }
    def destroy
      end_session
      head :no_content
    end
  end
end
