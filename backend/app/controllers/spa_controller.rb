# typed: strict
# frozen_string_literal: true

# Serves the single-page app's index.html for every client-side route (design D1.6). The file is
# the Vite build's entry point, copied to spa/index.html by the Docker build; its hashed assets
# live in public/ and are served by the static file server.
class SpaController < ActionController::API
  extend T::Sig

  INDEX = T.let(Rails.root.join("spa/index.html"), Pathname)

  # A static policy: the built app loads only its own hashed scripts and styles. 'unsafe-inline'
  # styles allow the toast library's injected <style> (no scripts are ever inline).
  CONTENT_SECURITY_POLICY = T.let(
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; "),
    String
  )

  sig { void }
  def show
    unless INDEX.exist?
      render plain: "The frontend isn't built. In development, run `pnpm dev` in frontend/ and open http://localhost:5173.",
        status: :not_found
      return
    end

    response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    send_file INDEX, type: "text/html; charset=utf-8", disposition: "inline"
  end
end
