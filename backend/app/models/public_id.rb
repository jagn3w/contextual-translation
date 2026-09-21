# typed: strict
# frozen_string_literal: true

# Diary records are known to the outside world only by a random UUID, `public_id` (docs/diary.md):
# the bigint primary keys come from sequences shared by every access code, so they would reveal how
# many entries, threads and comments exist. They never leave the database.
module PublicId
  extend T::Sig

  FORMAT = /\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/

  # The id in canonical (lowercase) form, or nil when it is not a UUID at all. Callers look up
  # nothing for nil, so a malformed id behaves like a missing one instead of reaching Postgres,
  # which would raise on the uuid cast.
  sig { params(value: T.untyped).returns(T.nilable(String)) }
  def self.parse(value)
    value.downcase if value.is_a?(String) && FORMAT.match?(value)
  end
end
