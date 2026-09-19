# typed: strict
# frozen_string_literal: true

module Translation
  class Error < StandardError
    extend T::Sig

    sig { returns(ErrorCode) }
    attr_reader :code

    sig { returns(T.nilable(Integer)) }
    attr_reader :retry_after_seconds

    sig { params(code: ErrorCode, message: String, retry_after_seconds: T.nilable(Integer)).void }
    def initialize(code, message, retry_after_seconds: nil)
      super(message)
      @code = code
      @retry_after_seconds = retry_after_seconds
    end
  end
end
