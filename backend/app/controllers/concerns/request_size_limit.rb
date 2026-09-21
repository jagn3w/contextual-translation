# typed: strict
# frozen_string_literal: true

# Rejects oversized request bodies before they are parsed (design D3.4). 64 KB comfortably fits
# the largest valid translate request (10,000 characters of text plus 2,000 of context, even in
# 3-byte UTF-8) and keeps abuse cheap to turn away.
#
# The size comes from Content-Length, so a body sent without one (Transfer-Encoding: chunked) is
# refused with 411 Length Required instead of measured: Rails' own `request.content_length` reads
# the whole chunked body into memory to count it, which is the cost this check exists to avoid.
# Nothing legitimate is lost. Browsers' fetch sends Content-Length for string bodies, which is all
# the SPA sends, and so do curl and bin/smoke. (Puma itself buffers a chunked body and turns it
# into a Content-Length request before Rails sees it, so in production this is a second line.)
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
    if request.has_header?("HTTP_TRANSFER_ENCODING")
      render json: { error: "length_required" }, status: :length_required
    elsif request.get_header("CONTENT_LENGTH").to_i > MAX_BODY_BYTES
      render json: { error: "payload_too_large" }, status: :content_too_large
    end
  end
end
