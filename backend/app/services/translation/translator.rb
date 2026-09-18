# typed: strict
# frozen_string_literal: true

module Translation
  # The seam between the app and whatever produces translations (design D2.4). Implementations
  # raise Translation::Error for anticipated failures.
  module Translator
    extend T::Sig
    extend T::Helpers

    interface!

    sig { abstract.params(request: Request).returns(Result) }
    def translate(request); end
  end
end
