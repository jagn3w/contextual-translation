# typed: strict
# frozen_string_literal: true

module AccessCodes
  # Parses the EXPIRES_IN shorthand used by the access_codes rake tasks: 30d, 12h, 90m.
  module Duration
    extend T::Sig

    UNITS = T.let({ "d" => :days, "h" => :hours, "m" => :minutes }.freeze, T::Hash[String, Symbol])

    sig { params(text: String).returns(ActiveSupport::Duration) }
    def self.parse(text)
      match = /\A(\d+)([dhm])\z/.match(text.strip)
      raise ArgumentError, "EXPIRES_IN must look like 30d, 12h or 90m (got #{text.inspect})" if match.nil?

      amount = Integer(match[1])
      raise ArgumentError, "EXPIRES_IN must be greater than zero" if amount.zero?

      amount.public_send(UNITS.fetch(T.must(match[2])))
    end
  end
end
