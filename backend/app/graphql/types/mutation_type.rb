# typed: strict
# frozen_string_literal: true

module Types
  class MutationType < Types::BaseObject
    # Each translate costs one Claude call (seconds, real money); with the schema's
    # max_complexity this allows exactly one per request, so aliases can't batch them.
    field :translate, mutation: Mutations::Translate, complexity: 100
  end
end
