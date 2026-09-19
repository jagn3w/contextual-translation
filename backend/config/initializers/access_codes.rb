# typed: strict
# frozen_string_literal: true

# The HMAC key for access-code digests (design D4.1). It is deliberately separate from
# secret_key_base: rotating SECRET_KEY_BASE ends sessions, rotating the pepper invalidates codes.
Rails.application.config.x.access_code_pepper =
  if Rails.env.production?
    ENV.fetch("ACCESS_CODE_PEPPER") # fail loudly at boot when unset
  else
    ENV.fetch("ACCESS_CODE_PEPPER", "development-and-test-only-access-code-pepper")
  end
