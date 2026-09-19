# frozen_string_literal: true

# Build the translator at boot in production so a misconfiguration (missing WIF ids, an
# ANTHROPIC_API_KEY that would override WIF, an unknown TRANSLATOR) stops the app from starting
# instead of failing on the first request (design D5.2).
Rails.application.config.after_initialize do
  Translation.translator if Rails.env.production?
end
