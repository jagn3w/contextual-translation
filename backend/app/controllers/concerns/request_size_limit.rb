# typed: strict
# frozen_string_literal: true

# Rejects oversized request bodies before they are parsed (design D3.4). 64 KB comfortably fits
# the largest valid translate request (10,000 characters of text plus 2,000 of context, even in
# 3-byte UTF-8) and keeps abuse cheap to turn away.
module RequestSizeLimit
  extend T::Sig
  extend T::Helpers
  extend ActiveSupport::Concern

  requires_ancestor { ActionController::API }

  MAX_BODY_BYTES = T.let(64.kilobytes, Integer)

  included do
    T.bind(self, T.class_of(ActionController::API))
    before_action :limit_request_size
  end

  private

  sig { void }
  def limit_request_size
    return if request.content_length.to_i <= MAX_BODY_BYTES

    render json: { error: "payload_too_large" }, status: :content_too_large
  end
end
