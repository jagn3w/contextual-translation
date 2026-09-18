# typed: strict
# frozen_string_literal: true

# CSRF defense for the cookie session (design D4.2). Rails' token-based CSRF protection is not
# used — none of our requests carry a token. Instead:
#   - the cookie is SameSite=Strict, so other sites' requests don't carry it;
#   - state-changing requests must be JSON, which a plain HTML form can't send;
#   - their Origin header must be present and equal the app's own origin.
module RequestOriginCheck
  extend T::Sig
  extend T::Helpers
  extend ActiveSupport::Concern

  requires_ancestor { ActionController::API }

  included do
    T.bind(self, T.class_of(ActionController::API))
    before_action :verify_request_origin
  end

  private

  sig { void }
  def verify_request_origin
    return if request.get? || request.head?

    unless request.media_type == Mime[:json].to_s
      render json: { error: "unsupported_media_type" }, status: :unsupported_media_type
      return
    end

    origin = request.headers["Origin"]
    return if origin.present? && origin == Rails.application.config.x.allowed_origin

    Rails.logger.warn("Rejected request with Origin #{origin.inspect} for #{request.path}")
    render json: { error: "forbidden_origin" }, status: :forbidden
  end
end
